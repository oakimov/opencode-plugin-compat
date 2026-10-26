import { expect, test } from "bun:test"
import { z } from "zod"
import { adaptLanguageModel, buildVocabulary, fanoutId, policyForHostId, translateCall, translatePrompt } from "../packages/adapter/src/index.ts"
import { kiloProfile, mimoProfile } from "../packages/profile/src/index.ts"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { buildPiSubagentVocabulary, buildPiTerminalResultVocabulary, buildPiToolInputVocabulary, translateCanonicalToolCall, translateHostToolCallInput, translateCanonicalSubagentCall, translateHostSubagentCall } from "../packages/pi-bridge/src/translate/subagent.ts"
import { translateTools as piTools } from "../packages/pi-bridge/src/translate/context.ts"
import { translateTools as dshTools } from "../packages/dsh-bridge/src/translate/context.ts"
import { rewriteProviderToolCall, toolInputsForSchemas } from "../packages/dsh-bridge/src/translate/tools.ts"
import { translateToProviderQuestionInput } from "../packages/dsh-bridge/src/translate/question.ts"

const toSchema = (tool: { parameters: unknown }) => tool.parameters as Record<string, unknown>
const canonicalTask = { description: "Inspect source", prompt: "Inspect source", subagent_type: "general" }
const nativeItem = z.object({ task: z.string(), solutionSpace: z.string(), agent: z.string().optional(), outputSchema: z.literal(true) }).strict()
const nativeTaskSchema = { type: "object", properties: { task: { type: "string" }, solutionSpace: { type: "string" }, agent: { type: "string" }, outputSchema: {} }, required: ["task", "solutionSpace"] }

test("OMP task uses the current single or batch schema and replays the complete task", () => {
  for (const batch of [false, true]) {
    const parameters = batch ? { type: "object", properties: { context: { type: "string" }, tasks: { type: "array", items: nativeTaskSchema } }, required: ["context", "tasks"] } : nativeTaskSchema
    const tool = { name: "task", description: "Delegate", parameters }
    const vocab = buildPiSubagentVocabulary([tool], toSchema, ompProfile())!
    const translated = translateCanonicalSubagentCall("task", canonicalTask, vocab)!
    expect((batch ? z.object({ context: z.string().trim().min(1), tasks: z.array(nativeItem) }).strict() : nativeItem).safeParse(translated.input).success).toBe(true)
    expect(translateHostSubagentCall("task", translated.input, vocab)?.input.prompt).toContain(canonicalTask.prompt)
    if (batch) {
      expect(translated.input.context).toBe(canonicalTask.description)
      expect(translateCanonicalSubagentCall("task", { ...canonicalTask, description: " " }, vocab)?.input.context).toBe(canonicalTask.prompt)
    }
    expect(translated.input).not.toHaveProperty("model")
  }
  const pi = { name: "subagent", description: "Delegate", parameters: { type: "object", properties: { agent: {}, task: {} } } }
  const vocab = buildPiSubagentVocabulary([pi], toSchema, piProfile())!
  expect(translateCanonicalSubagentCall("task", canonicalTask, vocab)?.input).toEqual({ agent: "worker", task: "Inspect source" })
})

test("OMP only completes text automatically for the live unconstrained yield schema", () => {
  for (const [properties, required, auto] of [
    [{ type: { type: "string" }, data: {}, error: { type: "string" } }, [], true],
    [{ type: { type: "string" }, data: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }, [], false],
    [{ key: { enum: [1, 2] }, data: {}, error: { type: "string" } }, ["key"], false],
  ] as const) {
    const tool = { name: "yield", description: "Submit result", parameters: { type: "object", properties, required: [...required], additionalProperties: false } }
    const terminal = buildPiTerminalResultVocabulary([tool], ompProfile(), toSchema)
    expect(!!terminal).toBe(auto)
    if (terminal) expect(terminal.input).toEqual({ type: "result" })
    else expect(piTools([tool], toSchema, undefined, undefined, undefined, terminal)?.[0]?.name).toBe("yield")
  }
})

function stream(parts: unknown[]) {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
}
async function drain(result: { stream: ReadableStream<unknown> }) {
  return Array.fromAsync(result.stream)
}

