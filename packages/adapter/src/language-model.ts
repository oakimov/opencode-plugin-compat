/**
 * Host-dynamic LanguageModelV3 adoption for custom npm providers.
 *
 * Policy comes from HostProfile capabilities:
 * - streamToolCallEnsure=false (MiMo): emit tool-input-start before bare tool-call
 * - bashDescriptionRequired=true (MiMo): fill missing bash.description only
 * - clearSettledTodos=true (MiMo, Kilo): a todo snapshot with no live row
 *   keeps its `completed` rows and drops `cancelled`, so the sidebar can hide
 *   without erasing the named finish snapshot (MiMo marks them `done`).
 * - Provider-declared occupancy finishes keep checkpoint context on each
 *   assistant message. Kilo reconciles its separately persisted step records
 *   without counting cumulative occupancy as usage.
 * - argument keys: universally align unique case/separator variants with the
 *   exact tool schema advertised by the active host
 *
 * This layer *does* swap host tool catalogs, where the profile records that the
 * host rotated a builtin name (see vocabulary.ts). An earlier revision refused
 * to, on the reasoning that a catalog is the host's to define. That was wrong:
 * a rotated name means an unmodified plugin's `task` resolves to a different
 * role per host, which is precisely the incompatibility OCP exists to absorb.
 * Translation is confined to roles the profile declares rotated, so hosts that
 * match upstream take a byte-identical path.
 */
import type { HostId, HostProfile } from "@opencode-compat/profile"
import { normalizeV3Usage } from "@opencode-compat/opencode-loader"
import {
  buildVocabulary,
  fanoutId,
  originalCallId,
  compareCanonicalKeys,
  reconstructHostTodos,
  translateCall,
  translateCatalog,
  translatePrompt,
  type HostTodo,
  type Vocabulary,
} from "./vocabulary"

export type StreamAdoptionPolicy = {
  streamToolCallEnsure: boolean
  bashDescriptionRequired: boolean
  clearSettledTodos: boolean
  clearSettledTodoMode: "empty" | "completed-only"
  collapseOccupancyUsage: boolean
  /** See `HostHttp.isolatedSessionPrefixes`. */
  isolatedSessionPrefixes?: readonly string[]
}

export type StreamPartLike = {
  type?: string
  id?: string
  toolCallId?: string
  toolName?: string
  name?: string
  input?: unknown
  [key: string]: unknown
}

/** Optional host usage integration for provider-declared metadata contracts. */
export type ProviderUsageIntegration = {
  projectFinish?(part: StreamPartLike): StreamPartLike
  isOccupancyFinish(part: StreamPartLike): boolean
  recordFinishUsage(sessionID: string | undefined, part: StreamPartLike, step?: {
    textChars: number
    reasoningChars: number
    toolChars: number
    elapsedMs: number
    hasTools: boolean
  }): void
}

type SchemaLike = Record<string, unknown>
type ToolSchemaMap = ReadonlyMap<string, unknown>

export function policyFromProfile(profile: HostProfile): StreamAdoptionPolicy {
  return {
    streamToolCallEnsure: profile.capabilities.streamToolCallEnsure,
    bashDescriptionRequired: profile.capabilities.bashDescriptionRequired,
    clearSettledTodos: profile.capabilities.clearSettledTodos,
    clearSettledTodoMode: profile.capabilities.clearSettledTodoMode,
    collapseOccupancyUsage: profile.capabilities.collapseOccupancyUsage,
    ...(profile.http.isolatedSessionPrefixes?.length
      ? { isolatedSessionPrefixes: profile.http.isolatedSessionPrefixes }
      : {}),
  }
}

export function policyForHostId(id: HostId | string): StreamAdoptionPolicy {
  switch (id) {
    case "mimo":
      return {
        streamToolCallEnsure: false,
        bashDescriptionRequired: true,
        clearSettledTodos: true,
        clearSettledTodoMode: "completed-only",
        collapseOccupancyUsage: false,
      }
    case "kilo":
      return {
        streamToolCallEnsure: true,
        bashDescriptionRequired: false,
        clearSettledTodos: true,
        clearSettledTodoMode: "completed-only",
        collapseOccupancyUsage: false,
        isolatedSessionPrefixes: ["title-"],
      }
    case "opencode":
      return {
        streamToolCallEnsure: true,
        bashDescriptionRequired: false,
        clearSettledTodos: false,
        clearSettledTodoMode: "empty",
        collapseOccupancyUsage: false,
      }
    default:
      // Prefer pass-through when unknown — do not invent host tool requirements
      return {
        streamToolCallEnsure: true,
        bashDescriptionRequired: false,
        clearSettledTodos: false,
        clearSettledTodoMode: "empty",
        collapseOccupancyUsage: false,
      }
  }
}

