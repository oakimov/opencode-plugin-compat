/**
 * Shared Promise v2 aisdk host kit — wired from the OCP layer
 * (operator overrides / sidecar / host-kit helpers), not via host PRs.
 * OCP 0.1 T3 bar: `ctx.aisdk` language (+ ideally sdk) hooks.
 * Other domains loud-stub in the same ship.
 */
export const PKG = "@opencode-compat/host-promise-v2" as const
export const VERSION = "0.1.0" as const

export type AisdkEvent = "language" | "sdk"

export type AisdkHandler = (
  input: Record<string, unknown>,
  output: Record<string, unknown>,
) => void | Promise<void>

export type AisdkBus = {
  on(event: AisdkEvent, handler: AisdkHandler): () => void
  /** Host invokes registered handlers (provider-resolve time). */
  emit(
    event: AisdkEvent,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ): Promise<void>
  listenerCount(event: AisdkEvent): number
  /** Snapshot of registered events (host diagnostics). */
  events(): AisdkEvent[]
}

export type PluginContext = {
  aisdk: AisdkBus
  options: Record<string, unknown>
  plugin: { id?: string; [key: string]: unknown }
  /** Loud stubs for T4 domains until wired */
  agent: LoudDomain
  catalog: LoudDomain
  command: LoudDomain
  skill: LoudDomain
  reference: LoudDomain
  integration: LoudDomain
}

type LoudDomain = {
  [key: string]: (...args: unknown[]) => never
}

export type PromisePlugin = {
  setup(ctx: PluginContext): void | Promise<void>
}

/** Minimal LanguageModelV3-shaped stand-in for conformance (not a full AI SDK type). */
export type LanguageModelV3Like = {
  specificationVersion: "v3"
  provider: string
  modelId: string
  [key: string]: unknown
}

/** Typical host input when resolving a language model. */
export type LanguageModelInput = {
  providerID: string
  modelID: string
  [key: string]: unknown
}

function loudDomain(name: string): LoudDomain {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === Symbol.toStringTag) return `LoudDomain(${name})`
        return () => {
          throw new Error(
            `${PKG}: Promise v2 domain "${name}" is not implemented (called: ${String(prop)}). See docs/ocp/0.1.md §7.`,
          )
        }
      },
    },
  ) as LoudDomain
}

/** Create an aisdk event bus (also available via `createPluginContext().aisdk`). */
export function createAisdkBus(): AisdkBus {
  const handlers = new Map<AisdkEvent, Set<AisdkHandler>>()
  return {
    on(event, handler) {
      let set = handlers.get(event)
      if (!set) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    },
    async emit(event, input, output) {
      const set = handlers.get(event)
      if (!set || set.size === 0) return
      for (const handler of [...set]) {
        await handler(input, output)
      }
    },
    listenerCount(event) {
      return handlers.get(event)?.size ?? 0
    },
    events() {
      return [...handlers.entries()]
        .filter(([, set]) => set.size > 0)
        .map(([event]) => event)
    },
  }
}

/** Create a PluginContext for the OCP layer / hosts that wire this kit. */
export function createPluginContext(
  options: Record<string, unknown> = {},
  plugin: PluginContext["plugin"] = {},
): PluginContext {
  return {
    aisdk: createAisdkBus(),
    options,
    plugin,
    agent: loudDomain("agent"),
    catalog: loudDomain("catalog"),
    command: loudDomain("command"),
    skill: loudDomain("skill"),
    reference: loudDomain("reference"),
    integration: loudDomain("integration"),
  }
}

/**
 * Promise v2 `define()` — registers a plugin setup against the host kit.
 * The OCP layer / host must invoke `setup` at provider-resolve time.
 */
export function define(plugin: PromisePlugin): PromisePlugin {
  if (!plugin || typeof plugin.setup !== "function") {
    throw new Error(`${PKG}: define() requires { setup(ctx) }`)
  }
  return plugin
}

export function isPromisePlugin(value: unknown): value is PromisePlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromisePlugin).setup === "function"
  )
}

/** Run plugin setup against a fresh context (host-kit / conformance helper). */
export async function runPromisePlugin(
  plugin: PromisePlugin,
  init?: {
    options?: Record<string, unknown>
    plugin?: PluginContext["plugin"]
  },
): Promise<{ ctx: PluginContext; plugin: PromisePlugin }> {
  const defined = define(plugin)
  const ctx = createPluginContext(init?.options ?? {}, init?.plugin ?? {})
  await defined.setup(ctx)
  return { ctx, plugin: defined }
}

/**
 * Host provider-resolve helper: emit `aisdk` `language` and return mutated output.
 * Plugins set `output.language` to a LanguageModelV3 (or stand-in).
 */
export async function injectLanguageModel(
  ctx: PluginContext,
  input: LanguageModelInput | Record<string, unknown> = {},
  seed: { language?: unknown } = {},
): Promise<{ language?: unknown }> {
  const output: { language?: unknown } = { ...seed }
  await ctx.aisdk.emit("language", input, output)
  return output
}

/** Emit `aisdk` `sdk` hook (optional T3 companion). */
export async function injectSdk(
  ctx: PluginContext,
  input: Record<string, unknown> = {},
  seed: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const output = { ...seed }
  await ctx.aisdk.emit("sdk", input, output)
  return output
}

/**
 * Full host resolve path: run setup (if needed already done) then language + sdk hooks.
 * Prefer calling `runPromisePlugin` once, then `resolveProvider` on the returned ctx.
 */
export async function resolveProvider(
  ctx: PluginContext,
  input: LanguageModelInput,
): Promise<{ language?: unknown; sdk: Record<string, unknown> }> {
  const languageOut = await injectLanguageModel(ctx, input)
  const sdk = await injectSdk(ctx, input)
  return { language: languageOut.language, sdk }
}
