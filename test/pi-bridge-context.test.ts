/**
 * `translateContextToPrompt` / `translateTools` / `translateToolChoice` —
 * pure Pi Context → AI-SDK V3 translation. No `@oh-my-pi/pi-ai` runtime
 * import exists in `translate/context.ts` (only `import type`), so these
 * tests need no real or mocked package.
 */
import { describe, expect, test } from "bun:test"
import { translateContextToPrompt, translateToolChoice, translateTools } from "../packages/pi-bridge/src/translate/context.ts"

describe("translateContextToPrompt", () => {
  test("joins systemPrompt entries into one leading system message", () => {
    const prompt = translateContextToPrompt({
      systemPrompt: ["You are helpful.", "Be concise."],
      messages: [],
    } as never)
    expect(prompt[0]).toEqual({ role: "system", content: "You are helpful.\n\nBe concise." })
  })

  test("maps a plain-string user message to a text part", () => {
    const prompt = translateContextToPrompt({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } as never)
    expect(prompt).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
  })

  test("maps user image content to a file part", () => {
    const prompt = translateContextToPrompt({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "YWJj", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    } as never)
    expect(prompt).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "file", data: "YWJj", mediaType: "image/png" },
        ],
      },
    ])
  })

  test("folds a developer message into a system message and drops its images", () => {
    const prompt = translateContextToPrompt({
      messages: [
        {
          role: "developer",
          content: [
            { type: "text", text: "dev note" },
            { type: "image", data: "eHl6", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    } as never)
    expect(prompt).toEqual([{ role: "system", content: "dev note" }])
  })

  test("maps assistant text/thinking/toolCall blocks; drops redactedThinking", () => {
    const prompt = translateContextToPrompt({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "here" },
            { type: "thinking", thinking: "pondering" },
            { type: "redactedThinking", data: "opaque" },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
          ],
          api: "x",
          provider: "acme",
          model: "m",
          usage: {},
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    } as never)
    expect(prompt).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "here" },
          { type: "reasoning", text: "pondering" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
    ])
  })

  test("maps a Pi ToolResultMessage to a trailing role:tool message, preserving toolCallId", () => {
    const prompt = translateContextToPrompt({
      messages: [
        { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 },
      ],
    } as never)
    expect(prompt).toEqual([
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "file contents" } }],
      },
    ])
  })

  test("marks an error tool result as error-text", () => {
    const prompt = translateContextToPrompt({
      messages: [{ role: "toolResult", toolCallId: "id1", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 2 }],
    } as never)
    expect((prompt[0] as { content: Array<{ output: unknown }> }).content[0]!.output).toEqual({ type: "error-text", value: "boom" })
  })
})

describe("translateTools", () => {
  test("returns undefined for no tools", () => {
    expect(translateTools(undefined, t => t.parameters as Record<string, unknown>)).toBeUndefined()
    expect(translateTools([], t => t.parameters as Record<string, unknown>)).toBeUndefined()
  })

  test("maps name/description and delegates schema resolution to the injected fn", () => {
    const tools = translateTools(
      [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } as never],
      t => t.parameters as Record<string, unknown>,
    )
    expect(tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ])
  })
})

describe("translateToolChoice", () => {
  test("auto/undefined map to undefined (V3 default)", () => {
    expect(translateToolChoice(undefined)).toBeUndefined()
    expect(translateToolChoice("auto")).toBeUndefined()
  })
  test("none/any/required map to their V3 shapes", () => {
    expect(translateToolChoice("none")).toEqual({ type: "none" })
    expect(translateToolChoice("any")).toEqual({ type: "required" })
    expect(translateToolChoice("required")).toEqual({ type: "required" })
  })
  test("a named tool choice maps to {type:'tool', toolName}", () => {
    expect(translateToolChoice({ type: "function", name: "read" })).toEqual({ type: "tool", toolName: "read" })
  })
})