/** Default bash description when the host schema requires one and the provider omitted it. */
export function defaultBashDescription(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : ""
  if (!text) return "Run shell command"
  const first = text.split(/\s+/)[0] || "command"
  const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text
  return `Run: ${clipped || first}`
}

function toolCallIdOf(part: StreamPartLike): string | undefined {
  if (typeof part.toolCallId === "string" && part.toolCallId) return part.toolCallId
  if (typeof part.id === "string" && part.id) return part.id
  return undefined
}

function toolNameOf(part: StreamPartLike): string | undefined {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName
  if (typeof part.name === "string" && part.name) return part.name
  return undefined
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>) }
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Kilo's sidebar stays open while any stored row is not `completed`, so a
 * finished snapshot that still names `cancelled` would linger.
 *
 * Clearing modes:
 * - empty: replace the finished snapshot with `[]` (no current host)
 * - completed-only (Kilo, MiMo): keep `completed` rows, drop `cancelled`. The
 *   sidebar hides once every remaining row is completed, and the named finish
 *   stays in the transcript (emptying it made self-verify T4f fail and the
 *   model report "5f returned an empty list").
 *
 * An explicit empty list is left alone. Suppressing a tool call would strand
 * the provider's held-open exec waiting for a result that the host can never
 * return.
 */
function collapseOccupancyFinish(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
  usageIntegration?: ProviderUsageIntegration,
): StreamPartLike {
  if (!policy.collapseOccupancyUsage) return part
  if (!usageIntegration?.isOccupancyFinish(part)) return part
  if (!isRecord(part.usage)) return part
  const input = isRecord(part.usage.inputTokens) ? part.usage.inputTokens : {}
  const output = isRecord(part.usage.outputTokens) ? part.usage.outputTokens : {}
  return {
    ...part,
    usage: {
      ...part.usage,
      inputTokens: { ...input, total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { ...output, total: 0, text: 0, reasoning: 0 },
    },
  }
}

function clearSettledTodoSnapshot(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
): StreamPartLike {
  if (!policy.clearSettledTodos) return part
  const name = toolNameOf(part)
  if (name !== "todowrite") return part
  const parsed = parseToolInput(part.input)
  if (!parsed || !Array.isArray(parsed.todos)) return part

  if (parsed.todos.length === 0) return part

  const entries = parsed.todos.filter(isRecord) as Array<Record<string, unknown>>
  const settled = entries.length > 0 && entries.every((entry) => {
    return entry.status === "completed" || entry.status === "cancelled"
  })
  if (!settled) return part
  const todos =
    policy.clearSettledTodoMode === "completed-only"
      ? entries.filter((entry) => entry.status === "completed")
      : []
  const next = { ...parsed, todos }
  return {
    ...part,
    input: typeof part.input === "string" ? JSON.stringify(next) : next,
  }
}

/** Compare identifier conventions without assuming one host's casing style. */
export function canonicalToolKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
}

function resolveLocalRef(root: SchemaLike, ref: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined
  let current: unknown = root
  for (const raw of ref.slice(2).split("/")) {
    if (!isRecord(current)) return undefined
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    current = current[key]
  }
  return current
}

function schemaVariants(schema: unknown, root: SchemaLike): SchemaLike[] {
  const out: SchemaLike[] = []
  const seen = new Set<object>()
  const visit = (candidate: unknown): void => {
    if (!isRecord(candidate) || seen.has(candidate)) return
    seen.add(candidate)
    out.push(candidate)
    visit(resolveLocalRef(root, candidate.$ref))
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = candidate[key]
      if (Array.isArray(branches)) branches.forEach(visit)
    }
  }
  visit(schema)
  return out
}

function propertySchemas(schema: unknown, root: SchemaLike): Map<string, unknown> {
  const found = new Map<string, unknown[]>()
  for (const variant of schemaVariants(schema, root)) {
    if (!isRecord(variant.properties)) continue
    for (const [name, propertySchema] of Object.entries(variant.properties)) {
      const entries = found.get(name) ?? []
      entries.push(propertySchema)
      found.set(name, entries)
    }
  }
  const out = new Map<string, unknown>()
  for (const [name, entries] of found) {
    out.set(name, entries.length === 1 ? entries[0] : { anyOf: entries })
  }
  return out
}

