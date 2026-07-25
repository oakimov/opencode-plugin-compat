import { describe, expect, test } from "bun:test"
import { kiloProfile, mimoProfile, opencodeProfile, unknownProfile } from "@opencode-compat/profile"
import {
  adoptStreamPart,
  buildVocabulary,
  diffTodos,
  policyFromProfile,
  reconstructHostTodos,
  translateCall,
  translateCatalog,
  translatePrompt,
  type HostTodo,
  type Vocabulary,
} from "@opencode-compat/adapter"

const MIMO_TOOLS = ["read", "bash", "actor", "task", "glob"]

function mimoVocab(): Vocabulary {
  const vocab = buildVocabulary(mimoProfile(), MIMO_TOOLS)
  if (!vocab) throw new Error("expected MiMo to rotate builtin names")
  return vocab
}

const ACTOR_SCHEMA = {
  type: "object",
  properties: {
    operation: {
      anyOf: [
        {
          type: "object",
          properties: {
            action: { const: "run" },
            description: { type: "string" },
            prompt: { type: "string" },
            subagent_type: { type: "string", enum: ["general", "reviewer", "my-custom-agent"] },
          },
        },
        { type: "object", properties: { action: { const: "status" } } },
      ],
    },
  },
}

describe("buildVocabulary", () => {
  test("hosts matching upstream produce no vocabulary at all", () => {
    for (const profile of [opencodeProfile(), kiloProfile(), unknownProfile()]) {
      expect(buildVocabulary(profile, ["task", "todowrite", "todoread", "read"])).toBeUndefined()
    }
  })

  test("MiMo rotates subagent, todoWrite and todoRead", () => {
    const vocab = mimoVocab()
    expect(vocab.subagentHost).toBe("actor")
    expect(vocab.todoWriteHost).toBe("task")
    expect(vocab.todoReadHost).toBe("task")
    expect(vocab.toHost.get("task")).toBe("actor")
    expect(vocab.toHost.get("todowrite")).toBe("task")
  })

  test("a role whose host tool is not advertised is left untranslated", () => {
    // `actor` disabled by the user: absent beats routing a subagent spawn into
    // the work-item tracker.
    const vocab = buildVocabulary(mimoProfile(), ["read", "task"])
    expect(vocab?.subagentHost).toBeUndefined()
    expect(vocab?.todoWriteHost).toBe("task")
  })

  test("never shadows a canonical name the host independently advertises", () => {
    const vocab = buildVocabulary(mimoProfile(), ["actor", "task", "todowrite"])
    expect(vocab?.todoWriteHost).toBeUndefined()
    expect(vocab?.subagentHost).toBe("actor")
  })

  test("returns undefined when nothing at all is rotated", () => {
    expect(buildVocabulary(undefined, ["task", "read"])).toBeUndefined()
  })
})

describe("translateCatalog", () => {
  const tools = [
    { type: "function", name: "read", inputSchema: { type: "object" } },
    { type: "function", name: "actor", description: "MiMo actor", inputSchema: ACTOR_SCHEMA },
    { type: "function", name: "task", description: "MiMo tracker", inputSchema: { type: "object" } },
  ]

  test("presents upstream vocabulary and hides the rotated host names", () => {
    const out = translateCatalog(tools, mimoVocab())
    const names = out.map((tool) => (tool as { name: string }).name).sort()
    expect(names).toEqual(["read", "task", "todoread", "todowrite"])
  })

  test("unrelated tools pass through byte-identical", () => {
    const out = translateCatalog(tools, mimoVocab())
    expect(out.find((tool) => (tool as { name: string }).name === "read")).toBe(tools[0])
  })

  test("canonical task is flat and carries the host's own subagent types", () => {
    const out = translateCatalog(tools, mimoVocab())
    const task = out.find((tool) => (tool as { name: string }).name === "task") as {
      inputSchema: { properties: Record<string, unknown>; required: string[] }
    }
    expect(Object.keys(task.inputSchema.properties).sort()).toEqual([
      "description",
      "prompt",
      "subagent_type",
    ])
    expect(task.inputSchema.required).toEqual(["description", "prompt", "subagent_type"])
    // Custom agents must survive translation — this is the "must not impact
    // other subagent types" constraint.
    expect(task.inputSchema.properties["subagent_type"]).toEqual({
      type: "string",
      enum: ["general", "reviewer", "my-custom-agent"],
    })
  })

  test("todowrite is the upstream positional snapshot", () => {
    const out = translateCatalog(tools, mimoVocab())
    const todowrite = out.find((tool) => (tool as { name: string }).name === "todowrite") as {
      inputSchema: { properties: { todos: { items: { properties: Record<string, unknown> } } } }
    }
    expect(Object.keys(todowrite.inputSchema.properties.todos.items.properties).sort()).toEqual([
      "content",
      "priority",
      "status",
    ])
  })
})

