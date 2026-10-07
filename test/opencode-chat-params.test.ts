import { afterEach, describe, expect, test } from "bun:test"
import { hasChatParamsHook, runChatParamsHook } from "../packages/opencode-loader/src/chat-params.ts"
import { createSessionPlanFlags, piHostAgent, setPiHostPlanReader } from "../packages/pi-bridge/src/host-plan-state.ts"
import { pifyPlanActive, trackPifyPlanState } from "../packages/pi-bridge/src/pi-plan-mode.ts"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"

describe("OpenCode chat.params on hosts that are not OpenCode", () => {
  test("calls the hook the way OpenCode does and returns its options", async () => {
    const seen: unknown[] = []
    const hooks = {
      async "chat.params"(input: { sessionID: string; agent: string; model: { providerID: string } }, output: { options: Record<string, unknown> }) {
        seen.push(input)
        if (input.model.providerID !== "acme") return
        output.options.acmeAgent = input.agent
      },
    }
    expect(hasChatParamsHook(hooks)).toBe(true)
    const options = await runChatParamsHook(hooks, {
      sessionID: "s1",
      agent: "plan",
      providerID: "acme",
      modelID: "acme-large",
      options: { reasoningEffort: "high" },
    })
    expect(options).toEqual({ reasoningEffort: "high", acmeAgent: "plan" })
    expect(seen[0]).toMatchObject({ sessionID: "s1", agent: "plan", model: { id: "acme-large", providerID: "acme" } })
  })

  test("a plugin without the hook keeps its options", async () => {
    expect(hasChatParamsHook({})).toBe(false)
    expect(await runChatParamsHook({}, {
      sessionID: "s1", agent: "build", providerID: "acme", modelID: "m", options: { a: 1 },
    })).toEqual({ a: 1 })
  })

  test("a failing hook fails the request, as in OpenCode", async () => {
    const hooks = { async "chat.params"() { throw new Error("boom") } }
    const failure = await runChatParamsHook(hooks, {
      sessionID: "s1", agent: "build", providerID: "acme", modelID: "m", options: {},
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("boom")
  })
})

describe("Pi-family host plan state as the OpenCode agent", () => {
  afterEach(() => setPiHostPlanReader(undefined))

  test("maps the host's plan mode to plan, everything else to build", async () => {
    expect(await piHostAgent("s1")).toBe("build")
    setPiHostPlanReader(sessionId => sessionId === "planning" ? true : undefined)
    expect(await piHostAgent("planning")).toBe("plan")
    expect(await piHostAgent("other")).toBe("build")
    expect(await piHostAgent(undefined)).toBe("build")
    setPiHostPlanReader(async () => { throw new Error("host gone") })
    expect(await piHostAgent("planning")).toBe("build")
  })

  test("replays the plan-mode extension's session entries; the last one wins", () => {
    const state = (active: boolean) => ({ type: "custom", customType: "plan-mode-state", data: { active } })
    expect(pifyPlanActive([])).toBe(false)
    expect(pifyPlanActive([state(true)])).toBe(true)
    expect(pifyPlanActive([state(true), { type: "message" }, state(false)])).toBe(false)
    expect(pifyPlanActive([state(false), { type: "custom", customType: "other", data: { active: true } }])).toBe(false)
  })

  test("tracks each session's state from pi's context event", () => {
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = []
    const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "context") handlers.push(handler)
    } }
    const read = trackPifyPlanState(pi as never, createSessionPlanFlags())
    const ctx = (sessionId: string, active: boolean) => ({ sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [{ type: "custom", customType: "plan-mode-state", data: { active } }],
    } })
    expect(read("a")).toBeUndefined()
    handlers[0]!({ type: "context", messages: [] }, ctx("a", true))
    handlers[0]!({ type: "context", messages: [] }, ctx("b", false))
    expect(read("a")).toBe(true)
    expect(read("b")).toBe(false)
  })
})

describe("DSH adapter runs chat.params for session turns", () => {
  function adapter(seen: unknown[], providerOptions: unknown[]) {
    return new DshLlmAdapter({
      providerName: "acme",
      providerOptionsKey: "acme",
      chatParams: async input => {
        seen.push(input)
        return { ...input.options, acmeAgent: "plan" }
      },
      getLanguageModel: async () => ({
        doStream: async (options: { providerOptions?: unknown }) => {
          providerOptions.push(options.providerOptions)
          return { stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "finish", finishReason: "stop" })
            controller.close()
          } }) }
        },
      } as never),
    })
  }

  test("a session turn carries the hook's options", async () => {
    const seen: unknown[] = []
    const providerOptions: unknown[] = []
    for await (const _ of adapter(seen, providerOptions).stream({
      provider: "acme", model: "acme-large", sessionId: "ses_1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never)) { /* drain */ }
    expect(seen).toEqual([{ sessionId: "ses_1", modelId: "acme-large", options: {} }])
    expect(providerOptions).toEqual([{ acme: { acmeAgent: "plan" } }])
  })

  test("a lifecycle request is not an agent turn", async () => {
    const seen: unknown[] = []
    const providerOptions: unknown[] = []
    for await (const _ of adapter(seen, providerOptions).stream({
      provider: "acme", model: "acme-large", sessionId: "ses_1", purpose: "title",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never)) { /* drain */ }
    expect(seen).toEqual([])
    expect(providerOptions).toEqual([undefined])
  })
})