function itemSchema(schema: unknown, root: SchemaLike): unknown {
  const items = schemaVariants(schema, root)
    .map((variant) => variant.items)
    .filter((value) => value !== undefined)
  if (items.length === 0) return undefined
  return items.length === 1 ? items[0] : { anyOf: items }
}

function additionalPropertySchema(schema: unknown, root: SchemaLike): unknown {
  const candidates = schemaVariants(schema, root)
    .map((variant) => variant.additionalProperties)
    .filter(isRecord)
  if (candidates.length === 0) return undefined
  return candidates.length === 1 ? candidates[0] : { anyOf: candidates }
}

function normalizeValueForSchema(value: unknown, schema: unknown, root: SchemaLike): unknown {
  if (Array.isArray(value)) {
    const items = itemSchema(schema, root)
    return items === undefined
      ? value
      : value.map((entry) => normalizeValueForSchema(entry, items, root))
  }
  if (!isRecord(value)) return value

  const properties = propertySchemas(schema, root)
  const additional = additionalPropertySchema(schema, root)
  if (properties.size === 0) {
    if (additional === undefined) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeValueForSchema(entry, additional, root),
      ]),
    )
  }

  const canonicalTargets = new Map<string, string[]>()
  for (const name of properties.keys()) {
    const canonical = canonicalToolKey(name)
    const names = canonicalTargets.get(canonical) ?? []
    names.push(name)
    canonicalTargets.set(canonical, names)
  }

  const out: Record<string, unknown> = {}
  for (const [sourceKey, sourceValue] of Object.entries(value)) {
    let targetKey = sourceKey
    if (!properties.has(sourceKey)) {
      const matches = canonicalTargets.get(canonicalToolKey(sourceKey)) ?? []
      if (matches.length === 1 && !(matches[0]! in value) && !(matches[0]! in out)) {
        targetKey = matches[0]!
      }
    }
    const childSchema = properties.get(targetKey) ?? additional
    out[targetKey] = childSchema === undefined
      ? sourceValue
      : normalizeValueForSchema(sourceValue, childSchema, root)
  }
  return out
}

/**
 * Align an input object to its advertised JSON schema using exact keys first,
 * then a unique case/separator-insensitive match. Ambiguous keys are preserved.
 */
export function normalizeToolInputForSchema(input: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return input
  return normalizeValueForSchema(input, schema, schema)
}

/** File schemas must use OpenCode keys before a provider validates its own calls. */
function canonicalFileToolCatalog(tools: readonly unknown[]): unknown[] {
  const fields: Readonly<Record<string, readonly string[]>> = {
    read: ["filePath"],
    write: ["filePath"],
    edit: ["filePath", "oldString", "newString", "replaceAll"],
    apply_patch: ["patchText"],
  }
  return tools.map(tool => {
    if (!isRecord(tool) || typeof tool.name !== "string") return tool
    const targets = fields[tool.name]
    const schema = tool.inputSchema
    if (!targets || !isRecord(schema) || !isRecord(schema.properties)) return tool
    const renames = new Map<string, string>()
    for (const target of targets) {
      if (Object.hasOwn(schema.properties, target)) continue
      const matches = Object.keys(schema.properties).filter(key => canonicalToolKey(key) === canonicalToolKey(target))
      if (matches.length === 1) renames.set(matches[0]!, target)
    }
    if (renames.size === 0) return tool
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [renames.get(key) ?? key, value])),
        ...(Array.isArray(schema.required)
          ? { required: schema.required.map(key => typeof key === "string" ? renames.get(key) ?? key : key) }
          : {}),
      },
    }
  })
}

function canonicalFileToolPrompt(prompt: unknown, schemas: ToolSchemaMap): unknown {
  if (!Array.isArray(prompt) || schemas.size === 0) return prompt
  return prompt.map(message => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map(part => {
        if (!isRecord(part) || part.type !== "tool-call" || typeof part.toolName !== "string") return part
        const schema = schemas.get(part.toolName)
        const input = parseToolInput(part.input)
        if (!schema || !input) return part
        const normalized = normalizeToolInputForSchema(input, schema)
        return { ...part, input: typeof part.input === "string" ? JSON.stringify(normalized) : normalized }
      }),
    }
  })
}

function toolSchemasFromCall(call: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (!isRecord(call) || !Array.isArray(call.tools)) return out
  for (const candidate of call.tools) {
    if (!isRecord(candidate)) continue
    const name = typeof candidate.name === "string"
      ? candidate.name
      : typeof candidate.toolName === "string"
        ? candidate.toolName
        : undefined
    const schema = candidate.inputSchema ?? candidate.parameters ?? candidate.schema
    if (name && isRecord(schema)) out.set(name, schema)
  }
  return out
}