describe("translateCall", () => {
  test("canonical task becomes a blocking actor run", () => {
    const calls = translateCall(
      "c1",
      "task",
      { description: "Review diff", prompt: "Review the diff", subagent_type: "reviewer" },
      mimoVocab(),
    )
    expect(calls).toEqual([
      {
        toolCallId: "c1",
        toolName: "actor",
        input: {
          operation: {
            action: "run",
            description: "Review diff",
            prompt: "Review the diff",
            subagent_type: "reviewer",
          },
        },
      },
    ])
  })

  test("a backgrounded subagent becomes spawn", () => {
    const calls = translateCall(
      "c1",
      "task",
      { description: "d", prompt: "p", subagent_type: "general", background: true },
      mimoVocab(),
    )
    expect((calls?.[0].input.operation as { action: string }).action).toBe("spawn")
  })

  test("todoread becomes a list operation", () => {
    const calls = translateCall("c2", "todoread", {}, mimoVocab())
    expect(calls).toEqual([
      {
        toolCallId: "c2",
        toolName: "task",
        input: { operation: { action: "list", include_terminal: true } },
      },
    ])
  })

  test("a fresh todowrite snapshot fans out into one create per item", () => {
    const calls = translateCall(
      "c3",
      "todowrite",
      {
        todos: [
          { content: "First", status: "pending", priority: "high" },
          { content: "Second", status: "pending", priority: "low" },
        ],
      },
      mimoVocab(),
    )
    expect(calls?.map((call) => call.toolCallId)).toEqual(["c3#0", "c3#1"])
    expect(calls?.map((call) => call.input.operation)).toEqual([
      { action: "create", summary: "First" },
      { action: "create", summary: "Second" },
    ])
  })

  test("tools outside a rotated role are never touched", () => {
    const vocab = mimoVocab()
    expect(translateCall("c", "read", { filePath: "a" }, vocab)).toBeUndefined()
    expect(translateCall("c", "bash", { command: "ls" }, vocab)).toBeUndefined()
    expect(translateCall("c", "actor", { operation: {} }, vocab)).toBeUndefined()
  })
})

describe("diffTodos", () => {
  const known: HostTodo[] = [
    { content: "First", status: "pending", hostId: "T1" },
    { content: "Second", status: "pending", hostId: "T2" },
  ]

  test("status transitions map onto host actions by id", () => {
    expect(
      diffTodos(known, [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
      ]),
    ).toEqual([
      { action: "done", id: "T1" },
      { action: "start", id: "T2" },
    ])
  })

  test("an unchanged snapshot produces no operations", () => {
    expect(diffTodos(known, [
      { content: "First", status: "pending" },
      { content: "Second", status: "pending" },
    ])).toEqual([])
  })

  test("creates precede transitions so ids exist when referenced", () => {
    const ops = diffTodos(known, [
      { content: "First", status: "completed" },
      { content: "Second", status: "pending" },
      { content: "Third", status: "pending" },
    ])
    expect(ops[0]).toEqual({ action: "create", summary: "Third" })
    expect(ops[1]).toEqual({ action: "done", id: "T1" })
  })

  test("a transition on an item with no host id yet is skipped, not guessed", () => {
    const pending: HostTodo[] = [{ content: "First", status: "pending" }]
    expect(diffTodos(pending, [{ content: "First", status: "completed" }])).toEqual([])
  })

  test("changed content renames when the id is known and creates when it is not", () => {
    expect(diffTodos(known, [
      { content: "First renamed", status: "pending" },
      { content: "Second", status: "pending" },
    ])).toEqual([{ action: "rename", id: "T1", summary: "First renamed" }])

    expect(diffTodos([{ content: "First", status: "pending" }], [{ content: "Other", status: "pending" }])).toEqual([
      { action: "create", summary: "Other" },
    ])
  })

  test("dropped live items are abandoned rather than left dangling", () => {
    expect(diffTodos(known, [{ content: "First", status: "pending" }])).toEqual([
      { action: "abandon", id: "T2" },
    ])
  })

  test("dropped items already terminal are left alone", () => {
    const done: HostTodo[] = [{ content: "First", status: "completed", hostId: "T1" }]
    expect(diffTodos(done, [])).toEqual([])
  })
})

