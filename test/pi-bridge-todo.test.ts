/**
 * OpenCode `todowrite` / `todoread` ↔ ops-based host `todo` (`inputShape:
 * "opencode-todo"`). Covers every snapshot scenario the bridge must realise:
 * create, progress, complete, cancel, clear, native passthrough, stream
 * fan-out, and next-turn history fold.
 *
 * The live profile under test is the ops-based host entry (currently omp's
 * `todo`); assertions are about the OpenCode snapshot contract, not a fork id.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt } from "../packages/pi-bridge/src/translate/context.ts"
import { runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"
import {
  buildPiToolInputVocabulary,
  diffTodoSnapshotToHostOps,
  expandTodoSnapshotToHostOps,
  latestHostTodoRows,
  reconstructTodoSnapshotFromHostOps,
  translateCanonicalToolCall,
  translateHostToolCallInput,
} from "../packages/pi-bridge/src/translate/subagent.ts"

function opsTodoInputs() {
  const tools = [{ name: "todo", description: "Track tasks", parameters: { type: "object" } }] as never
  return buildPiToolInputVocabulary(tools, ompProfile())
}

const MODEL = {
  id: "m",
  name: "m",
  api: "acme",
  provider: "acme",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
} as never

class FakeAssistantMessageEventStream {
  events: unknown[] = []
  push(event: unknown) {
    this.events.push(event)
  }
  async result() {
    return this.events.at(-1)
  }
}

async function* v3Parts(parts: unknown[]) {
  for (const part of parts) yield part
}

describe("opencode-todo snapshot → host ops", () => {
  test("open-only create stays a single init (in_progress first)", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "Later", status: "pending" },
          { content: "Now", status: "in_progress" },
        ],
      }),
    ).toEqual([{ op: "init", items: ["Now", "Later"] }])
  })

  test("progress-only snapshot (no terminal rows) stays a single init", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "A", status: "pending" },
          { content: "B", status: "in_progress" },
          { content: "C", status: "pending" },
        ],
      }),
    ).toEqual([{ op: "init", items: ["B", "A", "C"] }])
  })

  test("empty snapshot clears", () => {
    expect(expandTodoSnapshotToHostOps({ todos: [] })).toEqual([{ op: "rm" }])
  })

  test("mixed complete keeps every row then applies done + start", () => {
    // Regression: open-only init dropped completions so creates worked and
    // completed rows stuck as pending on the host.
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { id: "1", content: "A", status: "completed", priority: "medium" },
          { id: "2", content: "B", status: "in_progress", priority: "medium" },
          { id: "3", content: "C", status: "pending", priority: "low" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["A", "B", "C"] },
      { op: "done", task: "A" },
      { op: "start", task: "B" },
    ])
  })

  test("cancel maps to drop; canceled spelling normalizes", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "canceled" },
          { content: "C", status: "in_progress" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["A", "B", "C"] },
      { op: "done", task: "A" },
      { op: "drop", task: "B" },
      { op: "start", task: "C" },
    ])
  })

  test("all-terminal snapshot still lands statuses (not open-only wipe)", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "cancelled" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["A", "B"] },
      { op: "done", task: "A" },
      { op: "drop", task: "B" },
    ])
  })

  test("multiple completed rows each get a done op", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "completed" },
          { content: "C", status: "in_progress" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["A", "B", "C"] },
      { op: "done", task: "A" },
      { op: "done", task: "B" },
      { op: "start", task: "C" },
    ])
  })

  test("Cursor merge/id/priority harness keys do not alter expansion", () => {
    expect(
      expandTodoSnapshotToHostOps({
        merge: true,
        todos: [
          { id: "1", content: "A", status: "completed", priority: "high" },
          { id: "2", content: "B", status: "pending", priority: "low" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["A", "B"] },
      { op: "done", task: "A" },
    ])
  })

  test("blank content rows are skipped; unknown status becomes pending", () => {
    expect(
      expandTodoSnapshotToHostOps({
        todos: [
          { content: "  ", status: "completed" },
          { content: "Keep", status: "weird" },
          null,
          { content: "Done", status: "completed" },
        ],
      }),
    ).toEqual([
      { op: "init", items: ["Keep", "Done"] },
      { op: "done", task: "Done" },
    ])
  })

  test("native host ops pass through; harness keys stripped", () => {
    expect(
      expandTodoSnapshotToHostOps({
        op: "done",
        task: "A",
        todos: [{ content: "ignore", status: "pending" }],
        id: "x",
        priority: "high",
        merge: true,
        i: "note",
      }),
    ).toEqual([{ op: "done", task: "A", i: "note" }])
  })

  test("non-array todos refuse expansion so host validation stays honest", () => {
    expect(expandTodoSnapshotToHostOps({ todos: "nope" as unknown as never })).toBeUndefined()
  })
})

describe("opencode-todo call translation", () => {
  const toolInputs = opsTodoInputs()

  test("todowrite create maps to a single host todo call", () => {
    expect(
      translateCanonicalToolCall(
        "todowrite",
        { todos: [{ content: "Only open", status: "pending" }] },
        undefined,
        toolInputs,
      ),
    ).toEqual({ toolName: "todo", input: { op: "init", items: ["Only open"] } })
  })

  test("todowrite complete fans out init + done + start under one logical write", () => {
    expect(
      translateCanonicalToolCall(
        "todowrite",
        {
          todos: [
            { content: "A", status: "completed" },
            { content: "B", status: "in_progress" },
            { content: "C", status: "pending" },
          ],
        },
        undefined,
        toolInputs,
      ),
    ).toEqual([
      { toolName: "todo", input: { op: "init", items: ["A", "B", "C"] } },
      { toolName: "todo", input: { op: "done", task: "A" } },
      { toolName: "todo", input: { op: "start", task: "B" } },
    ])
  })

  test("todowrite cancel fans out drop", () => {
    expect(
      translateCanonicalToolCall(
        "todowrite",
        {
          todos: [
            { content: "A", status: "completed" },
            { content: "B", status: "in_progress" },
            { content: "C", status: "cancelled" },
          ],
        },
        undefined,
        toolInputs,
      ),
    ).toEqual([
      { toolName: "todo", input: { op: "init", items: ["A", "B", "C"] } },
      { toolName: "todo", input: { op: "done", task: "A" } },
      { toolName: "todo", input: { op: "drop", task: "C" } },
      { toolName: "todo", input: { op: "start", task: "B" } },
    ])
  })

  test("todowrite empty list clears", () => {
    expect(translateCanonicalToolCall("todowrite", { todos: [] }, undefined, toolInputs)).toEqual({
      toolName: "todo",
      input: { op: "rm" },
    })
  })

  test("todoread maps to host view", () => {
    expect(translateCanonicalToolCall("todoread", {}, undefined, toolInputs)).toEqual({
      toolName: "todo",
      input: { op: "view" },
    })
  })

  test("todowrite with merge:true still expands from the snapshot", () => {
    expect(
      translateCanonicalToolCall(
        "todowrite",
        {
          merge: true,
          todos: [
            { content: "A", status: "completed" },
            { content: "B", status: "in_progress" },
          ],
        },
        undefined,
        toolInputs,
      ),
    ).toEqual([
      { toolName: "todo", input: { op: "init", items: ["A", "B"] } },
      { toolName: "todo", input: { op: "done", task: "A" } },
      { toolName: "todo", input: { op: "start", task: "B" } },
    ])
  })

  test("host-named todo with a snapshot still expands", () => {
    expect(
      translateCanonicalToolCall(
        "todo",
        { todos: [{ content: "A", status: "completed" }, { content: "B", status: "pending" }] },
        undefined,
        toolInputs,
      ),
    ).toEqual([
      { toolName: "todo", input: { op: "init", items: ["A", "B"] } },
      { toolName: "todo", input: { op: "done", task: "A" } },
    ])
  })

  test("history replay restates init/rm/view as OpenCode snapshots", () => {
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
})

describe("opencode-todo stream fan-out + history fold", () => {
  test("open-only todowrite stays one host call under the canonical id", async () => {
    const toolInputs = opsTodoInputs()
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
              { content: "A", status: "in_progress" },
              { content: "B", status: "pending" },
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
      message: { content: Array<{ type: string; id: string; name: string; arguments: Record<string, unknown> }> }
    }
    expect(done.message.content).toEqual([
      {
        type: "toolCall",
        id: "call_todo_1",
        name: "todo",
        arguments: { op: "init", items: ["A", "B"] },
      },
    ])
  })

  test("complete snapshot fans out under derived call ids", async () => {
    const toolInputs = opsTodoInputs()
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      toolInputs,
      v3Stream: v3Parts([
        {
          type: "tool-call",
          toolCallId: "call_todo_done",
          toolName: "todowrite",
          input: JSON.stringify({
            todos: [
              { content: "A", status: "completed" },
              { content: "B", status: "in_progress" },
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
      message: { content: Array<{ type: string; id: string; name: string; arguments: Record<string, unknown> }> }
    }
    expect(done.message.content).toEqual([
      {
        type: "toolCall",
        id: "call_todo_done#0",
        name: "todo",
        arguments: { op: "init", items: ["A", "B"] },
      },
      {
        type: "toolCall",
        id: "call_todo_done#1",
        name: "todo",
        arguments: { op: "done", task: "A" },
      },
      {
        type: "toolCall",
        id: "call_todo_done#2",
        name: "todo",
        arguments: { op: "start", task: "B" },
      },
    ])
  })

  test("next-turn history folds fan-out calls and results into one todowrite", () => {
    const toolInputs = opsTodoInputs()
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_x#0",
              name: "todo",
              arguments: { op: "init", items: ["A", "B"] },
            },
            {
              type: "toolCall",
              id: "call_x#1",
              name: "todo",
              arguments: { op: "done", task: "A" },
            },
            {
              type: "toolCall",
              id: "call_x#2",
              name: "todo",
              arguments: { op: "start", task: "B" },
            },
          ],
          api: "acme",
          provider: "acme",
          model: "m",
          usage: {},
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_x#0",
          toolName: "todo",
          content: "initialized",
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_x#1",
          toolName: "todo",
          content: "marked done",
          isError: false,
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "call_x#2",
          toolName: "todo",
          content: "started",
          isError: false,
          timestamp: 4,
        },
      ],
    }

    expect(translateContextToPrompt(context as never, undefined, undefined, toolInputs)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_x",
            toolName: "todowrite",
            input: {
              todos: [
                { content: "A", status: "completed" },
                { content: "B", status: "in_progress" },
              ],
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_x",
            toolName: "todowrite",
            output: { type: "text", value: "initialized\nmarked done\nstarted" },
          },
        ],
      },
    ])
  })

  test("fan-out history fold marks error-text when any host op failed", () => {
    const toolInputs = opsTodoInputs()
    const context = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_e#0", name: "todo", arguments: { op: "init", items: ["A"] } },
            { type: "toolCall", id: "call_e#1", name: "todo", arguments: { op: "done", task: "A" } },
          ],
          api: "acme",
          provider: "acme",
          model: "m",
          usage: {},
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_e#0",
          toolName: "todo",
          content: "ok",
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_e#1",
          toolName: "todo",
          content: "done failed",
          isError: true,
          timestamp: 3,
        },
      ],
    }

    expect(translateContextToPrompt(context as never, undefined, undefined, toolInputs)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_e",
            toolName: "todowrite",
            input: { todos: [{ content: "A", status: "completed" }] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_e",
            toolName: "todowrite",
            output: { type: "error-text", value: "ok\ndone failed" },
          },
        ],
      },
    ])
  })
})

describe("opencode-todo status diffs against the host list", () => {
  type Row = { content: string; status: string }
  const snapshot = (...rows: Row[]) => ({ todos: rows })
  const row = (content: string, status: string): Row => ({ content, status })
  // The 5a→5f lifecycle from the stock self-verify run, as host rows after each step.
  const created = [row("a", "in_progress"), row("b", "pending"), row("c", "pending")]
  const progressed = [row("a", "pending"), row("b", "in_progress"), row("c", "pending")]
  const oneDone = [row("a", "completed"), row("b", "in_progress"), row("c", "pending")]
  const dropped = [row("a", "completed"), row("b", "in_progress"), row("c", "cancelled")]
  const finished = [row("a", "completed"), row("b", "completed"), row("c", "cancelled")]
  const hostRows = (rows: Row[]) => rows as never

  function todoResult(id: string, rows: Row[], extra: Record<string, unknown> = {}) {
    const hostStatus = (status: string) => status === "cancelled" ? "abandoned" : status
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: "todo",
      content: "ok",
      isError: false,
      details: { op: "x", phases: [{ name: "Tasks", tasks: rows.map(r => ({ content: r.content, status: hostStatus(r.status) })) }] },
      ...extra,
    }
  }

  test("status-only steps become single host ops instead of a re-init", () => {
    expect(diffTodoSnapshotToHostOps(snapshot(...progressed), hostRows(created))).toEqual([{ op: "start", task: "b" }])
    expect(diffTodoSnapshotToHostOps(snapshot(...oneDone), hostRows(progressed))).toEqual([{ op: "done", task: "a" }])
    expect(diffTodoSnapshotToHostOps(snapshot(...dropped), hostRows(oneDone))).toEqual([{ op: "drop", task: "c" }])
    expect(diffTodoSnapshotToHostOps(snapshot(...finished), hostRows(dropped))).toEqual([{ op: "done", task: "b" }])
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "completed"), row("b", "in_progress")), hostRows(oneDone)))
      .toEqual([{ op: "rm", task: "c" }])
    expect(diffTodoSnapshotToHostOps(snapshot(...oneDone), hostRows(oneDone))).toEqual([{ op: "view" }])
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "completed"), row("b", "pending"), row("c", "in_progress")), hostRows(oneDone)))
      .toEqual([{ op: "start", task: "c" }])
  })

  test("shapes a status diff cannot express exactly keep the full reconstruct", () => {
    const current = hostRows(created)
    // reorder, new row, reopen, idle without a successor, duplicates, two active rows
    expect(diffTodoSnapshotToHostOps(snapshot(row("b", "in_progress"), row("a", "pending"), row("c", "pending")), current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(...created, row("d", "pending")), current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "pending"), row("b", "in_progress")), hostRows(oneDone))).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "pending"), row("b", "pending"), row("c", "pending")), current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "pending"), row("a", "in_progress")), current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(row("a", "in_progress"), row("b", "in_progress"), row("c", "pending")), current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps({ todos: [] }, current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps({ op: "start", task: "b" }, current)).toBeUndefined()
    expect(diffTodoSnapshotToHostOps(snapshot(...progressed), [])).toBeUndefined()
  })

  test("replaying a diff on the rows it was computed from yields the snapshot", () => {
    const steps: Array<[Row[], Row[]]> = [[created, progressed], [progressed, oneDone], [oneDone, dropped], [dropped, finished],
      [oneDone, [row("a", "completed"), row("b", "in_progress")]], [oneDone, oneDone]]
    for (const [before, after] of steps) {
      const ops = diffTodoSnapshotToHostOps(snapshot(...after), hostRows(before))!
      expect(reconstructTodoSnapshotFromHostOps(ops, hostRows(before))).toEqual(snapshot(...after))
    }
  })

  test("host rows come from the latest successful todo result", () => {
    const toolInputs = opsTodoInputs()
    expect(latestHostTodoRows([], toolInputs)).toBeUndefined()
    const messages = [
      todoResult("t1", created),
      todoResult("t2", progressed),
      todoResult("t3", oneDone, { isError: true }),
      { role: "toolResult", toolCallId: "r", toolName: "read", content: "x", isError: false, details: { phases: [] } },
      { role: "user", content: "next" },
    ]
    expect(latestHostTodoRows(messages, toolInputs)).toEqual(progressed as never)
    expect(latestHostTodoRows([todoResult("t4", dropped)], toolInputs)).toEqual(dropped as never)
    // blocked has no OpenCode status: no diff, full reconstruct
    expect(latestHostTodoRows([todoResult("t5", [row("a", "blocked")])], toolInputs)).toBeUndefined()
    // without the ops-based host tool in this catalog there is no host list
    expect(latestHostTodoRows(messages, undefined)).toBeUndefined()
  })

  test("stream diffs the first todo call and reconstructs a later one in the same response", async () => {
    const toolInputs = opsTodoInputs()
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      toolInputs,
      hostTodos: hostRows(created),
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "c1", toolName: "todowrite", input: JSON.stringify(snapshot(...progressed)) },
        { type: "tool-call", toolCallId: "c2", toolName: "todowrite", input: JSON.stringify(snapshot(...oneDone)) },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })
    const done = piStream.events.at(-1) as { message: { content: Array<{ id: string; arguments: unknown }> } }
    expect(done.message.content.map(block => [block.id, block.arguments])).toEqual([
      ["c1#0", { op: "start", task: "b" }],
      ["c2#0", { op: "init", items: ["a", "b", "c"] }],
      ["c2#1", { op: "done", task: "a" }],
      ["c2#2", { op: "start", task: "b" }],
    ])
  })

  test("history folds each diff back to the snapshot the model sent", () => {
    const toolInputs = opsTodoInputs()
    const steps = [created, progressed, oneDone, dropped, finished]
    const messages: unknown[] = []
    let host: Row[] | undefined
    steps.forEach((after, index) => {
      const id = `call_${index}`
      const translated = translateCanonicalToolCall("todowrite", snapshot(...after), undefined, toolInputs, undefined,
        latestHostTodoRows(messages as never, toolInputs))
      const calls = Array.isArray(translated) ? translated : [translated!]
      const fanout = calls.length > 1 || calls.some(call => call.fanout)
      if (index > 0) expect(calls.every(call => call.input["op"] !== "init")).toBe(true)
      const ids = calls.map((_, n) => fanout ? `${id}#${n}` : id)
      messages.push({ role: "assistant", content: calls.map((call, n) => ({ type: "toolCall", id: ids[n], name: call.toolName, arguments: call.input })),
        api: "acme", provider: "acme", model: "m", usage: {}, stopReason: "toolUse", timestamp: index })
      host = after
      for (const callId of ids) messages.push(todoResult(callId, host))
    })

    const prompt = translateContextToPrompt({ messages } as never, undefined, undefined, toolInputs)
    const writes = prompt.flatMap(message => message.role === "assistant" ? message.content : [])
    expect(writes.map(part => (part as { toolCallId: string }).toolCallId)).toEqual(steps.map((_, i) => `call_${i}`))
    expect(writes.map(part => (part as { input: unknown }).input)).toEqual(steps.map(rows => snapshot(...rows)))
  })

  test("a diff whose prior result left history folds to its own reported rows", () => {
    const toolInputs = opsTodoInputs()
    const context = {
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "d#0", name: "todo", arguments: { op: "done", task: "a" } }],
          api: "acme", provider: "acme", model: "m", usage: {}, stopReason: "toolUse", timestamp: 1 },
        todoResult("d#0", oneDone),
      ],
    }
    const prompt = translateContextToPrompt(context as never, undefined, undefined, toolInputs)
    expect((prompt[0] as { content: Array<{ input: unknown }> }).content[0]!.input).toEqual(snapshot(...oneDone))
  })
})