function withSchemaKeys(part: StreamPartLike, toolSchemas: ToolSchemaMap): StreamPartLike {
  const name = toolNameOf(part)
  const schema = name ? toolSchemas.get(name) : undefined
  const input = parseToolInput(part.input)
  if (!schema || !input) return part
  const normalized = normalizeToolInputForSchema(input, schema)
  const next: StreamPartLike = { ...part }
  next.input = typeof part.input === "string" ? JSON.stringify(normalized) : normalized
  return next
}

function withBashDescription(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
): StreamPartLike {
  if (!policy.bashDescriptionRequired) return part
  if (toolNameOf(part) !== "bash") return part
  const args = parseToolInput(part.input)
  if (!args) return part
  if (typeof args.description === "string" && args.description.length > 0) return part
  args.description = defaultBashDescription(args.command)
  const next: StreamPartLike = { ...part }
  if (typeof part.input === "string") next.input = JSON.stringify(args)
  else next.input = args
  return next
}

/**
 * Expand a single stream/generate part into 0..n parts for the active host.
 * Pure — used by adaptLanguageModel and the install-tree shim runtime.
 *
 * When `context.vocab` is present the call is first restated in the host's own
 * tool vocabulary, which may fan one canonical call out into several host
 * calls. Schema alignment and tool-input-start synthesis then run per emitted
 * call, against the host schema that will actually validate it.
 */
export function adoptStreamPart(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
  seenStarts: Set<string>,
  toolSchemas: ToolSchemaMap = new Map(),
  context?: VocabularyContext,
  usageIntegration?: ProviderUsageIntegration,
): StreamPartLike[] {
  if (!part || typeof part !== "object") return [part]

  if (part.type === "tool-input-start") {
    const id = toolCallIdOf(part)
    if (id) seenStarts.add(id)
    return [part]
  }

  if (part.type === "finish") {
    const projected = usageIntegration?.projectFinish?.(part) ?? part
    return [collapseOccupancyFinish({ ...projected, usage: normalizeV3Usage(projected.usage) }, policy, usageIntegration)]
  }

  if (part.type !== "tool-call") return [part]

  const settled = clearSettledTodoSnapshot(part, policy)
  const translated = translateToolCallPart(settled, context)
  if (translated) {
    const out: StreamPartLike[] = []
    for (const call of translated) out.push(...finalizeToolCall(call, policy, seenStarts, toolSchemas))
    return out
  }

  return finalizeToolCall(settled, policy, seenStarts, toolSchemas)
}

export type VocabularyContext = {
  vocab?: Vocabulary
  hostTodos?: readonly HostTodo[]
}

/**
 * Restate a canonical tool call in host vocabulary, or undefined when the call
 * belongs to no rotated role — every other tool, and every subagent type, is
 * left exactly as the plugin emitted it.
 */
function translateToolCallPart(
  part: StreamPartLike,
  context: VocabularyContext | undefined,
): StreamPartLike[] | undefined {
  const vocab = context?.vocab
  if (!vocab) return undefined

  const id = toolCallIdOf(part)
  const name = toolNameOf(part)
  if (!id || !name) return undefined

  const calls = translateCall(id, name, parseToolInput(part.input) ?? {}, vocab, context.hostTodos)
  if (!calls) return undefined

  const inputWasString = typeof part.input === "string"
  return calls.map((call) => {
    const next: StreamPartLike = {
      ...part,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: inputWasString ? JSON.stringify(call.input) : call.input,
    }
    if (typeof part.id === "string") next.id = call.toolCallId
    if (typeof part.name === "string") next.name = call.toolName
    return next
  })
}

function finalizeToolCall(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
  seenStarts: Set<string>,
  toolSchemas: ToolSchemaMap,
): StreamPartLike[] {
  const adopted = withSchemaKeys(withBashDescription(part, policy), toolSchemas)
  const id = toolCallIdOf(adopted)
  const name = toolNameOf(adopted) ?? "unknown"

  if (policy.streamToolCallEnsure || !id || seenStarts.has(id)) {
    return [adopted]
  }

  seenStarts.add(id)
  // MiMo keys pending tools on tool-input-start.id and later updateToolCall(toolCallId)
  return [
    {
      type: "tool-input-start",
      id,
      toolName: name,
    },
    adopted,
  ]
}

