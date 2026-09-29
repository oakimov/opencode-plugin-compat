import { describe, expect, test } from "bun:test"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"
import { completedPlanMarkdown, cursorPlanToolInputs, prepareCursorPlanOptions, registerCursorPlanEntry, reviewCompletedCursorPlan } from "../packages/dsh-bridge/src/cursor-plan-tools.ts"
import { translateGenerateOptionsToPrompt, translateTools } from "../packages/dsh-bridge/src/translate/context.ts"
import { rewriteProviderToolCall } from "../packages/dsh-bridge/src/translate/tools.ts"

const plan = "# Scratch plan\n\nWrite one scratch marker after approval."
const nativeReview = {
  name: "exit_plan_mode", description: "Review plan", parameters: {
    type: "object", properties: { plan: { type: "string" } }, required: ["plan"],
  },
}

describe("Cursor plan contracts on DSH", () => {
  test("completed prose plans enter native review before a stop can end the turn", async () => {
    const prose = "Submitting complete plan for native review now.## Plan: scratch marker\n\n"
      + "- Write the marker only after approval.\n- Read it back and report the result."
    expect(completedPlanMarkdown(prose)?.startsWith("# Plan: scratch marker")).toBe(true)
    expect(completedPlanMarkdown(prose)?.match(/Plan: scratch marker/g)).toHaveLength(1)
    const input = [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: prose },
      { type: "block-end", index: 0, block: { type: "text", text: prose } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } },
      { type: "finish", reason: { kind: "stop" } },
    ] as const
    async function* chunks() { for (const chunk of input) yield chunk as any }
    const out = []
    for await (const chunk of reviewCompletedCursorPlan(chunks(), () => true)) out.push(chunk)
    const call = out.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call") as any
    expect(call.block.name).toBe("exit_plan_mode")
    expect(JSON.parse(call.block.arguments)).toEqual({ plan: completedPlanMarkdown(prose) })
    expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } })
    expect(out.findIndex(chunk => chunk.type === "usage")).toBeGreaterThan(out.indexOf(call))
    for (const active of [false, true]) {
      const short = []
      for await (const chunk of reviewCompletedCursorPlan(chunks(), () => active)) short.push(chunk)
      expect(short.some(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call")).toBe(!active ? false : true)
    }
    expect(completedPlanMarkdown("# Plan\n\nI need to investigate first.")).toBeUndefined()
    expect(completedPlanMarkdown("# Plan\n\nThe marker should be written only after user approval and read back so its exact contents can be verified.")).toBeDefined()
    async function* alreadyCalled() {
      for (const chunk of input.slice(0, -2)) yield chunk as any
      yield { type: "block-end", index: 1, block: { type: "tool-call", id: "existing", name: "read", arguments: "{}" } } as any
      for (const chunk of input.slice(-2)) yield chunk as any
    }
    const existing = []
    for await (const chunk of reviewCompletedCursorPlan(alreadyCalled(), () => true)) existing.push(chunk)
    expect(existing.filter(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call")).toHaveLength(1)
    async function* repeatedFinish() {
      for (const chunk of input) yield chunk as any
      yield { type: "finish", reason: { kind: "stop" } } as any
    }
    const repeated = []
    for await (const chunk of reviewCompletedCursorPlan(repeatedFinish(), () => true)) repeated.push(chunk)
    expect(repeated.filter(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call")).toHaveLength(1)
  })

  test("entry invokes the calling agent's native plan command and never exits it", async () => {
    let definition: any
    const agent = { session: { requestHeader: () => ({ config: { provider: "cursor-opencode" } }) } }
    const calls: unknown[] = []
    registerCursorPlanEntry({
      tools: {
        get: (name, scope) => {
          if (name !== "exit_plan_mode") return undefined
          expect(scope).toBe(agent)
          return nativeReview
        },
        register: tool => { definition = tool },
      },
      commands: {
        find: () => ({ name: "plan" }),
        execute: async (...args) => { calls.push(args); return { result: { kind: "success" } } },
      },
    }, new Set(["cursor-opencode"]))
    expect(definition.name).toBe("plan_enter")
    const signal = new AbortController().signal
    expect(await definition.execute({}, { agent, signal })).toEqual({ selected: true })
    expect(calls).toEqual([[agent, "/plan", [], signal]])
    await expect(definition.execute({}, { signal: new AbortController().signal })).rejects.toThrow("calling agent")
    await expect(definition.execute({}, { agent, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  test("entry fails closed if review is unavailable or the host refuses the state", async () => {
    let definition: any
    let review: unknown
    let selections = 0
    let command: unknown = { name: "plan" }
    let commandResult: { kind: string; text?: string } = { kind: "error", text: "selection refused" }
    registerCursorPlanEntry({
      tools: { get: () => review, register: tool => { definition = tool } },
      commands: { find: () => command, execute: async () => { selections++; return { result: commandResult } } },
    }, new Set(["cursor-opencode"]))
    const exec = { agent: { session: { requestHeader: () => ({ config: { provider: "cursor-opencode" } }) } }, signal: new AbortController().signal }
    await expect(definition.execute({}, exec)).rejects.toThrow("unavailable")
    expect(selections).toBe(0)
    review = nativeReview
    command = undefined
    await expect(definition.execute({}, exec)).rejects.toThrow("Native plan mode is unavailable")
    command = { name: "plan" }
    await expect(definition.execute({}, exec)).rejects.toThrow("selection refused")
    await expect(definition.execute({}, { ...exec, agent: { ...exec.agent, session: { requestHeader: () => ({ config: { provider: "devin-opencode" } }) } } })).rejects.toThrow("unavailable for this provider")
  })

  test("catalog and streamed calls deliver complete markdown to the native review pipeline", async () => {
    let received: any
    const adapter = new DshLlmAdapter({
      providerName: "fixture",
      toolInputs: cursorPlanToolInputs,
      prepareOptions: prepareCursorPlanOptions,
      getLanguageModel: () => ({
        doStream: async (options: any) => {
          received = options
          return { stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "tool-call", toolCallId: "review-1", toolName: "cursor_plan_stage",
              input: JSON.stringify({ plan_uri: "file:///artifact.md", title: "Scratch plan", content: plan }) })
            controller.enqueue({ type: "finish", finishReason: "tool-calls" })
            controller.close()
          } }) }
        },
      } as never),
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: "fixture", model: "test", sessionId: "main",
      system: "Present the complete plan via exit_plan_mode.",
      messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Plan a scratch change" }] }],
      tools: [nativeReview, { name: "read", description: "Read", parameters: {} }],
    })) chunks.push(chunk)
    expect(received.tools.map((tool: any) => tool.name)).toEqual(["cursor_plan_stage", "read"])
    expect(received.tools[0].inputSchema.required).toEqual(["plan_uri", "title", "content"])
    expect(received.prompt[0].content).toContain("Present the complete plan via cursor_plan_stage.")
    expect(received.prompt[0].content).toContain("cursor_plan_stage is already an advertised tool")
    expect(received.prompt[0].content).toContain("Do not look up a CreatePlan schema")
    const call = chunks.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call") as any
    expect(call.block.name).toBe("exit_plan_mode")
    expect(JSON.parse(call.block.arguments)).toEqual({ plan })
    expect(call.block.id).toBe("review-1")
  })

  test.each([
    [false, "Plan approved — plan mode exited; carry out the plan starting with your next step."],
    [true, "The user chose to keep planning; their feedback: add a readback."],
    [true, "The user dismissed the plan review to speak instead; stay in plan mode."],
    [true, "exit_plan_mode is only available in plan mode"],
  ])("native review status survives continuation (isError=%s)", (isError, text) => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "fixture", model: "test", messages: [
        { role: "assistant", source: { kind: "model" }, content: [{ type: "tool-call", id: "review-1", name: "exit_plan_mode", arguments: JSON.stringify({ plan }) }] },
        { role: "user", source: { kind: "tool", callId: "review-1" }, content: [{ type: "tool-result", toolCallId: "review-1", isError, content: [{ type: "text", text }] }] },
      ],
    }, cursorPlanToolInputs)
    const call = (prompt[0].content as any[])[0]
    expect(call.toolName).toBe("cursor_plan_stage")
    expect(rewriteProviderToolCall(call.toolName, call.input, { toolInputs: cursorPlanToolInputs }).input).toEqual({ plan })
    expect(prompt[1].content).toEqual([{ type: "tool-result", toolCallId: "review-1", toolName: "cursor_plan_stage", output: { type: isError ? "error-text" : "text", value: text } }])
  })

  test("first-class DSH tool messages remain tool results for held Run continuation", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "fixture", model: "test", messages: [
        { role: "assistant", source: { kind: "model" }, content: [{ type: "tool-call", id: "cursor_live_4", name: "read", arguments: "{\"file_path\":\"/tmp/a\"}" }] },
        { role: "tool", source: { kind: "tool", callId: "cursor_live_4" }, toolCallId: "cursor_live_4", isError: false,
          content: [{ type: "text", text: "<path>/tmp/a</path>\n<content>hello</content>" }] },
      ],
    }, cursorPlanToolInputs)
    expect(prompt.at(-1)).toEqual({ role: "tool", content: [{ type: "tool-result",
      toolCallId: "cursor_live_4", toolName: "read", output: { type: "text", value: "<path>/tmp/a</path>\n<content>hello</content>" },
    }] })
    const failed = translateGenerateOptionsToPrompt({ provider: "fixture", model: "test", messages: [
      { role: "assistant", source: { kind: "model" }, content: [{ type: "tool-call", id: "review-1", name: "exit_plan_mode", arguments: JSON.stringify({ plan }) }] },
      { role: "tool", source: { kind: "tool", callId: "review-1" }, toolCallId: "review-1", isError: true,
        content: [{ type: "text", text: "Keep planning" }] },
    ] }, cursorPlanToolInputs)
    expect(failed.at(-1)).toEqual({ role: "tool", content: [{ type: "tool-result",
      toolCallId: "review-1", toolName: "cursor_plan_stage", output: { type: "error-text", value: "Keep planning" },
    }] })
  })

  test("generic providers retain the native plan schema and no capability is invented", () => {
    expect(translateTools([nativeReview])?.[0]).toMatchObject({ name: "exit_plan_mode", inputSchema: nativeReview.parameters })
    expect(translateTools([], cursorPlanToolInputs)).toBeUndefined()
    expect(translateTools([{ name: "read", description: "Read", parameters: {} }], cursorPlanToolInputs)?.map(tool => tool.name)).toEqual(["read"])
  })

  test("a second provider omits the synthetic entry from its advertised catalog", async () => {
    let advertised: string[] = []
    const adapter = new DshLlmAdapter({
      providerName: "other",
      excludeToolNames: new Set(["plan_enter", "cursor_image_save"]),
      getLanguageModel: () => ({ doStream: async (options: any) => {
        advertised = options.tools?.map((tool: any) => tool.name) ?? []
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop" })
          controller.close()
        } }) }
      } } as never),
    })
    for await (const _chunk of adapter.stream({
      provider: "other", model: "default", messages: [], tools: [
        { name: "plan_enter", description: "Synthetic plan entry", parameters: { type: "object", properties: {} } },
        { name: "cursor_image_save", description: "Synthetic Cursor image save", parameters: { type: "object", properties: {} } },
        { name: "exit_plan_mode", description: "Native plan review", parameters: { type: "object", properties: {} } },
      ],
    })) { /* drain */ }
    expect(advertised).toEqual(["exit_plan_mode"])
  })

  test("a second provider drops synthetic calls and their results from replayed history", async () => {
    let received: any
    const adapter = new DshLlmAdapter({
      providerName: "other",
      excludeToolNames: new Set(["plan_enter", "cursor_image_save"]),
      getLanguageModel: () => ({ doStream: async (options: any) => {
        received = options
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop" })
          controller.close()
        } }) }
      } } as never),
    })
    for await (const _chunk of adapter.stream({
      provider: "other", model: "default", messages: [
        { role: "assistant", source: { kind: "model" }, content: [
          { type: "tool-call", id: "entry-1", name: "plan_enter", arguments: "{}" },
          { type: "tool-call", id: "read-1", name: "read", arguments: "{}" },
        ] },
        { role: "tool", source: { kind: "tool", callId: "entry-1" }, toolCallId: "entry-1", content: [{ type: "text", text: "selected" }] },
        { role: "tool", source: { kind: "tool", callId: "read-1" }, toolCallId: "read-1", content: [{ type: "text", text: "ok" }] },
      ],
    } as never)) { /* drain */ }
    const names = received.prompt.flatMap((message: any) =>
      Array.isArray(message.content) ? message.content.map((part: any) => part.toolName).filter(Boolean) : [])
    expect(names).toEqual(["read", "read"])
  })
})