test("MiMo patch catalog, validation, execution and replay all use their own declared key", async () => {
  const schema = { type: "object", properties: { patch_text: { type: "string" } }, required: ["patch_text"], additionalProperties: false }
  let seen: any
  const model = adaptLanguageModel({ doStream: async (call: any) => {
    seen = call
    return { stream: stream([{ type: "tool-call", toolCallId: "patch", toolName: "apply_patch", input: JSON.stringify({ patchText: "*** Begin Patch\n*** End Patch" }) }]) }
  } }, policyForHostId("mimo"), mimoProfile())
  const parts = await drain(await model.doStream({ tools: [{ name: "apply_patch", inputSchema: schema }], prompt: [{ role: "assistant", content: [{ type: "tool-call", toolName: "apply_patch", toolCallId: "old", input: { patch_text: "old patch" } }] }] }))
  expect(seen.tools[0].inputSchema.required).toEqual(["patchText"])
  expect(seen.prompt[0].content[0].input).toEqual({ patchText: "old patch" })
  const call = parts.find((part: any) => part.type === "tool-call") as any
  expect(z.object({ patch_text: z.string() }).strict().safeParse(JSON.parse(call.input)).success).toBe(true)
})

test("MiMo resumes send first, wait after receipt, and return one canonical task result", async () => {
  const vocab = buildVocabulary(mimoProfile(), ["actor"])!
  const native = translateCall("resume", "task", { ...canonicalTask, task_id: "child" }, vocab)![0]!
  expect(native.input).toEqual({ operation: { action: "send", to_actor_id: "child", content: "Inspect source" } })
  const tools = [{ name: "actor", inputSchema: { type: "object" } }]
  const prompt: any[] = [
    { role: "assistant", content: [{ type: "tool-call", ...native }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: native.toolCallId, toolName: "actor", output: { type: "text", value: '{"inboxID":"receipt"}' } }] },
  ]
  let calls = 0
  const model = adaptLanguageModel({ doStream: async (call: any) => { calls++; return { stream: stream([{ type: "text-delta", id: "t", delta: JSON.stringify(call.prompt) }]) } } }, policyForHostId("mimo"), mimoProfile())
  const parts = await drain(await model.doStream({ tools, prompt }))
  const wait = parts.find((part: any) => part.type === "tool-call") as any
  expect(calls).toBe(0)
  expect(JSON.parse(wait.input)).toEqual({ operation: { action: "wait", actor_id: "child" } })
  expect(parts.filter((part: any) => part.type === "tool-input-start")).toHaveLength(1)
  prompt.push({ role: "assistant", content: [{ ...wait, input: JSON.parse(wait.input) }] }, { role: "tool", content: [{ type: "tool-result", toolCallId: wait.toolCallId, toolName: "actor", output: { type: "text", value: '{"actor_id":"child","result":"finished"}' } }] })
  const replay = translatePrompt(prompt, vocab) as any[]
  expect(replay[0].content[0]).toMatchObject({ toolName: "task", toolCallId: "resume", input: { task_id: "child", prompt: "Inspect source" } })
  expect(replay.at(-1).content[0].output.value).toContain("finished")
  expect(replay.flatMap(message => message.content).filter(part => part.type === "tool-call")).toHaveLength(1)
  expect(replay.flatMap(message => message.content).filter(part => part.type === "tool-result")).toHaveLength(1)
  await drain(await model.doStream({ tools, prompt }))
  expect(calls).toBe(1)
  prompt.splice(2)
  prompt[1].content[0].output = { type: "text", value: '{"error":"receiver not found"}' }
  await drain(await model.doStream({ tools, prompt }))
  expect(calls).toBe(2)
})

test("Kilo retains native plan_exit so its native follow-up owns review", () => {
  const native = { name: "plan_exit", description: "Finish planning", inputSchema: { type: "object", properties: { path: { type: "string" } } } }
  expect(buildVocabulary(kiloProfile(), [native.name])).toBeUndefined()
})

test("Pi/OMP edit catalogs reject empty match text while permitting deletion", () => {
  for (const profile of [piProfile(), ompProfile()]) {
    const tool = { name: "edit", description: "Edit", parameters: { type: "object", properties: { path: {}, edits: {} } } }
    const inputs = buildPiToolInputVocabulary([tool], profile, toSchema)!
    const schema = piTools([tool], toSchema, undefined, inputs)![0]!.inputSchema as any
    expect(schema.properties.oldString.minLength).toBe(1)
    expect(schema.properties.newString).not.toHaveProperty("minLength")
  }
})