function wrapReadableStream(
  stream: ReadableStream<StreamPartLike>,
  policy: StreamAdoptionPolicy,
  toolSchemas: ToolSchemaMap,
  context: VocabularyContext | undefined,
  sessionID: string | undefined,
  usageIntegration: ProviderUsageIntegration | undefined,
): ReadableStream<StreamPartLike> {
  const seenStarts = new Set<string>()
  let startedAt = performance.now()
  let textChars = 0
  let reasoningChars = 0
  let toolChars = 0
  return stream.pipeThrough(
    new TransformStream<StreamPartLike, StreamPartLike>({
      transform(chunk, controller) {
        if (chunk.type === "text-delta" && typeof chunk.delta === "string") textChars += chunk.delta.length
        if (chunk.type === "reasoning-delta" && typeof chunk.delta === "string") reasoningChars += chunk.delta.length
        if (chunk.type === "tool-call") {
          if (typeof chunk.input === "string") toolChars += chunk.input.length
          else {
            try {
              toolChars += JSON.stringify(chunk.input ?? {}).length
            } catch {
              // Opaque tool inputs must not interrupt the provider stream.
            }
          }
          toolChars += typeof chunk.toolName === "string" ? chunk.toolName.length : 0
        }
        for (const part of adoptStreamPart(chunk, policy, seenStarts, toolSchemas, context, usageIntegration)) {
          if (part.type === "finish") {
            usageIntegration?.recordFinishUsage(sessionID, part, {
              textChars,
              reasoningChars,
              toolChars,
              elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
              hasTools: toolSchemas.size > 0,
            })
            startedAt = performance.now()
            textChars = 0
            reasoningChars = 0
            toolChars = 0
          }
          controller.enqueue(part)
        }
      },
    }),
  )
}

type PreparedCall = {
  args: unknown[]
  toolSchemas: ToolSchemaMap
  context: VocabularyContext | undefined
}

/**
 * Build the host-vocabulary view for one call.
 *
 * Tool schemas are read from the *original* catalog, because outbound parts are
 * restated in host vocabulary before schema alignment runs — they must be
 * checked against the schema the host will validate them with, not the
 * canonical one the plugin saw.
 */
function toolsInFixedOrder<T>(tools: readonly T[]): T[] {
  return [...tools].sort((left, right) => {
    const a = (left as { name?: unknown } | null)?.name
    const b = (right as { name?: unknown } | null)?.name
    return compareCanonicalKeys(String(a ?? ""), String(b ?? ""))
  })
}

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined
  return typeof tool.name === "string" && tool.name ? tool.name : undefined
}

const SESSION_AFFINITY_HEADERS = ["x-opencode-session-id", "x-opencode-session", "x-session-affinity", "x-session-id"] as const

function sessionAffinityFromCall(call: unknown): string | undefined {
  if (!isRecord(call) || !isRecord(call.headers)) return undefined
  const headers = call.headers
 // Prefer the requesting session id. OpenCode 2.x still sends the older
 // affinity spellings as the parent/fork source for prompt-cache sharing.
  for (const expected of SESSION_AFFINITY_HEADERS) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === expected && typeof value === "string" && value) return value
    }
  }
  return undefined
}

/**
 * A host can give a tool-less lifecycle call its own derived session id to
 * isolate it from the agent task (Kilo titles use `title-<sessionID>`). No
 * catalog is ever published under that id, so a provider that pairs a
 * lifecycle call with its session's catalog waits until cancellation. Send
 * such a call without session affinity: the standalone shape the host meant.
 */
function withoutIsolatedSessionAffinity(args: unknown[], prefixes: readonly string[] | undefined): unknown[] {
  if (!prefixes?.length) return args
  const call = args[0]
  if (!isRecord(call) || !isRecord(call.headers)) return args
  if (Array.isArray(call.tools) && call.tools.length > 0) return args
  const isolated = (name: string, value: unknown) =>
    (SESSION_AFFINITY_HEADERS as readonly string[]).includes(name.toLowerCase()) &&
    typeof value === "string" &&
    prefixes.some(prefix => value.startsWith(prefix))
  const entries = Object.entries(call.headers)
  if (!entries.some(([name, value]) => isolated(name, value))) return args
  const next = [...args]
  next[0] = { ...call, headers: Object.fromEntries(entries.filter(([name, value]) => !isolated(name, value))) }
  return next
}

type ResolveCatalogOrder = (call: unknown, tools: readonly unknown[]) => unknown[]

/** Active sessions only. Past this, the oldest epoch re-freezes on its next call. */
const MAX_CATALOG_EPOCHS = 256

