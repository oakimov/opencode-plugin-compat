import { describe, expect, test } from "bun:test"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"
import type { DshGenerateOptions, DshMessage } from "../packages/dsh-bridge/src/translate/context.ts"
import {
  applyChildNoticeHold,
  cursorChildNoticeContinuation,
  loggedDshMessages,
  loggedDshRouteProvider,
  removeVisibleReplyEchoes,
} from "../packages/dsh-bridge/src/translate/cursor-continuation.ts"
import { installCursorChildNoticeHold } from "../packages/dsh-bridge/src/cursor-child-notice.ts"

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

  test("forwards sessionId as x-opencode-session-id for requesting-session affinity", async () => {
    let headers: Record<string, string> | undefined
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      getLanguageModel: async () => ({
        doStream: async (options: { headers?: Record<string, string> }) => {
          headers = options.headers
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
      model: "default",
      sessionId: "ses_child",
      messages: [msg("user", "user", "hi")],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    }))
    expect(headers).toEqual({ "x-opencode-session-id": "ses_child" })
  })

  test("does not inject session affinity on a zero-tool generate", async () => {
    let headers: Record<string, string> | undefined
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      getLanguageModel: async () => ({
        doStream: async (options: { headers?: Record<string, string> }) => {
          headers = options.headers
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
      model: "default",
      sessionId: "ses_child",
      messages: [msg("user", "user", "hi")],
    }))
    expect(headers).toBeUndefined()
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

describe("cursorChildNoticeContinuation", () => {
  test("skips a later child's send_message after a text-only continue ask", () => {
    expect(cursorChildNoticeContinuation([
      msg("user", "user", "execute tests"),
      continueAsk,
      msg("user", "agent-message", "Agent 206ce0fd sent a message: \nhello ocp self-verify (edited)", {
        senderSessionId: childId,
      }),
    ])?.reason).toBe("agent-message")
  })

  test("skips settled after that text-only stop", () => {
    expect(cursorChildNoticeContinuation([
      continueAsk,
      msg("user", "subagent-settled", "Background subagent 206ce0fd finished and will do no further work unless you send it more.", {
        senderSessionId: childId,
      }),
    ])?.reason).toBe("subagent-settled")
  })

  test("skips relay+settled batched after a text-only stop", () => {
    expect(cursorChildNoticeContinuation([
      continueAsk,
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
      msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId }),
    ])?.reason).toBe("agent-message+subagent-settled")
  })

  test("does not skip helper results claimed after a spawn tool-call", () => {
    expect(cursorChildNoticeContinuation([
      msg("assistant", "model", "spawning", {}, [
        { type: "text", text: "spawning" },
        { type: "tool-call", id: "c1", name: "subagent", arguments: "{}" },
      ]),
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
      msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId }),
    ])).toBeUndefined()
  })

  test("does not skip a human continue", () => {
    expect(cursorChildNoticeContinuation([
      continueAsk,
      msg("user", "user", "continue"),
    ])).toBeUndefined()
  })

  test("does not skip the first user prompt", () => {
    expect(cursorChildNoticeContinuation([
      msg("user", "user", "execute tests"),
    ])).toBeUndefined()
  })

  test("skips helper notices after a completed reply even if the spawn call is still on that assistant", () => {
    expect(cursorChildNoticeContinuation([
      msg("assistant", "model", "Scratch files completed. A helper was started to read hello.txt.", {}, [
        { type: "text", text: "Scratch files completed. A helper was started to read hello.txt." },
        { type: "tool-call", id: "c1", name: "subagent", arguments: "{}" },
      ]),
      {
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "text", text: "started" }],
        source: { kind: "tool", callId: "c1" },
      },
      msg("user", "agent-message", "Agent 206ce0fd sent a message: \nhello.txt contains ocp", {
        senderSessionId: childId,
      }),
    ])?.reason).toBe("agent-message")
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

  test("does not open the model or reprint the reply", async () => {
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerate: cursorChildNoticeContinuation,
      getLanguageModel: () => {
        throw new Error("child-notice skip must not open the model")
      },
    })
    expect(await collect(adapter.stream(skipOptions))).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: "finish", reason: { kind: "stop" }, replayState: { response: { ocpContext: { carry: true } } } },
    ])
  })

  test("removes only display copies before the next real model call", () => {
    const echoed = msg("assistant", "model", continueAsk.content[0].text, {
      replayState: { response: { ocp: "dsh-visible-reply-echo" } },
    })
    const human = msg("user", "user", "continue")
    expect(removeVisibleReplyEchoes([continueAsk, echoed, human])).toEqual([continueAsk, human])
  })

  test("a second child notice is held instead of copied into another step", () => {
    const echoed = msg("assistant", "model", continueAsk.content[0].text, {
      replayState: { response: { ocp: "dsh-visible-reply-echo" } },
    })
    const settled = msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId })
    const first = applyChildNoticeHold([continueAsk], [
      msg("user", "agent-message", "hello", { senderSessionId: childId }),
    ], [])
    expect(first.action).toBe("hold")
    const second = applyChildNoticeHold(
      [continueAsk, echoed],
      [settled],
      first.action === "hold" ? first.held : [],
    )
    expect(second.action).toBe("hold")
    if (second.action === "hold") expect(second.held).toHaveLength(2)
    const human = msg("user", "user", "continue")
    const released = applyChildNoticeHold([continueAsk, echoed], [human], second.action === "hold" ? second.held : [])
    expect(released).toEqual({ action: "enter", release: second.action === "hold" ? second.held : [] })
  })

  test("holds a completed continue prompt so settle does not open a step", () => {
    const answered = msg("assistant", "model", "Reply continue to run steps 8–10.", {}, [
      { type: "reasoning", text: "Step 6 is complete." },
      { type: "text", text: "Reply continue to run steps 8–10." },
    ])
    const settled = msg("user", "subagent-settled", "Background subagent finished.", { senderSessionId: childId })
    expect(loggedDshMessages([
      { type: "assistant/message", data: { message: { content: answered.content, source: answered.source } } },
      { type: "turn/end", data: { reason: { kind: "completed" } } },
    ])).toEqual([answered])
    expect(applyChildNoticeHold([answered], [settled], [])).toEqual({ action: "hold", held: [settled] })
    expect(applyChildNoticeHold([answered], [], [settled])).toEqual({ action: "enter", release: [] })
  })

  test("still opens the model for a human continue", async () => {
    let opened = false
    let assistantReplies = 0
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerate: cursorChildNoticeContinuation,
      prepareOptions: options => ({ ...options, messages: removeVisibleReplyEchoes(options.messages) }),
      getLanguageModel: async () => {
        opened = true
        return {
          doStream: async (options: { prompt: Array<{ role: string }> }) => {
            assistantReplies = options.prompt.filter(message => message.role === "assistant").length
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "text-delta", delta: "ok" })
                  controller.enqueue({ type: "finish", finishReason: "stop" })
                  controller.close()
                },
              }),
            }
          },
        } as never
      },
    })
    const echoed = msg("assistant", "model", continueAsk.content[0].text, {
      replayState: { response: { ocp: "dsh-visible-reply-echo" } },
    })
    const chunks = await collect(adapter.stream({
      provider: "cursor-opencode",
      model: "default",
      messages: [continueAsk, echoed, msg("user", "user", "continue")],
    }))
    expect(opened).toBe(true)
    expect(assistantReplies).toBe(1)
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

  test("opens Cursor to process a tool result even when a helper notice follows it", async () => {
    let prompt: unknown
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      skipGenerate: cursorChildNoticeContinuation,
      getLanguageModel: async () => {
        return {
          doStream: async (options: { prompt: unknown }) => {
            prompt = options.prompt
            return { stream: new ReadableStream({ start(controller) {
              controller.enqueue({ type: "text-delta", delta: "processed" })
              controller.enqueue({ type: "finish", finishReason: "stop" })
              controller.close()
            } }) }
          },
        } as never
      },
    })
    const chunks = await collect(adapter.stream({
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
    expect(prompt).toBeDefined()
    expect(JSON.stringify(prompt)).toContain('"value":"ok"')
    expect(chunks).toContainEqual({ type: "text-delta", index: 0, text: "processed" })
  })
})

