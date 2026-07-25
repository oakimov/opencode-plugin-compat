/**
 * Bidirectional tool-vocabulary translation.
 *
 * OCP's purpose is to let an *unmodified* OpenCode plugin run on a fork. Forks
 * rotate builtin tool names while keeping the vocabulary: MiMo moved the
 * subagent spawner from `task` to `actor`, then reused the freed `task` name
 * for its work-item tracker (upstream's `todowrite`/`todoread`). A plugin that
 * says `task` therefore means "spawn a subagent" upstream and "record a todo"
 * on MiMo — silently, with no type error and no runtime error until the fork's
 * strict schema rejects the payload.
 *
 * Names are translated by *role*, never by literal name, and only where the
 * host actually differs from upstream. When every role resolves to its upstream
 * name `buildVocabulary` returns undefined and callers take the untouched
 * pass-through path, so hosts that match upstream see no behaviour change at
 * all.
 *
 * Contract: docs/ocp/0.1.md §5
 */
import {
  DEFAULT_TOOL_ROLES,
  resolveToolRole,
  type HostProfile,
  type HostToolRoles,
} from "@opencode-compat/profile"

export type ToolRole = keyof HostToolRoles

/** A host tool entry as it appears in LanguageModelV3CallOptions.tools. */
export type ToolLike = {
  type?: string
  name?: string
  description?: string
  inputSchema?: unknown
  [key: string]: unknown
}

export type RoleBinding = {
  role: ToolRole
  /** Upstream OpenCode name the plugin sees. */
  canonical: string
  /** Name this host actually advertises. */
  host: string
}

export type Vocabulary = {
  readonly bindings: readonly RoleBinding[]
  /** canonical name -> host name, for every rotated role. */
  readonly toHost: ReadonlyMap<string, string>
  readonly subagentHost?: string
  readonly todoWriteHost?: string
  readonly todoReadHost?: string
}

const ROLES: readonly ToolRole[] = ["subagent", "todoWrite", "todoRead"]

/**
 * Resolve the rotated roles for this call.
 *
 * `advertised` must be the tool names the host supplied with *this* request,
 * not the profile's static expectation: a user may disable a builtin, and
 * translating onto a tool that is not there would be worse than not
 * translating at all. Returns undefined when nothing is rotated.
 */
export function buildVocabulary(
  profile: Pick<HostProfile, "tools"> | undefined,
  advertised: Iterable<string>,
): Vocabulary | undefined {
  const names = new Set(advertised)
  const candidates: RoleBinding[] = []

  for (const role of ROLES) {
    const canonical = DEFAULT_TOOL_ROLES[role]
    const host = resolveToolRole(role, names, profile)
    if (!host || host === canonical) continue
    candidates.push({ role, canonical, host })
  }

  // Names the rotations vacate. On MiMo the canonical `task` is advertised, but
  // as the work-item tracker — a name this layer is itself moving to
  // `todowrite`/`todoread`. Reusing it for the subagent role is the whole point
  // and must not be mistaken for shadowing an unrelated host tool.
  const vacated = new Set(candidates.map((binding) => binding.host))

  const bindings = candidates.filter(
    // Refuse only a genuine collision: the host independently advertises the
    // canonical name for something no rotation is moving out of the way.
    (binding) => !names.has(binding.canonical) || vacated.has(binding.canonical),
  )

  if (bindings.length === 0) return undefined

  const toHost = new Map<string, string>()
  for (const binding of bindings) toHost.set(binding.canonical, binding.host)

  return {
    bindings,
    toHost,
    subagentHost: bindings.find((b) => b.role === "subagent")?.host,
    todoWriteHost: bindings.find((b) => b.role === "todoWrite")?.host,
    todoReadHost: bindings.find((b) => b.role === "todoRead")?.host,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function nameOf(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined
  const name = tool["name"]
  return typeof name === "string" && name ? name : undefined
}

/* -------------------------------------------------------------------------- */
/* Catalog translation (host -> plugin)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Lift the host's own `subagent_type` enum out of its operation envelope.
 *
 * The set of subagent types is host- and user-defined (custom agents), so it
 * must be carried through verbatim rather than hardcoded — otherwise a user's
 * custom agents silently disappear from the catalog the plugin advertises.
 */
function liftSubagentTypeSchema(schema: unknown): unknown {
  const operation = operationSchemaOf(schema)
  for (const variant of unionVariants(operation)) {
    const props = isRecord(variant) ? variant["properties"] : undefined
    if (!isRecord(props)) continue
    const subagentType = props["subagent_type"]
    if (subagentType !== undefined) return subagentType
  }
  return { type: "string", description: "The type of specialized agent to use for this task." }
}

function operationSchemaOf(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined
  const props = schema["properties"]
  if (!isRecord(props)) return undefined
  return props["operation"]
}

function unionVariants(schema: unknown): unknown[] {
  if (!isRecord(schema)) return []
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const value = schema[key]
    if (Array.isArray(value)) return value
  }
  return [schema]
}

/** Upstream `task` — flat, exactly as OpenCode advertises it. */
function canonicalSubagentSchema(hostSchema: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 words) description of the task.",
      },
      prompt: { type: "string", description: "The task for the agent to perform." },
      subagent_type: liftSubagentTypeSchema(hostSchema),
    },
    required: ["description", "prompt", "subagent_type"],
    additionalProperties: false,
  }
}

