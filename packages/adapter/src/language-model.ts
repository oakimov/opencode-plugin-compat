/**
 * Host-dynamic LanguageModelV3 adoption for custom npm providers.
 *
 * Policy comes from HostProfile capabilities:
 * - streamToolCallEnsure=false (MiMo): emit tool-input-start before bare tool-call
 * - bashDescriptionRequired=true (MiMo): fill missing bash.description only
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
import {
  buildVocabulary,
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

type SchemaLike = Record<string, unknown>
type ToolSchemaMap = ReadonlyMap<string, unknown>

export function policyFromProfile(profile: HostProfile): StreamAdoptionPolicy {
  return {
    streamToolCallEnsure: profile.capabilities.streamToolCallEnsure,
    bashDescriptionRequired: profile.capabilities.bashDescriptionRequired,
  }
}

export function policyForHostId(id: HostId | string): StreamAdoptionPolicy {
  switch (id) {
    case "mimo":
      return { streamToolCallEnsure: false, bashDescriptionRequired: true }
    case "kilo":
    case "opencode":
      return { streamToolCallEnsure: true, bashDescriptionRequired: false }
    default:
      // Prefer pass-through when unknown — do not invent host tool requirements
      return { streamToolCallEnsure: true, bashDescriptionRequired: false }
  }
}

/** Default bash description when the host schema requires one and Cursor omitted it. */
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
): StreamPartLike[] {
  if (!part || typeof part !== "object") return [part]

  if (part.type === "tool-input-start") {
    const id = toolCallIdOf(part)
    if (id) seenStarts.add(id)
    return [part]
  }

  if (part.type !== "tool-call") return [part]

  const translated = translateToolCallPart(part, context)
  if (translated) {
    const out: StreamPartLike[] = []
    for (const call of translated) out.push(...finalizeToolCall(call, policy, seenStarts, toolSchemas))
    return out
  }

  return finalizeToolCall(part, policy, seenStarts, toolSchemas)
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
): ReadableStream<StreamPartLike> {
  const seenStarts = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<StreamPartLike, StreamPartLike>({
      transform(chunk, controller) {
        for (const part of adoptStreamPart(chunk, policy, seenStarts, toolSchemas, context)) {
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
    return String(a ?? "").localeCompare(String(b ?? ""))
  })
}

function prepareCall(args: unknown[], roles: Pick<HostProfile, "tools"> | undefined): PreparedCall {
  const call = args[0]
  const toolSchemas = toolSchemasFromCall(call)
  if (!call || typeof call !== "object") {
    return { args, toolSchemas, context: undefined }
  }

  const record = call as { tools?: unknown; prompt?: unknown; [key: string]: unknown }
  const tools = Array.isArray(record.tools) ? record.tools : undefined
  if (!tools) return { args, toolSchemas, context: undefined }
  if (!roles?.tools) {
    const next = [...args]
    next[0] = { ...record, tools: toolsInFixedOrder(tools) }
    return { args: next, toolSchemas, context: undefined }
  }

  const advertised: string[] = []
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null)?.name
    if (typeof name === "string" && name) advertised.push(name)
  }

  const vocab = buildVocabulary(roles, advertised)
  const ordered = vocab ? translateCatalog(tools, vocab) : toolsInFixedOrder(tools)
  if (!vocab) {
    const next = [...args]
    next[0] = { ...record, tools: ordered }
    return { args: next, toolSchemas, context: undefined }
  }

  const prompt = Array.isArray(record.prompt) ? record.prompt : undefined
  const hostTodos = reconstructHostTodos(record.prompt, vocab)

  const next = [...args]
  next[0] = {
    ...record,
    tools: ordered,
    ...(prompt ? { prompt: translatePrompt(prompt, vocab) } : {}),
  }

  return { args: next, toolSchemas, context: { vocab, hostTodos } }
}

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
    adapted.doStream = (...args: unknown[]) => {
      const prepared = prepareCall(args, roles)
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
    adapted.doGenerate = (...args: unknown[]) => {
      const prepared = prepareCall(args, roles)
      const result = inner(...prepared.args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { content?: unknown; [key: string]: unknown }
        if (!Array.isArray(record.content)) return resolved
        const seenStarts = new Set<string>()
        const content: StreamPartLike[] = []
        for (const part of record.content as StreamPartLike[]) {
          content.push(...adoptStreamPart(part, policy, seenStarts, prepared.toolSchemas, prepared.context))
        }
        return { ...record, content }
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
  adapted.languageModel = (...args: unknown[]) => {
    const model = inner(...args)
    if (isThenable(model)) {
      return model.then((resolved) => adaptLanguageModel(resolved, policy, roles))
    }
    return adaptLanguageModel(model, policy, roles)
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
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy, roles))
      }
      return wrapProviderSdk(sdk, policy, roles)
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
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy, roles))
      }
      return wrapProviderSdk(sdk, policy, roles)
    }
  }
  return out as T
}

export function adaptLanguageModelForProfile<T>(
  model: T,
  profile: HostProfile,
): T {
  return adaptLanguageModel(model, policyFromProfile(profile), profile)
}

export function wrapProviderSdkForProfile<T>(sdk: T, profile: HostProfile): T {
  return wrapProviderSdk(sdk, policyFromProfile(profile), profile)
}

export function wrapProviderModuleForProfile<T extends Record<string, unknown>>(
  mod: T,
  profile: HostProfile,
): T {
  return wrapProviderModule(mod, policyFromProfile(profile), profile)
}
