/**
 * Pi-family subagent compatibility: live host catalogs are presented to an
 * OpenCode plugin as canonical `task`, then calls/history are translated back
 * without changing call ids or unrelated tools.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt, translateToolChoice, translateTools } from "../packages/pi-bridge/src/translate/context.ts"
import { runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"
import {
  buildPiSubagentVocabulary,
  buildPiTerminalResultVocabulary,
  buildPiToolInputVocabulary,
  canonicalSubagentDescription,
  canonicalSubagentSchema,
  translateCanonicalSubagentCall,
  translateCanonicalToolCall,
  translateHostSubagentCall,
} from "../packages/pi-bridge/src/translate/subagent.ts"

const toSchema = (tool: { parameters: unknown }) => tool.parameters as Record<string, unknown>

const OMP_TASK = {
  name: "task",
  description: `Run one subagent.

# Available Agents
### task
General-purpose worker.
### scout (READ-ONLY)
Fast codebase research.
### reviewer
Review changes.`,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      agent: { type: "string", default: "task" },
      task: { type: "string" },
    },
    required: ["task"],
  },
}

const PI_SUBAGENT = {
  name: "subagent",
  description: "Delegate tasks to specialized subagents with isolated context.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string" },
      task: { type: "string" },
      tasks: { type: "array" },
      chain: { type: "array" },
    },
  },
}

class FakeAssistantMessageEventStream {
  events: unknown[] = []
  push(event: unknown) {
    this.events.push(event)
  }
  end() {}
  fail() {}
  async result() {
    return (this.events.find((event: never) => (event as { type: string }).type === "done") as { message: unknown } | undefined)?.message
  }
  async *[Symbol.asyncIterator]() {
    yield* this.events as never
  }
}

const MODEL = {
  id: "acme-large",
  api: "acme-bridge",
  provider: "acme",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as never

async function* v3Parts(parts: unknown[]) {
  for (const part of parts) yield part
}

describe("Pi-family subagent vocabulary", () => {
  test("omp exposes its same-name/different-schema task as canonical OpenCode task", () => {
    const vocabulary = buildPiSubagentVocabulary([OMP_TASK, { name: "hub" }] as never, toSchema as never, ompProfile())
    expect(vocabulary).toBeDefined()
    expect(vocabulary?.hostToolName).toBe("task")
    expect(vocabulary?.availableAgents).toEqual(["task", "scout", "reviewer"])
    expect(vocabulary?.agentCatalogComplete).toBe(true)
    expect(vocabulary?.coordinationToolName).toBe("hub")
    expect(canonicalSubagentDescription(vocabulary!)).toContain(
      "built-in hub tool for status and follow-up; it is not an MCP server",
    )
    expect(canonicalSubagentDescription(vocabulary!)).toContain("never call task to poll or resume")

    const schema = canonicalSubagentSchema(vocabulary!)
    expect(schema.required).toEqual(["description", "prompt", "subagent_type"])
    expect((schema.properties as Record<string, { enum: string[] }>).subagent_type.enum).toEqual([
      "task",
      "scout",
      "reviewer",
      "general",
      "explore",
    ])

    const tools = translateTools([OMP_TASK] as never, toSchema as never, vocabulary)
    expect(tools).toHaveLength(1)
    expect(tools?.[0]).toMatchObject({ name: "task", inputSchema: schema })
  })

  test("omp terminal result support activates only for a live yield tool", () => {
    expect(buildPiTerminalResultVocabulary([OMP_TASK] as never, ompProfile())).toBeUndefined()
    expect(
      buildPiTerminalResultVocabulary([OMP_TASK, { name: "yield" }] as never, ompProfile()),
    ).toEqual({
      hostToolName: "yield",
      input: { type: "result", result: {} },
    })
    expect(buildPiTerminalResultVocabulary([{ name: "yield" }] as never, piProfile())).toBeUndefined()
  })

  test("omp maps generic agents through its live spawn policy and explore to scout", () => {
    const vocabulary = buildPiSubagentVocabulary([OMP_TASK] as never, toSchema as never, ompProfile())!
    expect(
      translateCanonicalSubagentCall(
        "task",
        { description: "Investigate", prompt: "Trace auth", subagent_type: "general" },
        vocabulary,
      ),
    ).toEqual({ toolName: "task", input: { task: "Trace auth", outputSchema: true } })
    expect(
      translateCanonicalSubagentCall(
        "task",
        { description: "Investigate", prompt: "Trace auth", subagent_type: "explore" },
        vocabulary,
      ),
    ).toEqual({
      toolName: "task",
      input: { task: "Trace auth", agent: "scout", outputSchema: true },
    })
  })

  test("pi activates only when the optional subagent extension is advertised", () => {
    expect(buildPiSubagentVocabulary([], toSchema as never, piProfile())).toBeUndefined()

    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())
    expect(vocabulary?.hostToolName).toBe("subagent")
    expect(vocabulary?.agentCatalogComplete).toBe(false)
    const tools = translateTools([PI_SUBAGENT] as never, toSchema as never, vocabulary)
    expect(tools?.map(tool => tool.name)).toEqual(["task"])
    expect((tools?.[0]?.inputSchema as { properties: { subagent_type: { enum?: unknown } } }).properties.subagent_type.enum).toBeUndefined()
  })

  test("pi maps canonical generic agents to the reference extension and preserves custom names", () => {
    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())!
    expect(
      translateCanonicalSubagentCall(
        "task",
        { description: "Implement", prompt: "Add the feature", subagent_type: "general" },
        vocabulary,
      ),
    ).toEqual({ toolName: "subagent", input: { task: "Add the feature", agent: "worker" } })
    expect(
      translateCanonicalSubagentCall(
        "task",
        { description: "Research", prompt: "Find the callsite", subagent_type: "explore" },
        vocabulary,
      ),
    ).toEqual({ toolName: "subagent", input: { task: "Find the callsite", agent: "scout" } })
    expect(
      translateCanonicalSubagentCall(
        "task",
        { description: "Audit", prompt: "Review the patch", subagent_type: "reviewer" },
        vocabulary,
      ),
    ).toEqual({ toolName: "subagent", input: { task: "Review the patch", agent: "reviewer" } })
  })

  test("pi collision-safely preserves an independent task tool while exposing subagent as canonical task", () => {
    const existingTask = { name: "task", description: "Unrelated task tracker", parameters: { type: "object" } }
    const tools = [existingTask, PI_SUBAGENT] as never
    const vocabulary = buildPiSubagentVocabulary(tools, toSchema as never, piProfile())!
    expect(vocabulary.hostToolAliases).toEqual({ task: "pi_host_task" })
    expect(translateTools(tools, toSchema as never, vocabulary)?.map(tool => tool.name)).toEqual([
      "pi_host_task",
      "task",
    ])
    expect(translateCanonicalToolCall("pi_host_task", { id: 1 }, vocabulary)).toEqual({
      toolName: "task",
      input: { id: 1 },
    })
    expect(translateCanonicalToolCall("task", { prompt: "Delegate", subagent_type: "general" }, vocabulary)).toEqual({
      toolName: "subagent",
      input: { task: "Delegate", agent: "worker" },
    })
  })

  test("omp translates action to the strict hub op discriminator", () => {
    const tools = [OMP_TASK, { name: "hub" }] as never
    const vocabulary = buildPiSubagentVocabulary(tools, toSchema as never, ompProfile())
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())
    expect(translateCanonicalToolCall("hub", { action: "jobs" }, vocabulary, toolInputs)).toEqual({
      toolName: "hub",
      input: { op: "jobs" },
    })
    expect(translateCanonicalToolCall("hub", { action: "list", op: "jobs" }, vocabulary, toolInputs)).toEqual({
      toolName: "hub",
      input: { op: "jobs" },
    })
  })

  test("already host-shaped calls and unrelated calls remain intact", () => {
    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())!
    expect(translateCanonicalSubagentCall("task", { agent: "reviewer", task: "Review" }, vocabulary)).toEqual({
      toolName: "subagent",
      input: { agent: "reviewer", task: "Review" },
    })
    expect(translateCanonicalSubagentCall("read", { path: "a.ts" }, vocabulary)).toBeUndefined()
  })

  test("named tool choice follows the canonical catalog", () => {
    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())!
    expect(translateToolChoice({ type: "tool", name: "subagent" }, vocabulary)).toEqual({
      type: "tool",
      toolName: "task",
    })
  })
})

describe("subagent call and result round trip", () => {
  test("stored pi calls/results are canonicalized for the next provider turn", () => {
    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())!
    const context = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "subagent", arguments: { agent: "worker", task: "Implement it" } }],
          api: "acme",
          provider: "acme",
          model: "m",
          usage: {},
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "subagent",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 2,
        },
      ],
    }
    expect(translateContextToPrompt(context as never, vocabulary)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "task",
            input: {
              description: "general delegated task",
              prompt: "Implement it",
              subagent_type: "general",
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "task",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ])
  })

  test("host history translation ignores an omp task call that is already canonical", () => {
    const vocabulary = buildPiSubagentVocabulary([OMP_TASK] as never, toSchema as never, ompProfile())!
    expect(
      translateHostSubagentCall(
        "task",
        { description: "Review", prompt: "Review it", subagent_type: "reviewer" },
        vocabulary,
      ),
    ).toBeUndefined()
  })

  test("stream output becomes a host-executable call while preserving its id", async () => {
    const vocabulary = buildPiSubagentVocabulary([PI_SUBAGENT] as never, toSchema as never, piProfile())!
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      vocabulary,
      v3Stream: v3Parts([
        {
          type: "tool-call",
          toolCallId: "call_subagent_1",
          toolName: "task",
          input: JSON.stringify({
            description: "Research code",
            prompt: "Find the relevant implementation",
            subagent_type: "explore",
          }),
        },
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        },
      ]) as never,
      piStream: piStream as never,
    })

    const done = piStream.events.at(-1) as {
      message: { content: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
    }
    expect(done.message.content[0]).toEqual({
      type: "toolCall",
      id: "call_subagent_1",
      name: "subagent",
      arguments: { agent: "scout", task: "Find the relevant implementation" },
    })
  })

  test("stream output translates hub action before OMP validates its strict schema", async () => {
    const tools = [OMP_TASK, { name: "hub" }] as never
    const vocabulary = buildPiSubagentVocabulary(tools, toSchema as never, ompProfile())
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      vocabulary,
      toolInputs,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "call_hub_1", toolName: "hub", input: '{"action":"jobs"}' },
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        },
      ]) as never,
      piStream: piStream as never,
    })

    const done = piStream.events.at(-1) as {
      message: { content: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
    }
    expect(done.message.content[0]).toEqual({
      type: "toolCall",
      id: "call_hub_1",
      name: "hub",
      arguments: { op: "jobs" },
    })
  })

  test("omp subagent final text becomes the host-required terminal yield call", async () => {
    const terminalResult = buildPiTerminalResultVocabulary([{ name: "yield" }] as never, ompProfile())!
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      terminalResult,
      v3Stream: v3Parts([
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Finished investigation." },
        { type: "text-end", id: "answer" },
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "stop", raw: "stop" },
        },
      ]) as never,
      piStream: piStream as never,
    })

    const done = piStream.events.at(-1) as {
      reason: string
      message: { stopReason: string; content: Array<Record<string, unknown>> }
    }
    expect(done.reason).toBe("toolUse")
    expect(done.message.stopReason).toBe("toolUse")
    expect(done.message.content[0]).toEqual({ type: "text", text: "Finished investigation." })
    expect(done.message.content[1]).toMatchObject({
      type: "toolCall",
      name: "yield",
      arguments: { type: "result", result: {} },
    })
  })

  test("terminal yield fallback does not replace real calls or empty stops", async () => {
    const terminalResult = buildPiTerminalResultVocabulary([{ name: "yield" }] as never, ompProfile())!

    for (const parts of [
      [
        { type: "tool-call", toolCallId: "call_1", toolName: "read", input: '{"path":"a.ts"}' },
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        },
      ],
      [
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "stop", raw: "stop" },
        },
      ],
      [
        { type: "text-start", id: "truncated" },
        { type: "text-delta", id: "truncated", delta: "Incomplete" },
        { type: "text-end", id: "truncated" },
        {
          type: "finish",
          usage: { inputTokens: {}, outputTokens: {} },
          finishReason: { unified: "length", raw: "max_tokens" },
        },
      ],
    ]) {
      const piStream = new FakeAssistantMessageEventStream()
      await runV3StreamToPi({
        model: MODEL,
        terminalResult,
        v3Stream: v3Parts(parts) as never,
        piStream: piStream as never,
      })
      const done = piStream.events.at(-1) as { message: { content: Array<{ name?: string }> } }
      expect(done.message.content.some(block => block.name === "yield")).toBe(false)
    }
  })
})