describe("Cursor child-notice hold route", () => {
  const reply = msg("assistant", "model", "Reply continue to run steps 8–10.", { provider: "cursor-opencode" }, [
    { type: "reasoning", text: "Step 6 is complete." },
    { type: "text", text: "Reply continue to run steps 8–10." },
  ])
  const notice = msg("user", "agent-message", "Agent 07b4778f sent a message: ", { senderSessionId: childId })
  // Live DSH web order: the agent is created on the profile default, then the
  // session picks Cursor (`model/selection`) before the first request header.
  const selectedCursorEvents = [
    { type: "model/selection", data: { provider: "cursor-opencode", model: "default" } },
    { type: "request/header", data: { header: { config: { provider: "cursor-opencode", model: "default" } } } },
    { type: "assistant/message", data: { message: { content: reply.content, source: reply.source } } },
  ]

  function listen(cursorProviders: ReadonlySet<string>) {
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    installCursorChildNoticeHold((event, registered) => {
      if (event === "agent/pre-step") listener = registered as never
    }, cursorProviders)
    return async (events: readonly unknown[] | Error, messages: readonly unknown[], provider = "deepseek-official") => {
      let nextCalls = 0
      const snapshotEvents = () => {
        if (events instanceof Error) throw events
        return events
      }
      const decision = await listener!({
        agent: { id: "session-a", options: { provider }, session: { snapshotEvents } },
        messages,
      }, async () => {
        nextCalls++
        return { kind: "enter", messages: [...messages] }
      })
      return { decision, nextCalls }
    }
  }

  test("a pending selection after the last header is the route", () => {
    expect(loggedDshRouteProvider(selectedCursorEvents)).toBe("cursor-opencode")
    expect(loggedDshRouteProvider([
      ...selectedCursorEvents,
      { type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-flash" } },
    ])).toBe("deepseek-official")
    expect(loggedDshRouteProvider([{ type: "user/message", data: {} }])).toBeUndefined()
  })

  test("holds the notice when the session selected Cursor after creation on another default", async () => {
    const step = listen(new Set(["cursor-opencode"]))
    expect(await step(selectedCursorEvents, [notice])).toEqual({ decision: { kind: "enter", messages: [] }, nextCalls: 0 })
  })

  test("releases held notices on the next real step after the session leaves Cursor", async () => {
    const step = listen(new Set(["cursor-opencode"]))
    await step(selectedCursorEvents, [notice])
    const human = msg("user", "user", "continue")
    const switched = [
      ...selectedCursorEvents,
      { type: "model/selection", data: { provider: "deepseek-official", model: "deepseek-flash" } },
    ]
    expect(await step(switched, [])).toEqual({ decision: { kind: "enter", messages: [] }, nextCalls: 1 })
    expect(await step(switched, [human])).toEqual({ decision: { kind: "enter", messages: [notice, human] }, nextCalls: 1 })
  })

  test("releases held notices on the next real step when the session log cannot be read", async () => {
    const step = listen(new Set(["cursor-opencode"]))
    await step(selectedCursorEvents, [notice])
    const human = msg("user", "user", "continue")
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
    try {
      expect(await step(new Error("log closed"), [human])).toEqual({ decision: { kind: "enter", messages: [notice, human] }, nextCalls: 1 })
    } finally {
      console.error = original
    }
    expect(errors).toEqual(["dsh-bridge: child-notice hold could not read the session — log closed"])
  })
})
