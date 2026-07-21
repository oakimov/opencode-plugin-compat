/**
 * Host-dynamic LanguageModelV3 adoption for custom npm providers.
 *
 * Policy comes from HostProfile capabilities — never swaps host tool catalogs.
 * - streamToolCallEnsure=false (MiMo): emit tool-input-start before bare tool-call
 * - bashDescriptionRequired=true (MiMo): fill missing bash.description only
 * - argument keys: universally align unique case/separator variants with the
 *   exact tool schema advertised by the active host
 */
import type { HostId, HostProfile } from "@opencode-compat/profile"

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
 */
export function adoptStreamPart(
  part: StreamPartLike,
  policy: StreamAdoptionPolicy,
  seenStarts: Set<string>,
  toolSchemas: ToolSchemaMap = new Map(),
): StreamPartLike[] {
  if (!part || typeof part !== "object") return [part]

  if (part.type === "tool-input-start") {
    const id = toolCallIdOf(part)
    if (id) seenStarts.add(id)
    return [part]
  }

  if (part.type !== "tool-call") return [part]

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
): ReadableStream<StreamPartLike> {
  const seenStarts = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<StreamPartLike, StreamPartLike>({
      transform(chunk, controller) {
        for (const part of adoptStreamPart(chunk, policy, seenStarts, toolSchemas)) {
          controller.enqueue(part)
        }
      },
    }),
  )
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
export function adaptLanguageModel<T>(model: T, policy: StreamAdoptionPolicy): T {
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
      const toolSchemas = toolSchemasFromCall(args[0])
      const result = inner(...args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { stream?: unknown; [key: string]: unknown }
        if (record.stream instanceof ReadableStream) {
          return {
            ...record,
            stream: wrapReadableStream(
              record.stream as ReadableStream<StreamPartLike>,
              policy,
              toolSchemas,
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
      const toolSchemas = toolSchemasFromCall(args[0])
      const result = inner(...args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { content?: unknown; [key: string]: unknown }
        if (!Array.isArray(record.content)) return resolved
        const seenStarts = new Set<string>()
        const content: StreamPartLike[] = []
        for (const part of record.content as StreamPartLike[]) {
          content.push(...adoptStreamPart(part, policy, seenStarts, toolSchemas))
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
export function wrapProviderSdk<T>(sdk: T, policy: StreamAdoptionPolicy): T {
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
      return model.then((resolved) => adaptLanguageModel(resolved, policy))
    }
    return adaptLanguageModel(model, policy)
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
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy))
      }
      return wrapProviderSdk(sdk, policy)
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
        return sdk.then((resolved) => wrapProviderSdk(resolved, policy))
      }
      return wrapProviderSdk(sdk, policy)
    }
  }
  return out as T
}

export function adaptLanguageModelForProfile<T>(
  model: T,
  profile: HostProfile,
): T {
  return adaptLanguageModel(model, policyFromProfile(profile))
}

export function wrapProviderSdkForProfile<T>(sdk: T, profile: HostProfile): T {
  return wrapProviderSdk(sdk, policyFromProfile(profile))
}

export function wrapProviderModuleForProfile<T extends Record<string, unknown>>(
  mod: T,
  profile: HostProfile,
): T {
  return wrapProviderModule(mod, policyFromProfile(profile))
}
