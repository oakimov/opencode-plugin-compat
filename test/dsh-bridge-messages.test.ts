import { describe, expect, test } from "bun:test"
import { translateGenerateOptionsToPrompt, translateTools } from "../packages/dsh-bridge/src/translate/context.ts"
import { collectV3ToDsh } from "../packages/dsh-bridge/src/translate/stream.ts"

function parts(streamParts: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const part of streamParts) controller.enqueue(part as never)
      controller.close()
    },
  })
}

describe("dsh-bridge message translation", () => {
  test("system + user text", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }],
    })
    expect(prompt).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("assistant tool-call then user tool-result becomes V3 tool turn with recovered name", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
          source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
        },
        {
          role: "user",
          content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
          source: { kind: "tool", callId: "c1" },
        },
      ],
    })
    expect(prompt).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: { type: "text", value: "ok" },
        }],
      },
    ])
  })

  test("user text plus tool-result stays two turns, text first", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "note" },
          { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }], isError: true },
        ],
        source: { kind: "user" },
      }],
    })
    expect(prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "note" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "unknown",
          output: { type: "error-text", value: "done" },
        }],
      },
    ])
  })

  test("image blocks become text placeholders, not empty files", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [{
        role: "user",
        content: [{ type: "image", attachment: { mediaType: "image/png", width: 8, height: 4 } }],
        source: { kind: "user" },
      }],
    })
    expect(prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "[image image/png 8x4]" }] },
    ])
  })

  test("tools keep declaration order", () => {
    const tools = translateTools([
      { name: "write", description: "w", parameters: {} },
      { name: "bash", description: "b", parameters: {} },
    ])
    expect(tools?.map(t => t.name)).toEqual(["write", "bash"])
  })
})

describe("dsh-bridge stream translation", () => {
  test("tool-input then tool-call closes the block once with the name", async () => {
    const chunks = await collectV3ToDsh(parts([
      { type: "tool-input-start", id: "c1", toolName: "bash" } as never,
      { type: "tool-input-delta", id: "c1", delta: "{\"a\":1}" } as never,
      { type: "tool-input-end", id: "c1" } as never,
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { a: 1 } } as never,
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2 } } as never,
    ]))
    const ends = chunks.filter(c => c.type === "block-end")
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { type: "tool-call", id: "c1", name: "bash", arguments: "{\"a\":1}" } })
    const types = chunks.map(c => c.type)
    expect(types.at(-2)).toBe("usage")
    expect(types.at(-1)).toBe("finish")
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "tool-calls" } })
  })
})