/**
 * Freeze the initially sorted cacheable prefix for each provider session.
 * Later discoveries are sorted only within that new batch and appended, so a
 * newly advertised `a` cannot move ahead of an existing `z`. Temporarily
 * absent tools keep their epoch positions and return there when re-advertised.
 */
function createCatalogOrderResolver(): ResolveCatalogOrder {
  const epochs = new Map<string, readonly unknown[]>()

  const remember = (session: string, tools: readonly unknown[]): void => {
    epochs.delete(session)
    epochs.set(session, tools)
    while (epochs.size > MAX_CATALOG_EPOCHS) {
      const oldest = epochs.keys().next().value
      if (oldest === undefined) break
      epochs.delete(oldest)
    }
  }

  return (call, tools) => {
    const session = sessionAffinityFromCall(call)
    if (!session) return toolsInFixedOrder(tools)
    if (tools.length === 0) return []

    const incomingNames = tools.map(toolName)
    if (incomingNames.some(name => !name) || new Set(incomingNames).size !== incomingNames.length) {
      return toolsInFixedOrder(tools)
    }

    const cached = epochs.get(session)
    if (!cached) {
      const initial = toolsInFixedOrder(tools)
      remember(session, initial)
      return initial
    }

    const cachedNames = new Set(cached.map(toolName))
    const newcomers = toolsInFixedOrder(tools.filter(tool => !cachedNames.has(toolName(tool))))
    const epoch = newcomers.length > 0 ? [...cached, ...newcomers] : cached
    remember(session, epoch)

    const advertised = new Set(incomingNames)
    return epoch.filter(tool => advertised.has(toolName(tool)))
  }
}

function prepareCall(
  args: unknown[],
  roles: Pick<HostProfile, "tools"> | undefined,
  resolveCatalogOrder: ResolveCatalogOrder,
): PreparedCall {
  const call = args[0]
  const toolSchemas = toolSchemasFromCall(call)
  if (!call || typeof call !== "object") {
    return { args, toolSchemas, context: undefined }
  }

  const record = call as { tools?: unknown; prompt?: unknown; [key: string]: unknown }
  const tools = Array.isArray(record.tools) ? record.tools : undefined
  if (!tools) return { args, toolSchemas, context: undefined }
  const providerTools = canonicalFileToolCatalog(tools)
  const fileSchemas = new Map<string, unknown>()
  providerTools.forEach((tool, i) => {
    if (tool !== tools[i] && isRecord(tool) && typeof tool.name === "string") fileSchemas.set(tool.name, tool.inputSchema)
  })
  const providerPrompt = canonicalFileToolPrompt(record.prompt, fileSchemas)
  if (!roles?.tools) {
    const next = [...args]
    next[0] = { ...record, tools: resolveCatalogOrder(call, providerTools),
      ...(providerPrompt !== record.prompt ? { prompt: providerPrompt } : {}) }
    return { args: next, toolSchemas, context: undefined }
  }

  const advertised: string[] = []
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null)?.name
    if (typeof name === "string" && name) advertised.push(name)
  }

  const vocab = buildVocabulary(roles, advertised)
  const canonical = vocab ? translateCatalog(providerTools, vocab) : providerTools
  const ordered = resolveCatalogOrder(call, canonical)
  if (!vocab) {
    const next = [...args]
    next[0] = { ...record, tools: ordered,
      ...(providerPrompt !== record.prompt ? { prompt: providerPrompt } : {}) }
    return { args: next, toolSchemas, context: undefined }
  }

  const prompt = Array.isArray(providerPrompt) ? providerPrompt : undefined
  const hostTodos = reconstructHostTodos(record.prompt, vocab)

  const next = [...args]
  next[0] = {
    ...record,
    tools: ordered,
    ...(prompt ? { prompt: translatePrompt(prompt, vocab) } : {}),
  }

  return { args: next, toolSchemas, context: { vocab, hostTodos } }
}

