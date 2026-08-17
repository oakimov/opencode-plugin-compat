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
  translateResultOutput,
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
    const task = out.find((tool) => (tool as { name: string }).name === "task") as unknown as {
      inputSchema: { properties: Record<string, unknown>; required: string[] }
    }
    expect(Object.keys(task.inputSchema.properties).sort()).toEqual([
      "description",
      "prompt",
      "subagent_type",
      "task_id",
    ])
    expect(task.inputSchema.required).toEqual(["description", "prompt", "subagent_type"])
    // Custom agents must survive translation — this is the "must not impact
    // other subagent types" constraint.
    expect(task.inputSchema.properties["subagent_type"]).toEqual({
      type: "string",
      enum: ["general", "my-custom-agent", "reviewer"],
    })
  })

  test("todowrite is the upstream positional snapshot", () => {
    const out = translateCatalog(tools, mimoVocab())
    const todowrite = out.find((tool) => (tool as { name: string }).name === "todowrite") as unknown as {
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

  test("canonical task schema advertises an optional opaque task_id", () => {
    const vocab = mimoVocab()
    const translated = translateCatalog(
      [{ name: "actor", description: "A", inputSchema: { type: "object" } }],
      vocab,
    )
    const schema = (translated[0] as { inputSchema: Record<string, any> }).inputSchema as {
      properties: Record<string, any>
      additionalProperties: boolean
    }
    expect(schema.properties.task_id.type).toBe("string")
    expect(schema.additionalProperties).toBe(false)
  })

  test("new canonical task calls never forward an unadvertised model field", () => {
    const calls = translateCall(
      "c-model",
      "task",
      {
        description: "Inspect code",
        prompt: "Inspect",
        subagent_type: "reviewer",
        model: "legacy-model",
      },
      mimoVocab(),
    )
    expect(calls?.[0]).toMatchObject({ toolName: "actor" })
    const operation = (calls?.[0]?.input as { operation: Record<string, unknown> }).operation
    expect(operation.model).toBeUndefined()
  })

  test("canonical task resume id becomes actor id", () => {
    const calls = translateCall(
      "c-resume",
      "task",
      {
        description: "Continue review",
        prompt: "Continue",
        subagent_type: "reviewer",
        task_id: "actor_previous",
      },
      mimoVocab(),
    )
    expect(calls?.[0]).toMatchObject({
      toolName: "actor",
      input: { operation: { action: "run", actor_id: "actor_previous" } },
    })
  })

  test("a backgrounded subagent becomes spawn", () => {
    const calls = translateCall(
      "c1",
      "task",
      { description: "d", prompt: "p", subagent_type: "general", background: true },
      mimoVocab(),
    )
    expect((calls?.[0]?.input.operation as { action: string }).action).toBe("spawn")
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
    expect(out[0]?.content).toHaveLength(1)
    expect(out[0]?.content[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "todowrite",
      input: { todos: [] },
    })
    // First result becomes the folded canonical part; the second merges into it.
    expect(out[1]?.content).toHaveLength(1)
    expect(out[1]?.content[0]).toMatchObject({
      toolCallId: "c1",
      toolName: "todowrite",
      type: "tool-result",
    })
    expect(out[1]?.content[0]?.output).toBe("Created T1\nCreated T2")
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
    expect(out[0]?.content[0]).toMatchObject({
      toolCallId: "s1",
      toolName: "task",
      input: { description: "d", prompt: "p", subagent_type: "reviewer" },
    })
  })

  test("host actor_id is restored as canonical task_id on restatement", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "s-resume",
            toolName: "actor",
            input: {
              operation: {
                action: "run",
                description: "Continue review",
                prompt: "Continue",
                subagent_type: "reviewer",
                actor_id: "actor-123",
              },
            },
          },
        ],
      },
    ]
    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<Record<string, unknown>> }>
    expect(out[0]?.content[0]).toMatchObject({
      toolCallId: "s-resume",
      toolName: "task",
      input: {
        description: "Continue review",
        prompt: "Continue",
        subagent_type: "reviewer",
        task_id: "actor-123",
      },
    })
  })

  test("legacy host history preserves model without adding it to new calls", () => {
    const prompt = [{
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "s-legacy-model",
        toolName: "actor",
        input: {
          operation: {
            action: "run",
            description: "Old call",
            prompt: "Continue old call",
            subagent_type: "reviewer",
            model: "legacy-model",
          },
        },
      }],
    }]
    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<Record<string, any>> }>
    expect(out[0]?.content[0]?.input.model).toBe("legacy-model")
  })

  test("actor_id is rewritten to task_id on a restated subagent result", () => {
    const prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "s-out",
            toolName: "actor",
            output: { actor_id: "actor-123", state: "finished" },
          },
        ],
      },
    ]
    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<Record<string, unknown>> }>
    const translated = out[0]?.content[0] as { output: { actor_id?: string; task_id?: string; state: string } }
    expect(translated).toMatchObject({
      toolCallId: "s-out",
      toolName: "task",
    })
    expect(translated.output).toEqual({ task_id: "actor-123", state: "finished" })
  })

  test("translateResultOutput rewrites MiMo actor result text to canonical task form", () => {
    const binding = mimoVocab().bindings.find((b) => b.role === "subagent")
    const host = [
      "actor_id: explore-1 (for resuming to continue this task if needed)",
      "",
      '<actor_result status="completed">',
      "hello",
      "</actor_result>",
    ].join("\n")
    const result = translateResultOutput({ type: "tool-result", toolName: "actor", output: host }, binding)
    expect(result).toEqual({
      type: "tool-result",
      toolName: "actor",
      output: [
        "task_id: explore-1 (for resuming to continue this task if needed)",
        "",
        '<task status="completed">',
        "hello",
        "</task>",
      ].join("\n"),
    })
    const prompt = [{
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "s-text", toolName: "actor", output: host }],
    }]
    const out = translatePrompt(prompt, mimoVocab()) as Array<{ content: Array<{ output: string }> }>
    expect(out[0]?.content[0]?.output).toContain("task_id: explore-1")
    expect(out[0]?.content[0]?.output).toContain("<task status=")
    expect(out[0]?.content[0]?.output).not.toContain("actor_id")
    expect(out[0]?.content[0]?.output).not.toContain("actor_result")
  })

  test("translateResultOutput rewrites structured actor_id directly", () => {
    const result = translateResultOutput(
      { output: { actor_id: "actor-456", status: "ok" } },
      mimoVocab().bindings.find((b) => b.role === "subagent"),
    )
    expect(result).toEqual({ output: { task_id: "actor-456", status: "ok" } })
    expect(translateResultOutput({ output: { status: "ok" } }, undefined)).toEqual({
      output: { status: "ok" },
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