describe("reconstructHostTodos", () => {
  test("replays emitted operations and learns host ids from create results", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1#0",
            toolName: "task",
            input: { operation: { action: "create", summary: "First" } },
          },
          {
            type: "tool-call",
            toolCallId: "c1#1",
            toolName: "task",
            input: { operation: { action: "create", summary: "Second" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1#0", toolName: "task", output: "Created T1: First" },
          { type: "tool-result", toolCallId: "c1#1", toolName: "task", output: "Created T2: Second" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2#0",
            toolName: "task",
            input: { operation: { action: "done", id: "T1" } },
          },
        ],
      },
    ]

    expect(reconstructHostTodos(prompt, mimoVocab())).toEqual([
      { content: "First", status: "completed", hostId: "T1" },
      { content: "Second", status: "pending", hostId: "T2" },
    ])
  })

  test("host calls the plugin made directly are not replayed as OCP state", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "plain",
            toolName: "task",
            input: { operation: { action: "create", summary: "Manual" } },
          },
        ],
      },
    ]
    expect(reconstructHostTodos(prompt, mimoVocab())).toEqual([])
  })

  test("a stringified operation envelope still replays", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1#0",
            toolName: "task",
            input: JSON.stringify({ operation: { action: "create", summary: "First" } }),
          },
        ],
      },
    ]
    expect(reconstructHostTodos(prompt, mimoVocab())).toEqual([{ content: "First", status: "pending" }])
  })
})

describe("translatePrompt", () => {
  test("fanned-out calls and results fold back into the single canonical call", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1#0", toolName: "task", input: { operation: {} } },
          { type: "tool-call", toolCallId: "c1#1", toolName: "task", input: { operation: {} } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1#0", toolName: "task", output: "Created T1" },
          { type: "tool-result", toolCallId: "c1#1", toolName: "task", output: "Created T2" },
        ],
      },
    ]

    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<Record<string, unknown>> }>
    expect(out[0].content).toHaveLength(1)
    expect(out[0].content[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "todowrite",
      input: { todos: [] },
    })
    expect(out[1].content).toHaveLength(1)
    expect(out[1].content[0]).toMatchObject({ toolCallId: "c1", toolName: "todowrite" })
    expect(out[1].content[0].output).toBe("Created T1\nCreated T2")
  })

  test("a subagent call is restated flat under its canonical name", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "s1",
            toolName: "actor",
            input: {
              operation: { action: "run", description: "d", prompt: "p", subagent_type: "reviewer" },
            },
          },
        ],
      },
    ]
    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<Record<string, unknown>> }>
    expect(out[0].content[0]).toMatchObject({
      toolCallId: "s1",
      toolName: "task",
      input: { description: "d", prompt: "p", subagent_type: "reviewer" },
    })
  })

  test("unrelated parts pass through untouched", () => {
    const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    expect(translatePrompt(prompt, mimoVocab())).toEqual(prompt)
  })
})

describe("adoptStreamPart with a vocabulary", () => {
  const policy = policyFromProfile(mimoProfile())

  test("fan-out emits a tool-input-start for every synthesized host call", () => {
    const parts = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "c3",
        toolName: "todowrite",
        input: {
          todos: [
            { content: "First", status: "pending", priority: "high" },
            { content: "Second", status: "pending", priority: "low" },
          ],
        },
      },
      policy,
      new Set(),
      new Map(),
      { vocab: mimoVocab(), hostTodos: [] },
    )

    expect(parts.map((part) => [part.type, part.toolCallId ?? part.id])).toEqual([
      ["tool-input-start", "c3#0"],
      ["tool-call", "c3#0"],
      ["tool-input-start", "c3#1"],
      ["tool-call", "c3#1"],
    ])
    expect(parts.every((part) => part.toolName === "task")).toBe(true)
  })

  test("without a vocabulary the part is adopted exactly as before", () => {
    const call = { type: "tool-call", toolCallId: "c9", toolName: "todowrite", input: { todos: [] } }
    const before = adoptStreamPart(call, policy, new Set(), new Map())
    const after = adoptStreamPart(call, policy, new Set(), new Map(), {})
    expect(after).toEqual(before)
    expect(before.at(-1)?.toolName).toBe("todowrite")
  })
})
