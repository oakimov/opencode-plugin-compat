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
  canonicalToolName,
  translateCanonicalSubagentCall,
  translateCanonicalToolCall,
  translateHostSubagentCall,
  translateHostToolCallInput,
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
    return (this.events.find((event) => (event as { type?: string }).type === "done") as { message: unknown } | undefined)?.message
  }
  async *[Symbol.asyncIterator]() {
    yield* this.events
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
      "explore",
      "general",
      "reviewer",
      "scout",
      "task",
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

  test("omp remaps OpenCode camelCase essential-tool args to host schemas", () => {
    const tools = [
      { name: "read" },
      { name: "write" },
      { name: "edit" },
      { name: "bash" },
      { name: "hub" },
    ] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())
    expect(toolInputs?.write?.inputAliases).toMatchObject({ filePath: "path" })
    expect(toolInputs?.edit?.dropInputKeys).toEqual(["i"])
    expect(translateCanonicalToolCall(
      "write",
      { filePath: "xd://mcp__everything_echo", content: '{"message":"ok"}' },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "write",
      input: { path: "xd://mcp__everything_echo", content: '{"message":"ok"}' },
    })
    expect(translateCanonicalToolCall(
      "edit",
      { filePath: "a.ts", oldString: "a", newString: "b", replaceAll: true },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", old_string: "a", new_string: "b", replace_all: true },
    })
    expect(translateCanonicalToolCall(
      "edit",
      { i: "Edit lines 1 and 3 at file start", input: "[/tmp/lines-1200.txt#9D54]\nPUT 1.=1:" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { input: "[/tmp/lines-1200.txt#9D54]\nPUT 1.=1:" },
    })
    expect(translateCanonicalToolCall(
      "bash",
      { command: "ls", workdir: "/tmp" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "bash",
      input: { command: "ls", cwd: "/tmp" },
    })
    // Absent tools stay unmapped so a disabled write cannot steal aliases.
    expect(buildPiToolInputVocabulary([{ name: "hub" }] as never, ompProfile())?.write).toBeUndefined()
  })

  test("omp replacement aliases follow the live edit mode, and the drop rule does not", () => {
    // omp resolves `edit` per session/model; each mode advertises its own
    // schema. Only `replace` accepts old_string/new_string.
    const replaceMode = [{
      name: "edit",
      parameters: {
        type: "object",
        properties: { path: {}, old_string: {}, new_string: {}, replace_all: {} },
      },
    }] as never
    const hashlineMode = [{
      name: "edit",
      parameters: { type: "object", properties: { input: {} } },
    }] as never
    const schemaOf = ((tool: { parameters: unknown }) => tool.parameters) as never

    const replaceInputs = buildPiToolInputVocabulary(replaceMode, ompProfile(), schemaOf)
    expect(replaceInputs?.edit?.inputAliases).toMatchObject({ oldString: "old_string" })
    expect(translateCanonicalToolCall(
      "edit",
      { filePath: "a.ts", oldString: "a", newString: "b" },
      undefined,
      replaceInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", old_string: "a", new_string: "b" },
    })

    // Under hashline the provider still sees OpenCode edit; calls remap to
    // replace args for the overlay. The live `{input}` schema is not advertised.
    const hashlineInputs = buildPiToolInputVocabulary(hashlineMode, ompProfile(), schemaOf)
    expect(hashlineInputs?.edit?.inputShape).toBe("opencode-edit")
    expect(hashlineInputs?.edit?.inputAliases).toMatchObject({ oldString: "old_string" })
    expect(translateCanonicalToolCall(
      "edit",
      { filePath: "a.ts", oldString: "a", newString: "b" },
      undefined,
      hashlineInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", old_string: "a", new_string: "b" },
    })

    // The harness-only key is mode-independent and still gets stripped.
    expect(hashlineInputs?.edit?.dropInputKeys).toEqual(["i"])
    expect(translateCanonicalToolCall(
      "edit",
      { i: "intent", input: "[a.ts#9D54]\nPUT 1.=1:" },
      undefined,
      hashlineInputs,
    )).toEqual({ toolName: "edit", input: { input: "[a.ts#9D54]\nPUT 1.=1:" } })

    // Without a schema resolver the profile's declared behaviour is preserved.
    expect(buildPiToolInputVocabulary(hashlineMode, ompProfile())?.edit?.inputAliases)
      .toMatchObject({ oldString: "old_string" })
  })

  test("a resolver that cannot confirm replace mode still advertises OpenCode edit", () => {
    const propertylessMode = [{ name: "edit", parameters: { type: "object" } }] as never
    const propertylessInputs = buildPiToolInputVocabulary(
      propertylessMode,
      ompProfile(),
      ((tool: { parameters: unknown }) => tool.parameters) as never,
    )
    expect(propertylessInputs?.edit?.inputShape).toBe("opencode-edit")
    expect(propertylessInputs?.edit?.inputAliases).toMatchObject({ oldString: "old_string" })

    const throwingInputs = buildPiToolInputVocabulary(
      [{ name: "edit" }] as never,
      ompProfile(),
      (() => { throw new Error("schema unavailable") }) as never,
    )
    expect(throwingInputs?.edit?.inputShape).toBe("opencode-edit")
    expect(throwingInputs?.edit?.inputAliases).toMatchObject({ oldString: "old_string" })
  })

  test("coordination aliases merge into a tool's profile entry without dropping its other rules", () => {
    // `hub` carries coordination aliases; give it a profile entry too and the
    // merge must keep that entry's shape/drop rules rather than replace them.
    const profile = ompProfile()
    profile.tools!.toolInputs = {
      ...profile.tools!.toolInputs,
      hub: { inputAliases: { jobId: "job_id" }, dropInputKeys: ["i"] },
    }
    const toolInputs = buildPiToolInputVocabulary([{ name: "hub" }] as never, profile)

    expect(toolInputs?.hub).toMatchObject({
      inputAliases: { jobId: "job_id", action: "op" },
      dropInputKeys: ["i"],
    })
    expect(translateCanonicalToolCall("hub", { action: "jobs", jobId: "7", i: "why" }, undefined, toolInputs)).toEqual({
      toolName: "hub",
      input: { op: "jobs", job_id: "7" },
    })
  })

  test("pi keeps only the argument renames its own schemas define", () => {
    // pi 0.84.1 `bash` is {command, timeout} with no working-directory arg, and
    // `edit` is {path, edits:[{oldText,…}]} rather than flat replace fields —
    // so neither may be aliased onto omp's shape.
    const tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, piProfile())
    expect(toolInputs?.write?.inputAliases).toEqual({ filePath: "path", file_path: "path" })
    expect(toolInputs?.edit?.inputAliases).toEqual({ filePath: "path", file_path: "path" })
    expect(toolInputs?.edit?.inputShape).toBe("pi-edit")
    expect(toolInputs?.bash).toBeUndefined()
    expect(translateCanonicalToolCall("bash", { command: "ls", workdir: "/tmp" }, undefined, toolInputs)).toBeUndefined()
    expect(translateCanonicalToolCall("write", { filePath: "a.ts", content: "x" }, undefined, toolInputs)).toEqual({
      toolName: "write",
      input: { path: "a.ts", content: "x" },
    })
    expect(translateCanonicalToolCall(
      "edit",
      { filePath: "a.ts", oldString: "before", newString: "after" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
    })
    expect(translateCanonicalToolCall(
      "edit",
      { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
    })
  })

  test("pi edit accepts a sibling host's replacement vocabulary", () => {
    // MiMo (`file_path`/`old_string`) and OMP's replace mode use snake_case for
    // the same logical fields; a model carrying either into a pi session must
    // still reach pi's nested schema rather than failing validation.
    const tools = [{ name: "edit" }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, piProfile())

    expect(translateCanonicalToolCall(
      "edit",
      { file_path: "a.ts", old_string: "before", new_string: "after", replace_all: true },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
    })

    // Host-native path name already correct, snake_case replacement fields.
    expect(translateCanonicalToolCall(
      "edit",
      { path: "a.ts", old_string: "before", new_string: "after" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
    })

    // Pi's own vocabulary still wins when more than one spelling is present.
    expect(translateCanonicalToolCall(
      "edit",
      { path: "a.ts", oldText: "pi", old_string: "mimo", newText: "x", new_string: "y" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "pi", newText: "x" }] },
    })
  })

  test("pi advertises OpenCode's flat edit schema while executing Pi's nested shape", () => {
    const tools = [{ name: "edit", description: "Edit a file", parameters: {
      type: "object",
      properties: { path: { type: "string" }, edits: { type: "array" } },
      required: ["path", "edits"],
    } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, piProfile())

    expect(translateTools(tools, toSchema as never, undefined, toolInputs)).toEqual([{
      type: "function",
      name: "edit",
      description: "Edit a file",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file to edit (relative or absolute)" },
          oldString: { type: "string", description: "Exact text to replace. Must match exactly once in the file." },
          newString: { type: "string", description: "Replacement text" },
        },
        required: ["filePath", "oldString", "newString"],
        additionalProperties: false,
      },
    }])
    // pi has no replace-all mode, so the contract must not offer one.
    expect(
      (translateTools(tools, toSchema as never, undefined, toolInputs)?.[0]?.inputSchema as {
        properties: Record<string, unknown>
      }).properties.replaceAll,
    ).toBeUndefined()
    expect(translateCanonicalToolCall(
      "edit",
      { filePath: "a.ts", oldString: "before", newString: "after" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
    })
  })

  test("omp OpenCode edit schema advertises replaceAll supported by its overlay", () => {
    const tools = [{ name: "edit", description: "Edit a file", parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile(), toSchema as never)
    const schema = translateTools(tools, toSchema as never, undefined, toolInputs)?.[0]?.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(schema.properties.replaceAll).toEqual({
      type: "boolean",
      description: "Replace every occurrence instead of requiring a unique match",
    })
  })

  test("pi exposes its live find tool to the provider as OpenCode glob", () => {
    const tools = [{ name: "find", description: "Find files", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, piProfile())

    expect(toolInputs?.find?.providerName).toBe("glob")
    expect(translateTools(tools, toSchema as never, undefined, toolInputs)).toEqual([
      {
        type: "function",
        name: "glob",
        description: "Find files",
        inputSchema: { type: "object" },
      },
    ])
    expect(translateCanonicalToolCall("glob", { pattern: "**/*.ts", path: "." }, undefined, toolInputs)).toEqual({
      toolName: "find",
      input: { pattern: "**/*.ts", path: "." },
    })
  })

  test("read folds OpenCode offset/limit into the host's inline path selector", () => {
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())

    expect(toolInputs?.read?.inputShape).toBe("opencode-read")
    expect(translateTools(tools, toSchema as never, undefined, toolInputs)?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "integer", minimum: 1, description: "1-indexed line number to start reading from" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
      },
      required: ["filePath"],
      additionalProperties: false,
    })
    // offset + limit → inclusive `raw:N-M` (raw disables omp context padding).
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "/a/b.swift", offset: 150, limit: 80 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift:raw:150-229" } })
    // `path` already in host shape is honoured too.
    expect(translateCanonicalToolCall(
      "read",
      { path: "/a/b.swift", offset: 520, limit: 150 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift:raw:520-669" } })
    // offset only → open-ended `raw:N`.
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "/a/b.swift", offset: 80 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift:raw:80" } })
    // limit only → `raw:1-limit`.
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "CHANGELOG.md", limit: 40 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "CHANGELOG.md:raw:1-40" } })
    // no offset/limit → unchanged.
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "/a/b.swift" },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift" } })
    // History replay peels the selector back to OpenCode paging fields.
    expect(translateHostToolCallInput("read", { path: "/a/b.swift:raw:10-14" }, toolInputs)).toEqual({
      filePath: "/a/b.swift",
      offset: 10,
      limit: 5,
    })
    expect(translateHostToolCallInput("read", { path: "/a/b.swift:150-229" }, toolInputs)).toEqual({
      filePath: "/a/b.swift",
      offset: 150,
      limit: 80,
    })
  })

  test("read handles colon filenames, Windows paths, and URLs", () => {
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())

    // Windows drive letter colon sits before the first separator and is safe.
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "C:\\src\\a.swift", offset: 10, limit: 5 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "C:\\src\\a.swift:raw:10-14" } })
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "/a/name:with-colon.swift", offset: 10, limit: 5 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/name:with-colon.swift:raw:10-14" } })
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "https://example.com", offset: 10, limit: 5 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "https://example.com/:raw:10-14" } })
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "https://example.com:8443", offset: 10, limit: 5 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "https://example.com:8443/:raw:10-14" } })
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "https://example.com/file?raw=1#part", offset: 10, limit: 5 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "https://example.com/file:raw:10-14?raw=1#part" } })
    expect(translateHostToolCallInput(
      "read",
      { path: "https://example.com/:raw:10-14" },
      toolInputs,
    )).toEqual({
      filePath: "https://example.com",
      offset: 10,
      limit: 5,
    })
  })

  test("read rejects unsafe numeric coercion and overflow without leaking unsupported host args", () => {
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())

    expect(translateCanonicalToolCall(
      "read",
      { path: "/a/b.swift", offset: "150", limit: 80 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift" } })
    expect(translateCanonicalToolCall(
      "read",
      { path: "/a/b.swift", offset: 1.5, limit: 0 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift" } })
    expect(translateCanonicalToolCall(
      "read",
      { path: "/a/b.swift", offset: Number.MAX_SAFE_INTEGER, limit: 2 },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "read",
      input: { path: "/a/b.swift" },
    })
    expect(translateCanonicalToolCall(
      "read",
      { path: "/a/b.swift", offset: 0, limit: 80 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift:raw:1-80" } })
  })

  test("pi keeps native read offset/limit arguments", () => {
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, piProfile())

    expect(toolInputs?.read?.inputShape).toBeUndefined()
    expect(translateCanonicalToolCall(
      "read",
      { filePath: "/a/b.swift", offset: 150, limit: 80 },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "read", input: { path: "/a/b.swift", offset: 150, limit: 80 } })
  })

  test("omp exposes its live todo tool as OpenCode todowrite and todoread", () => {
    const tools = [{ name: "todo", description: "Track tasks", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())

    expect(toolInputs?.todo?.providerName).toBe("todowrite")
    expect(toolInputs?.todo?.inputShape).toBe("opencode-todo")
    expect(toolInputs?.todo?.extraProviderNames).toEqual(["todoread"])
    const catalog = translateTools(tools, toSchema as never, undefined, toolInputs)
    expect(catalog?.map(tool => tool.name)).toEqual(["todoread", "todowrite"])
    expect(catalog?.find(tool => tool.name === "todoread")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
    const writeSchema = catalog?.find(tool => tool.name === "todowrite")?.inputSchema as {
      required?: string[]
      properties?: { todos?: unknown }
    }
    expect(writeSchema?.required).toEqual(["todos"])
    expect(writeSchema?.properties?.todos).toBeDefined()

    expect(translateCanonicalToolCall("todowrite", { op: "init", list: [] }, undefined, toolInputs)).toEqual({
      toolName: "todo",
      input: { op: "init", list: [] },
    })
    expect(translateCanonicalToolCall("todoread", {}, undefined, toolInputs)).toEqual({
      toolName: "todo",
      input: { op: "view" },
    })
    expect(canonicalToolName("todo", undefined, toolInputs, { op: "view" })).toBe("todoread")
    expect(canonicalToolName("todo", undefined, toolInputs, { op: "init" })).toBe("todowrite")
  })

  test("todo folds OpenCode snapshots into omp ops", () => {
    const tools = [{ name: "todo", description: "Track tasks", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())

    // Active snapshot → flat init; in_progress first.
    expect(translateCanonicalToolCall(
      "todowrite",
      {
        todos: [
          { content: "Later", status: "pending", priority: "medium" },
          { content: "Now", status: "in_progress", priority: "high" },
          { content: "Done", status: "completed", priority: "low" },
          { content: "Dropped", status: "cancelled" },
        ],
      },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "todo",
      input: { op: "init", items: ["Now", "Later"] },
    })

    // Same fold when the live name is already host `todo`.
    expect(translateCanonicalToolCall(
      "todo",
      { todos: [{ content: "Only open", status: "pending" }] },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "todo",
      input: { op: "init", items: ["Only open"] },
    })

    // No remaining open work → clear.
    expect(translateCanonicalToolCall(
      "todowrite",
      {
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "cancelled" },
        ],
      },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "todo", input: { op: "rm" } })
    expect(translateCanonicalToolCall(
      "todowrite",
      { todos: [] },
      undefined,
      toolInputs,
    )).toEqual({ toolName: "todo", input: { op: "rm" } })

    // Native ops pass through; harness keys stripped.
    expect(translateCanonicalToolCall(
      "todo",
      { op: "done", task: "Wire omp", todos: [{ content: "ignore", status: "pending" }], i: "note" },
      undefined,
      toolInputs,
    )).toEqual({
      toolName: "todo",
      input: { op: "done", task: "Wire omp", i: "note" },
    })

    // Unusable snapshot left alone so the host error stays honest.
    expect(translateCanonicalToolCall(
      "todo",
      { todos: "nope" as unknown as never },
      undefined,
      toolInputs,
    )).toBeUndefined()

    // History replay restates init/rm/view without leaking `op` into write schema.
    expect(translateHostToolCallInput("todo", { op: "init", items: ["A", "B"] }, toolInputs)).toEqual({
      todos: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "pending" },
      ],
    })
    expect(translateHostToolCallInput("todo", { op: "view" }, toolInputs)).toEqual({})
    expect(translateHostToolCallInput("todo", { op: "rm" }, toolInputs)).toEqual({ todos: [] })
    expect(translateHostToolCallInput("todo", { op: "done", task: "A" }, toolInputs)).toEqual({
      op: "done",
      task: "A",
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
    expect(done.message.content[0]).toMatchObject({
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
    expect(done.message.content[0]).toMatchObject({
      id: "call_hub_1",
      name: "hub",
      arguments: { op: "jobs" },
    })
  })

  test("stream output folds OpenCode todowrite snapshots into omp todo ops", async () => {
    const tools = [{ name: "todo", description: "Track tasks", parameters: { type: "object" } }] as never
    const toolInputs = buildPiToolInputVocabulary(tools, ompProfile())
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      toolInputs,
      v3Stream: v3Parts([
        {
          type: "tool-call",
          toolCallId: "call_todo_1",
          toolName: "todowrite",
          input: JSON.stringify({
            todos: [
              { content: "Wire omp", status: "in_progress" },
              { content: "Run tests", status: "pending" },
            ],
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
    expect(done.message.content[0]).toMatchObject({
      id: "call_todo_1",
      name: "todo",
      arguments: { op: "init", items: ["Wire omp", "Run tests"] },
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