test("MiMo collects every successful resumed child in a parallel receipt batch", async () => {
  const vocab = buildVocabulary(mimoProfile(), ["actor"])!
  const native = ["first", "second"].map(id => translateCall(id, "task", { ...canonicalTask, task_id: id }, vocab)![0]!)
  const prompt = [
    { role: "assistant", content: native.map(call => ({ type: "tool-call", ...call })) },
    { role: "tool", content: native.map(call => ({ type: "tool-result", toolCallId: call.toolCallId, toolName: "actor", output: { type: "text", value: '{"inboxID":"receipt"}' } })) },
  ]
  const inner = (_call: unknown) => { throw new Error("Provider must not run before collecting both children") }
  const model = adaptLanguageModel({ doStream: inner, doGenerate: inner }, policyForHostId("mimo"), mimoProfile())
  const call = { tools: [{ name: "actor", inputSchema: {} }], prompt }
  const parts = await drain(await model.doStream(call) as any)
  expect(parts.filter((part: any) => part.type === "tool-call").map((part: any) => JSON.parse(part.input).operation.actor_id)).toEqual(["first", "second"])
  expect(parts.filter((part: any) => part.type === "tool-input-start")).toHaveLength(2)
  expect((await model.doGenerate(call) as any).content).toHaveLength(2)
})

test("clone multi-call step keeps order/ids; resume-wait fold keeps sibling read contiguous", async () => {
  const vocab = buildVocabulary(mimoProfile(), ["read", "actor"])!
  const tools = [
    { name: "read", inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "actor", inputSchema: { type: "object" } },
  ]
  const outbound = [
    { type: "tool-call", toolCallId: "read-a", toolName: "read", input: JSON.stringify({ filePath: "/tmp/a.txt" }) },
    { type: "tool-call", toolCallId: "read-b", toolName: "read", input: JSON.stringify({ filePath: "/tmp/b.txt" }) },
    { type: "tool-call", toolCallId: "task-1", toolName: "task", input: JSON.stringify(canonicalTask) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
  ]
  const model = adaptLanguageModel({
    doStream: async (_options: unknown) => ({ stream: stream(outbound) }),
  }, policyForHostId("mimo"), mimoProfile())
  const parts = await drain(await model.doStream({ tools, prompt: [] }) as any)
  const calls = parts.filter((part: any) => part.type === "tool-call") as Array<{ toolCallId: string; toolName: string; input: string }>
  expect(calls.map((part) => part.toolCallId)).toEqual(["read-a", "read-b", "task-1"])
  expect(calls.map((part) => part.toolName)).toEqual(["read", "read", "actor"])
  expect(parts.filter((part: any) => part.type === "tool-input-start")).toHaveLength(3)
  expect(JSON.parse(calls[0]!.input)).toEqual({ file_path: "/tmp/a.txt" })
  expect(JSON.parse(calls[1]!.input)).toEqual({ file_path: "/tmp/b.txt" })
  expect(JSON.parse(calls[2]!.input)).toMatchObject({ operation: { action: "run" } })

  const resume = translateCall("resume", "task", { ...canonicalTask, task_id: "child" }, vocab)![0]!
  expect(resume.toolCallId).toBe(fanoutId("resume", 0))
  const waitId = fanoutId("resume", 1)
  const history = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: resume.toolCallId, toolName: "actor", input: resume.input },
        { type: "tool-call", toolCallId: waitId, toolName: "actor", input: { operation: { action: "wait", actor_id: "child" } } },
        { type: "tool-call", toolCallId: "read-sib", toolName: "read", input: { file_path: "/tmp/sib.txt" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: resume.toolCallId, toolName: "actor", output: { type: "text", value: '{"inboxID":"receipt"}' } },
        { type: "tool-result", toolCallId: waitId, toolName: "actor", output: { type: "text", value: '{"actor_id":"child","result":"done"}' } },
        { type: "tool-result", toolCallId: "read-sib", toolName: "read", output: { type: "text", value: "sibling" } },
      ],
    },
  ]
  const replay = translatePrompt(history, vocab) as Array<{ role: string; content: Array<Record<string, unknown>> }>
  expect(replay).toHaveLength(2)
  expect(replay[0]!.content.map((part) => part.toolCallId)).toEqual(["resume", "read-sib"])
  expect(replay[0]!.content.map((part) => part.toolName)).toEqual(["task", "read"])
  expect(replay[1]!.content.map((part) => [part.toolCallId, part.toolName])).toEqual([
    ["resume", "task"],
    ["read-sib", "read"],
  ])
  expect((replay[1]!.content[0] as { output?: { value?: string } }).output?.value).toContain("done")
  expect((replay[1]!.content[1] as { output?: { value?: string } }).output?.value).toBe("sibling")
  expect(replay.flatMap((message) => message.content).filter((part) => part.type === "tool-call")).toHaveLength(2)
  expect(replay.flatMap((message) => message.content).filter((part) => part.type === "tool-result")).toHaveLength(2)
})