/** Upstream `todowrite` — a positional snapshot with no ids. */
function canonicalTodoWriteSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The updated todo list",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Brief description of the task" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Current status of the task",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Priority level of the task",
            },
          },
          required: ["content", "status", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  }
}

function canonicalTodoReadSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: false }
}

const CANONICAL_DESCRIPTIONS: Record<ToolRole, string> = {
  subagent:
    "Launch a new agent to handle complex, multi-step tasks autonomously. The agent runs independently and returns its final result.",
  todoWrite:
    "Update the todo list for the current session. Always provide the complete list; it replaces the previous one.",
  todoRead: "Read the current todo list for this session.",
}

/**
 * Present the host catalog in upstream OpenCode vocabulary.
 *
 * Host entries backing a rotated role are removed and replaced by their
 * canonical equivalents, so a plugin never sees both `task` and `actor` and can
 * never resolve a role by guessing which one is present.
 */
export function translateCatalog<T>(tools: readonly T[], vocab: Vocabulary): T[] {
  const bySource = new Map<string, ToolLike>()
  for (const tool of tools) {
    const name = nameOf(tool)
    if (name) bySource.set(name, tool as ToolLike)
  }

  const replaced = new Set(vocab.bindings.map((b) => b.host))
  const out: T[] = []

  for (const tool of tools) {
    const name = nameOf(tool)
    if (name && replaced.has(name)) continue
    out.push(tool)
  }

  for (const binding of vocab.bindings) {
    const source = bySource.get(binding.host)
    if (!source) continue
    const inputSchema =
      binding.role === "subagent"
        ? canonicalSubagentSchema(source.inputSchema)
        : binding.role === "todoWrite"
          ? canonicalTodoWriteSchema()
          : canonicalTodoReadSchema()
    out.push({
      ...source,
      name: binding.canonical,
      description: CANONICAL_DESCRIPTIONS[binding.role],
      inputSchema,
    } as unknown as T)
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* Todo snapshot model                                                         */
/* -------------------------------------------------------------------------- */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type TodoItem = {
  content: string
  status: TodoStatus
  priority?: string
}

/** One reconstructed host work item, in the order it was created. */
export type HostTodo = {
  content: string
  status: TodoStatus
  /** Host-assigned id (MiMo `T1`, `T1.1`), once a create result revealed it. */
  hostId?: string
}

const STATUS_FROM_HOST: Record<string, TodoStatus> = {
  open: "pending",
  in_progress: "in_progress",
  // `blocked` has no upstream equivalent; it is still live work, so it reads
  // back as pending rather than being dropped.
  blocked: "pending",
  done: "completed",
  abandoned: "cancelled",
}

function normalizeStatus(value: unknown): TodoStatus {
  if (typeof value !== "string") return "pending"
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled") {
    return value
  }
  return STATUS_FROM_HOST[value] ?? "pending"
}

/** Host action that moves an existing item into `status`. */
function actionForStatus(status: TodoStatus): "start" | "done" | "abandon" | undefined {
  switch (status) {
    case "in_progress":
      return "start"
    case "completed":
      return "done"
    case "cancelled":
      return "abandon"
    default:
      // Upstream `pending` is the host's creation state; there is no operation
      // that moves a started item back, so a regression to pending is a no-op
      // rather than an invented `unblock`.
      return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Call translation (plugin -> host)                                           */
/* -------------------------------------------------------------------------- */

export type TranslatedCall = {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

/** Suffix marking a host call that OCP fanned out of one canonical call. */
export function fanoutId(toolCallId: string, index: number): string {
  return `${toolCallId}#${index}`
}

/** Recover the canonical call id from a fanned-out host call id. */
export function originalCallId(toolCallId: string): string | undefined {
  const at = toolCallId.lastIndexOf("#")
  if (at <= 0) return undefined
  const suffix = toolCallId.slice(at + 1)
  if (!/^\d+$/.test(suffix)) return undefined
  return toolCallId.slice(0, at)
}

function subagentCall(
  toolCallId: string,
  host: string,
  input: Record<string, unknown>,
): TranslatedCall {
  const operation: Record<string, unknown> = {
    // `background` is a Cursor-side notion; the plugin's canonical `task` is
    // blocking, and `run` is the blocking action.
    action: input["background"] === true ? "spawn" : "run",
    description: input["description"],
    prompt: input["prompt"],
    subagent_type: input["subagent_type"],
  }
  if (typeof input["model"] === "string") operation["model"] = input["model"]
  for (const key of Object.keys(operation)) {
    if (operation[key] === undefined) delete operation[key]
  }
  return { toolCallId, toolName: host, input: { operation } }
}

function readTodos(input: Record<string, unknown>): TodoItem[] {
  const todos = input["todos"]
  if (!Array.isArray(todos)) return []
  const out: TodoItem[] = []
  for (const entry of todos) {
    if (!isRecord(entry)) continue
    const content = entry["content"]
    if (typeof content !== "string" || !content.trim()) continue
    out.push({
      content: content.trim(),
      status: normalizeStatus(entry["status"]),
      priority: typeof entry["priority"] === "string" ? entry["priority"] : undefined,
    })
  }
  return out
}

/**
 * Diff a canonical snapshot against reconstructed host state.
 *
 * Upstream todos are a positional list with no ids, so items are joined by
 * position and matched on content. Creates come first so that a later
 * transition in the same batch refers to something that exists; a transition
 * for an item whose host id is not yet known is skipped, not guessed, and is
 * re-derived from the next snapshot once the create result has landed.
 */
export function diffTodos(previous: readonly HostTodo[], next: readonly TodoItem[]): Array<Record<string, unknown>> {
  const creates: Array<Record<string, unknown>> = []
  const renames: Array<Record<string, unknown>> = []
  const transitions: Array<Record<string, unknown>> = []

  next.forEach((todo, index) => {
    const prior = previous[index]

    if (!prior) {
      creates.push({ action: "create", summary: todo.content })
      return
    }

    if (prior.content !== todo.content) {
      if (prior.hostId) renames.push({ action: "rename", id: prior.hostId, summary: todo.content })
      else creates.push({ action: "create", summary: todo.content })
    }

    if (prior.status === todo.status) return
    const action = actionForStatus(todo.status)
    if (!action || !prior.hostId) return
    transitions.push({ action, id: prior.hostId })
  })

  // Items dropped from the snapshot are abandoned rather than left dangling in
  // the host tracker, which is user-visible state.
  for (let index = next.length; index < previous.length; index += 1) {
    const prior = previous[index]
    if (!prior?.hostId) continue
    if (prior.status === "completed" || prior.status === "cancelled") continue
    transitions.push({ action: "abandon", id: prior.hostId })
  }

  return [...creates, ...renames, ...transitions]
}

/**
 * Translate one canonical tool call into the host calls that realise it.
 *
 * Returns undefined when the call is not part of a rotated role, so callers
 * leave every other tool — including every other subagent type — untouched.
 */
export function translateCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  vocab: Vocabulary,
  hostTodos: readonly HostTodo[] = [],
): TranslatedCall[] | undefined {
  if (vocab.subagentHost && toolName === DEFAULT_TOOL_ROLES.subagent) {
    return [subagentCall(toolCallId, vocab.subagentHost, input)]
  }

  if (vocab.todoReadHost && toolName === DEFAULT_TOOL_ROLES.todoRead) {
    return [
      {
        toolCallId,
        toolName: vocab.todoReadHost,
        input: { operation: { action: "list", include_terminal: true } },
      },
    ]
  }

  if (vocab.todoWriteHost && toolName === DEFAULT_TOOL_ROLES.todoWrite) {
    const operations = diffTodos(hostTodos, readTodos(input))
    if (operations.length === 0) {
      // A snapshot that changes nothing still has to produce a result for the
      // pending call, so it degrades to the cheapest read.
      return [
        {
          toolCallId: fanoutId(toolCallId, 0),
          toolName: vocab.todoWriteHost,
          input: { operation: { action: "list", include_terminal: true } },
        },
      ]
    }
    return operations.map((operation, index) => ({
      toolCallId: fanoutId(toolCallId, index),
      toolName: vocab.todoWriteHost as string,
      input: { operation },
    }))
  }

  return undefined
}

/* -------------------------------------------------------------------------- */
/* Host state reconstruction (prompt -> HostTodo[])                            */
/* -------------------------------------------------------------------------- */

const HOST_ID = /\bT\d+(?:\.\d+)*\b/

function extractHostId(output: unknown): string | undefined {
  const text = stringifyOutput(output)
  const match = text.match(HOST_ID)
  return match ? match[0] : undefined
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (!output) return ""
  if (Array.isArray(output)) return output.map(stringifyOutput).join("\n")
  if (isRecord(output)) {
    for (const key of ["output", "text", "value", "content"]) {
      if (key in output) return stringifyOutput(output[key])
    }
    try {
      return JSON.stringify(output)
    } catch {
      return ""
    }
  }
  return String(output)
}

/**
 * Rebuild host work-item state by replaying the operations OCP itself emitted.
 *
 * The conversation is the state: every host call OCP produced, and every result
 * the host returned, is in the prompt. Replaying them is restart-safe and
 * correct across concurrent sessions, where an in-memory cache keyed on the
 * model instance would not be.
 */
export function reconstructHostTodos(prompt: unknown, vocab: Vocabulary): HostTodo[] {
  const host = vocab.todoWriteHost
  if (!host || !Array.isArray(prompt)) return []

  const todos: HostTodo[] = []
  const pendingCreate = new Map<string, number>()

  for (const message of prompt) {
    if (!isRecord(message)) continue
    const content = message["content"]
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (!isRecord(part)) continue
      const type = part["type"]
      const toolName = part["toolName"]
      const toolCallId = part["toolCallId"]
      if (toolName !== host || typeof toolCallId !== "string") continue

      if (type === "tool-call") {
        if (!originalCallId(toolCallId)) continue
        const operation = operationOf(part["input"])
        if (!operation) continue
        applyOperation(todos, operation, toolCallId, pendingCreate)
        continue
      }

      if (type === "tool-result") {
        const index = pendingCreate.get(toolCallId)
        if (index === undefined) continue
        pendingCreate.delete(toolCallId)
        const hostId = extractHostId(part["output"] ?? part["result"])
        const todo = todos[index]
        if (todo && hostId) todo.hostId = hostId
      }
    }
  }

  return todos
}

/* -------------------------------------------------------------------------- */
/* Prompt translation (host -> plugin)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Restate prior turns in canonical vocabulary.
 *
 * A plugin emitted `todowrite` under one call id; the host executed N `task`
 * calls under derived ids and returned N results. Left alone, the next turn
 * would show the plugin a history it never produced — calls it did not make,
 * under names it does not know, and no result for the call it is still waiting
 * on. Fanned-out calls are folded back into the single canonical call and their
 * results concatenated into one.
 */
export function translatePrompt<T>(prompt: readonly T[], vocab: Vocabulary): T[] {
  const hostToCanonical = new Map<string, RoleBinding>()
  for (const binding of vocab.bindings) {
    // todoWrite and todoRead share one host name; the call id decides which,
    // so the write binding is the fallback and reads are detected per call.
    if (!hostToCanonical.has(binding.host) || binding.role === "todoWrite") {
      hostToCanonical.set(binding.host, binding)
    }
  }

  return prompt.map((message) => {
    if (!isRecord(message) || !Array.isArray(message["content"])) return message

    const out: unknown[] = []
    // Fanned-out results collapse into the first part carrying their id.
    const foldedInto = new Map<string, Record<string, unknown>>()

    for (const part of message["content"] as unknown[]) {
      if (!isRecord(part)) {
        out.push(part)
        continue
      }

      const toolName = part["toolName"]
      const toolCallId = part["toolCallId"]
      if (typeof toolName !== "string" || typeof toolCallId !== "string") {
        out.push(part)
        continue
      }

      const binding = hostToCanonical.get(toolName)
      if (!binding) {
        out.push(part)
        continue
      }

      const original = originalCallId(toolCallId)
      if (!original) {
        out.push(restateSingle(part, binding))
        continue
      }

      const existing = foldedInto.get(original)
      if (existing) {
        mergeFoldedPart(existing, part)
        continue
      }

      const folded: Record<string, unknown> = {
        ...part,
        toolCallId: original,
        toolName: binding.canonical,
      }
      // The canonical snapshot cannot be recovered from the host operations it
      // was diffed into, and the plugin only needs the call to exist and carry
      // a result. Restating it as an empty snapshot keeps the history
      // well-formed without inventing todos the plugin never sent.
      if (part["type"] === "tool-call") folded["input"] = { todos: [] }
      foldedInto.set(original, folded)
      out.push(folded)
    }

    return { ...message, content: out } as unknown as T
  })
}

/** Restate a 1:1 host call/result under its canonical name and shape. */
function restateSingle(part: Record<string, unknown>, binding: RoleBinding): Record<string, unknown> {
  const restated: Record<string, unknown> = { ...part, toolName: binding.canonical }
  if (part["type"] !== "tool-call") return restated
  if (binding.role !== "subagent") return restated

  const operation = operationOf(part["input"])
  if (!operation) return restated
  restated["input"] = {
    description: operation["description"],
    prompt: operation["prompt"],
    subagent_type: operation["subagent_type"],
  }
  return restated
}

function mergeFoldedPart(target: Record<string, unknown>, part: Record<string, unknown>): void {
  if (part["type"] !== "tool-result") return
  const existing = stringifyOutput(target["output"] ?? target["result"])
  const addition = stringifyOutput(part["output"] ?? part["result"])
  if (!addition) return
  const merged = existing ? `${existing}\n${addition}` : addition
  if ("output" in target) target["output"] = merged
  else target["result"] = merged
}

function operationOf(input: unknown): Record<string, unknown> | undefined {
  let value = input
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  const operation = value["operation"]
  return isRecord(operation) ? operation : undefined
}

function applyOperation(
  todos: HostTodo[],
  operation: Record<string, unknown>,
  toolCallId: string,
  pendingCreate: Map<string, number>,
): void {
  const action = operation["action"]
  const summary = operation["summary"]
  const id = operation["id"]

  if (action === "create") {
    if (typeof summary !== "string") return
    todos.push({ content: summary, status: "pending" })
    pendingCreate.set(toolCallId, todos.length - 1)
    return
  }

  if (typeof id !== "string") return
  const todo = todos.find((entry) => entry.hostId === id)
  if (!todo) return

  switch (action) {
    case "rename":
      if (typeof summary === "string") todo.content = summary
      return
    case "start":
      todo.status = "in_progress"
      return
    case "done":
      todo.status = "completed"
      return
    case "abandon":
      todo.status = "cancelled"
      return
    default:
      return
  }
}
