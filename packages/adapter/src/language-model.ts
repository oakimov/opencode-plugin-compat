/**
 * Host-dynamic LanguageModelV3 adoption for custom npm providers.
 *
 * Policy comes from HostProfile capabilities — never swaps host tool catalogs.
 * - streamToolCallEnsure=false (MiMo): emit tool-input-start before bare tool-call
 * - bashDescriptionRequired=true (MiMo): fill missing bash.description only
 * - Kilo / OpenCode: pass-through
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
): StreamPartLike[] {
  if (!part || typeof part !== "object") return [part]

  if (part.type === "tool-input-start") {
    const id = toolCallIdOf(part)
    if (id) seenStarts.add(id)
    return [part]
  }

  if (part.type !== "tool-call") return [part]

  const adopted = withBashDescription(part, policy)
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
): ReadableStream<StreamPartLike> {
  const seenStarts = new Set<string>()
  return stream.pipeThrough(
    new TransformStream<StreamPartLike, StreamPartLike>({
      transform(chunk, controller) {
        for (const part of adoptStreamPart(chunk, policy, seenStarts)) {
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
 * for the active host. Identity when policy is fully permissive.
 */
export function adaptLanguageModel<T>(model: T, policy: StreamAdoptionPolicy): T {
  if (!model || typeof model !== "object") return model
  if (policy.streamToolCallEnsure && !policy.bashDescriptionRequired) return model

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
      const result = inner(...args)
      const finish = (resolved: unknown) => {
        if (!resolved || typeof resolved !== "object") return resolved
        const record = resolved as { content?: unknown; [key: string]: unknown }
        if (!Array.isArray(record.content)) return resolved
        const seenStarts = new Set<string>()
        const content: StreamPartLike[] = []
        for (const part of record.content as StreamPartLike[]) {
          content.push(...adoptStreamPart(part, policy, seenStarts))
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
  if (policy.streamToolCallEnsure && !policy.bashDescriptionRequired) return sdk

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
  if (policy.streamToolCallEnsure && !policy.bashDescriptionRequired) return mod

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