test("DSH preserves enabled routing, background and timed-question capabilities", () => {
  const tools = [
    { name: "subagent", description: "Delegate", parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, reasoning_effort: { type: "string" }, run_in_background: { type: "boolean" } }, required: ["description", "prompt"] } },
    { name: "ask_user_question", description: "Ask", parameters: { type: "object", properties: { questions: { type: "array" }, timeout: { type: "integer" } }, required: ["questions"] } },
  ]
  const inputs = toolInputsForSchemas(tools)
  const catalog = dshTools(tools, inputs)!
  expect((catalog.find(tool => tool.name === "subagent")!.inputSchema as any).properties).toHaveProperty("reasoning_effort")
  const child = { description: "Inspect", prompt: "Inspect", provider: "acme", model: "fast", reasoning_effort: "low" }
  expect(rewriteProviderToolCall("subagent", child, { toolInputs: inputs }).input).toEqual({ ...child, run_in_background: false })
  expect((catalog.find(tool => tool.name === "question")!.inputSchema as any).properties).toHaveProperty("timeout")
  const question = { questions: [{ question: "Proceed?", header: "Confirm", options: [], multiple: true }] }
  const timed = rewriteProviderToolCall("question", question, { toolInputs: inputs }).input
  expect(timed.timeout).toBe(-1)
  expect(translateToProviderQuestionInput(timed)).toEqual({ ...question, timeout: -1 })
  expect(rewriteProviderToolCall("question", { ...question, timeout: 10 }, { toolInputs: inputs }).input.timeout).toBe(10)
  delete (tools[0]!.parameters.properties as any).run_in_background
  const blocking = toolInputsForSchemas(tools)
  expect(rewriteProviderToolCall("subagent", child, { toolInputs: blocking }).input).not.toHaveProperty("run_in_background")
  expect((dshTools(tools, blocking)!.find(tool => tool.name === "subagent")!.inputSchema as any).properties).not.toHaveProperty("background")
})


test("Pi/OMP grep file filters and OMP enabled service fields survive catalog, call and replay", () => {
  for (const profile of [piProfile(), ompProfile()]) {
    const tool = { name: "grep", description: "Search", parameters: { type: "object", properties: profile.id === "pi" ? { pattern: {}, path: {}, glob: {} } : { pattern: {}, path: {}, case: {} }, required: ["pattern"] } }
    const inputs = buildPiToolInputVocabulary([tool], profile, toSchema)!
    const schema = piTools([tool], toSchema, undefined, inputs)![0]!.inputSchema as any
    expect(schema.properties).toHaveProperty("include")
    const canonical = { pattern: "needle", path: "src", include: "**/*.ts", ...(profile.id === "omp" ? { caseSensitive: false } : {}) }
    const native = translateCanonicalToolCall("grep", canonical, undefined, inputs) as { input: Record<string, unknown> }
    expect(native.input).toEqual(profile.id === "pi" ? { pattern: "needle", path: "src", glob: "**/*.ts" } : { pattern: "needle", path: "src/**/*.ts", case: false })
    expect(translateHostToolCallInput("grep", native.input, inputs)).toEqual(canonical)
  }
  const tool = { name: "bash", description: "Run service", parameters: { type: "object", properties: { command: {}, cwd: {}, timeout: {}, name: { type: "string", maxLength: 48 }, ready: { type: "object", properties: { timeout: { type: "number" } } } } } }
  const inputs = buildPiToolInputVocabulary([tool], ompProfile(), toSchema)!
  const props = (piTools([tool], toSchema, undefined, inputs)![0]!.inputSchema as any).properties
  expect(props.name).toEqual(tool.parameters.properties.name)
  expect(props.ready).toEqual(tool.parameters.properties.ready)
  expect(translateCanonicalToolCall("bash", { command: "server", workdir: "src", name: "service", ready: { timeout: 2 } }, undefined, inputs)).toEqual({ toolName: "bash", input: { command: "server", cwd: "src", name: "service", ready: { timeout: 2 } } })
})
