import { describe, expect, test } from "bun:test"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"
import type { DshGenerateOptions, DshMessage } from "../packages/dsh-bridge/src/translate/context.ts"
import { cursorSilentChildNoticeReason } from "../packages/dsh-bridge/src/translate/cursor-continuation.ts"

const childId = "00000000-0000-4000-8000-000000000001"

function msg(
  role: DshMessage["role"],
  kind: string,
  text: string,
  extra: Record<string, unknown> = {},
  content?: DshMessage["content"],
): DshMessage {
  return {
    role,
    content: content ?? [{ type: "text", text }],
    source: { kind, ...extra },
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const continueAsk = msg(
  "assistant",
  "model",
  "Helper read hello.txt. Please send a short message such as continue so I can finish steps 8–10.",
)

describe("DshLlmAdapter prepareCall", () => {
  test("matches DSH LlmAdapter default: model from resolveModel plus stream", async () => {
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      getLanguageModel: () => {
        throw new Error("prepareCall must not open the model")
      },
    })
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: `named-${model}` })
    const prepared = await adapter.prepareCall("cursor-opencode", "composer-2")
    expect(prepared.model).toEqual({ provider: "cursor-opencode", id: "composer-2", name: "named-composer-2" })
    expect(typeof prepared.stream).toBe("function")
  })

  test("keeps the native DSH plan-exit tool in Cursor calls", async () => {
    let receivedTools: Array<{ name: string }> | undefined
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      getLanguageModel: async () => ({
        doStream: async (options: { tools?: Array<{ name: string }> }) => {
          receivedTools = options.tools
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "finish", finishReason: "stop" })
                controller.close()
              },
            }),
          }
        },
      } as never),
    })

    await collect(adapter.stream({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [msg("user", "user", "Draft a plan")],
      tools: [
        {
          name: "exit_plan_mode",
          description: "Present the completed plan for review.",
          parameters: {
            type: "object",
            properties: { plan: { type: "string" } },
            required: ["plan"],
          },
        },
        { name: "read", description: "Read a file", parameters: {} },
      ],
    }))

    expect(receivedTools?.map(tool => tool.name)).toEqual(["exit_plan_mode", "read"])
  })
})

describe("cursorSilentChildNoticeReason", () => {
  test("skips a later child's send_message after a text-only continue ask", () => {
    expect(cursorSilentChildNoticeReason([
      msg("user", "user", "execute tests"),
      continueAsk,
      msg("user", "agent-message", "Agent 206ce0fd sent a message: \nhello ocp self-verify (edited)", {
        senderSessionId: childId,
      }),
    ])).toBe("agent-message")
  })

  test("skips settled after that text-only stop", () => {
    expect(cursorSilentChildNoticeReason([
      continueAsk,
      msg("user", "subagent-settled", "Background subagent 206ce0fd finished and will do no further work unless you send it more.", {
        senderSessionId: childId,
      }),
    ])).toBe("subagent-settled")
  })

  test("skips relay+settled batched after a text-only stop", () => {
    expect(cursorSilentChildNoticeReason([
      continueAsk,
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
      msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId }),
    ])).toBe("agent-message+subagent-settled")
  })

  test("does not skip helper results claimed after a spawn tool-call", () => {
    expect(cursorSilentChildNoticeReason([
      msg("assistant", "model", "spawning", {}, [
        { type: "text", text: "spawning" },
        { type: "tool-call", id: "c1", name: "subagent", arguments: "{}" },
      ]),
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
      msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId }),
    ])).toBeUndefined()
  })

  test("does not skip a human continue", () => {
    expect(cursorSilentChildNoticeReason([
      continueAsk,
      msg("user", "user", "continue"),
    ])).toBeUndefined()
  })

  test("does not skip the first user prompt", () => {
    expect(cursorSilentChildNoticeReason([
      msg("user", "user", "execute tests"),
    ])).toBeUndefined()
  })

  test("does not skip child notices after a tool-call", () => {
    expect(cursorSilentChildNoticeReason([
      msg("assistant", "model", "reading", {}, [
        { type: "text", text: "reading" },
        { type: "tool-call", id: "c1", name: "read", arguments: "{\"file_path\":\"a\"}" },
      ]),
      {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
        source: { kind: "tool", callId: "c1" },
      },
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
    ])).toBeUndefined()
  })
})

describe("DshLlmAdapter silent child-notice stream", () => {
  const skipOptions: DshGenerateOptions = {
    provider: "cursor-opencode",
    model: "default",
    sessionId: "session-parent",
    messages: [
      continueAsk,
      msg("user", "agent-message", "Agent 206ce0fd sent a message: \nhello", { senderSessionId: childId }),
    ],
  }

  test("finishes without opening the model", async () => {
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerateReason: cursorSilentChildNoticeReason,
      getLanguageModel: () => {
        throw new Error("child-notice skip must not open the model")
      },
    })
    expect(await collect(adapter.stream(skipOptions))).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: "finish", reason: { kind: "stop" } },
    ])
  })

  test("still opens the model for a human continue", async () => {
    let opened = false
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerateReason: cursorSilentChildNoticeReason,
      getLanguageModel: async () => {
        opened = true
        return {
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", delta: "ok" })
                controller.enqueue({ type: "finish", finishReason: "stop" })
                controller.close()
              },
            }),
          }),
        } as never
      },
    })
    const chunks = await collect(adapter.stream({
      provider: "cursor-opencode",
      model: "default",
      messages: [continueAsk, msg("user", "user", "continue")],
    }))
    expect(opened).toBe(true)
    expect(chunks.some(chunk => chunk && typeof chunk === "object" && (chunk as { type?: string }).type === "finish")).toBe(true)
  })

  test("does not apply Cursor child-notice suppression to another provider", async () => {
    let opened = false
    const adapter = new DshLlmAdapter({
      providerName: "devin-opencode",
      getLanguageModel: async () => {
        opened = true
        return {
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "finish", finishReason: "stop" })
                controller.close()
              },
            }),
          }),
        } as never
      },
    })
    await collect(adapter.stream({ ...skipOptions, provider: "devin-opencode" }))
    expect(opened).toBe(true)
  })

  test("still opens the model after a tool result plus helper notices", async () => {
    let opened = false
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerateReason: cursorSilentChildNoticeReason,
      getLanguageModel: async () => {
        opened = true
        return {
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", delta: "ok" })
                controller.enqueue({ type: "finish", finishReason: "stop" })
                controller.close()
              },
            }),
          }),
        } as never
      },
    })
    await collect(adapter.stream({
      provider: "cursor-opencode",
      model: "default",
      sessionId: "session-parent",
      messages: [
        msg("assistant", "model", "read", {}, [
          { type: "tool-call", id: "c1", name: "read", arguments: "{\"file_path\":\"a\"}" },
        ]),
        {
          role: "user",
          content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
          source: { kind: "tool", callId: "c1" },
        },
        msg("user", "agent-message", "hello", { senderSessionId: childId }),
      ],
    }))
    expect(opened).toBe(true)
  })
})