/** Collect a resumed child only after its native send call has completed. */
function subagentResumeWait(call: unknown, roles: Pick<HostProfile, "tools"> | undefined): StreamPartLike[] | undefined {
  if (!isRecord(call) || !Array.isArray(call.prompt) || !Array.isArray(call.tools)) return undefined
  const vocab = buildVocabulary(roles, call.tools.flatMap(tool => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
  const last = call.prompt.at(-1)
  if (!vocab?.subagentHost || !isRecord(last) || last.role !== "tool" || !Array.isArray(last.content)) return undefined
  const parts = call.prompt.flatMap(message => isRecord(message) && Array.isArray(message.content) ? message.content : [])
  const waits: StreamPartLike[] = []
  for (const result of last.content) {
    if (!isRecord(result) || result.type !== "tool-result" || result.toolName !== vocab.subagentHost || typeof result.toolCallId !== "string") continue
    const original = originalCallId(result.toolCallId)
    if (!original || result.toolCallId !== fanoutId(original, 0)) continue
    if (parts.some(part => isRecord(part) && part.type === "tool-call" && part.toolCallId === fanoutId(original, 1))) continue
    const sent = parts.find(part => isRecord(part) && part.type === "tool-call" && part.toolCallId === result.toolCallId && part.toolName === vocab.subagentHost)
    if (!isRecord(sent)) continue
    const input = parseToolInput(sent.input)
    const op = input?.operation
    if (!isRecord(op) || op.action !== "send" || typeof op.to_actor_id !== "string") continue
    const output = result.output
    if (!isRecord(output) || output.type !== "text" || typeof output.value !== "string") continue
    try {
      const receipt: unknown = JSON.parse(output.value)
      if (!isRecord(receipt) || typeof receipt.inboxID !== "string" || receipt.error) continue
    } catch { continue }
    waits.push({ type: "tool-call", toolCallId: fanoutId(original, 1), toolName: vocab.subagentHost,
      input: JSON.stringify({ operation: { action: "wait", actor_id: op.to_actor_id } }) })
  }
  return waits.length > 0 ? waits : undefined
}

const RESUME_WAIT_FINISH = { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } }

function isThenable<T>(value: unknown): value is Promise<T> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

/**
 * Wrap a LanguageModelV3-like object so doStream / doGenerate adopt parts
 * for the active host and the schemas supplied with each call.
 */
export function adaptLanguageModel<T>(
  model: T,
  policy: StreamAdoptionPolicy,
  roles?: Pick<HostProfile, "tools">,
  resolveCatalogOrder: ResolveCatalogOrder = createCatalogOrderResolver(),
  usageIntegration?: ProviderUsageIntegration,
): T {
  if (!model || typeof model !== "object") return model

  const original = model as {
    doStream?: (...args: unknown[]) => unknown
    doGenerate?: (...args: unknown[]) => unknown
    [key: string]: unknown
  }

  const adapted = Object.create(
    Object.getPrototypeOf(original),
    Object.getOwnPropertyDescriptors(original),
  ) as typeof original

  if (typeof original.doStream === "function") {
    const inner = original.doStream.bind(original)
    adapted.doStream = (...callArgs: unknown[]) => {
      const args = withoutIsolatedSessionAffinity(callArgs, policy.isolatedSessionPrefixes)
      const wait = subagentResumeWait(args[0], roles)
      if (wait) {
        const seen = new Set<string>()
        const schemas = toolSchemasFromCall(args[0])
        const parts = wait.flatMap(part => adoptStreamPart(part, policy, seen, schemas))
        return Promise.resolve({ stream: new ReadableStream({ start(controller) {
          for (const part of parts) controller.enqueue(part)
          controller.enqueue(RESUME_WAIT_FINISH)
          controller.close()
        } }) })
      }
      const sessionID = sessionAffinityFromCall(args[0])
      const prepared = prepareCall(args, roles, resolveCatalogOrder)
      const result = inner(...prepared.args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { stream?: unknown; [key: string]: unknown }
        if (record.stream instanceof ReadableStream) {
          return {
            ...record,
            stream: wrapReadableStream(
              record.stream as ReadableStream<StreamPartLike>,
              policy,
              prepared.toolSchemas,
              prepared.context,
              sessionID,
              usageIntegration,
            ),
          }
        }
        return resolved
      }
      if (isThenable(result)) return result.then(finish)
      return finish(result)
    }
  }

  if (typeof original.doGenerate === "function") {
    const inner = original.doGenerate.bind(original)
    adapted.doGenerate = (...callArgs: unknown[]) => {
      const args = withoutIsolatedSessionAffinity(callArgs, policy.isolatedSessionPrefixes)
      const wait = subagentResumeWait(args[0], roles)
      if (wait) return Promise.resolve({ content: wait, finishReason: RESUME_WAIT_FINISH.finishReason, usage: RESUME_WAIT_FINISH.usage })
      const sessionID = sessionAffinityFromCall(args[0])
      const prepared = prepareCall(args, roles, resolveCatalogOrder)
      const result = inner(...prepared.args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { content?: unknown; [key: string]: unknown }
        if (!Array.isArray(record.content)) return resolved
        const seenStarts = new Set<string>()
        const content: StreamPartLike[] = []
        for (const part of record.content as StreamPartLike[]) {
          for (const adopted of adoptStreamPart(part, policy, seenStarts, prepared.toolSchemas, prepared.context, usageIntegration)) {
            if (adopted.type === "finish") usageIntegration?.recordFinishUsage(sessionID, adopted)
            content.push(adopted)
          }
        }
        // doGenerate reports its finish at the result level, outside content.
        // Clone hosts persist step-finish parts only from streamed steps, so a
        // generation result is projected but never queued for reconciliation.
        const terminal = adoptStreamPart({ ...record, type: "finish" }, policy, seenStarts,
          prepared.toolSchemas, prepared.context, usageIntegration)[0]!
        return { ...record, content, usage: terminal.usage, providerMetadata: terminal.providerMetadata }
      }
      if (isThenable(result)) return result.then(finish)
      return finish(result)
    }
  }

  return adapted as T
}

/** Wrap an AI SDK provider object that exposes languageModel(id). */
export function wrapProviderSdk<T>(
  sdk: T,
  policy: StreamAdoptionPolicy,
  roles?: Pick<HostProfile, "tools">,
  usageIntegration?: ProviderUsageIntegration,
): T {
  if (!sdk || typeof sdk !== "object") return sdk

  const original = sdk as {
    languageModel?: (...args: unknown[]) => unknown
    [key: string]: unknown
  }
  if (typeof original.languageModel !== "function") return sdk

  const adapted = Object.create(
    Object.getPrototypeOf(original),
    Object.getOwnPropertyDescriptors(original),
  ) as typeof original

  const inner = original.languageModel.bind(original)
  // One epoch map for every languageModel() this SDK returns. A fresh wrapper
  // per call would re-sort the prefix on each turn.
  const resolveCatalogOrder = createCatalogOrderResolver()
  adapted.languageModel = (...args: unknown[]) => {
    const model = inner(...args)
    if (isThenable(model)) {
      return model.then((resolved) => adaptLanguageModel(resolved, policy, roles, resolveCatalogOrder, usageIntegration))
    }
    return adaptLanguageModel(model, policy, roles, resolveCatalogOrder, usageIntegration)
  }
  return adapted as T
}

/**
 * Wrap a provider package module namespace: every `create*` export that returns
 * an SDK with languageModel() is adapted. Other exports pass through.
 */
export function wrapProviderModule<T extends Record<string, unknown>>(
  mod: T,
  policy: StreamAdoptionPolicy,
  roles?: Pick<HostProfile, "tools">,
  usageIntegration?: ProviderUsageIntegration,
): T {
  if (!mod || typeof mod !== "object") return mod

  const out: Record<string, unknown> = { ...mod }
  for (const [key, value] of Object.entries(mod)) {
    if (key === "default") continue
    if (!key.startsWith("create") || typeof value !== "function") continue
    const factory = value as (...args: unknown[]) => unknown
    out[key] = (...args: unknown[]) => {
      const sdk = factory(...args)
      if (isThenable(sdk)) {
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy, roles, usageIntegration))
      }
      return wrapProviderSdk(sdk, policy, roles, usageIntegration)
    }
  }
  if (typeof mod.default === "function" && !String(mod.default.name).startsWith("create")) {
    // classic plugin default export — leave untouched
    out.default = mod.default
  } else if (typeof mod.default === "function") {
    const factory = mod.default as (...args: unknown[]) => unknown
    out.default = (...args: unknown[]) => {
      const sdk = factory(...args)
      if (isThenable(sdk)) {
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy, roles, usageIntegration))
      }
      return wrapProviderSdk(sdk, policy, roles, usageIntegration)
    }
  }
  return out as T
}

export function adaptLanguageModelForProfile<T>(
  model: T,
  profile: HostProfile,
  usageIntegration?: ProviderUsageIntegration,
): T {
  return adaptLanguageModel(model, policyFromProfile(profile), profile, createCatalogOrderResolver(), usageIntegration)
}

export function wrapProviderSdkForProfile<T>(sdk: T, profile: HostProfile, usageIntegration?: ProviderUsageIntegration): T {
  return wrapProviderSdk(sdk, policyFromProfile(profile), profile, usageIntegration)
}

export function wrapProviderModuleForProfile<T extends Record<string, unknown>>(
  mod: T,
  profile: HostProfile,
): T {
  return wrapProviderModule(mod, policyFromProfile(profile), profile)
}
