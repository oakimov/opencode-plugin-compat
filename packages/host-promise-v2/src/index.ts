/**
 * Shared Promise v2 aisdk host kit — wired from the OCP layer
 * (operator overrides / sidecar / host-kit helpers).
 *
 * API shape matches `@opencode-ai/plugin/v2/promise` (OpenCode 1.18.x):
 * `await ctx.aisdk.sdk(cb)` / `await ctx.aisdk.language(cb)`.
 *
 * OCP 0.1 T3 bar: `ctx.aisdk` language (+ ideally sdk) hooks.
 * Other domains loud-stub in the same ship.
 */
export const PKG = "@opencode-compat/host-promise-v2" as const
export const VERSION = "0.1.3" as const

export type Registration = {
  readonly dispose: () => Promise<void>
}

export type Reload = {
  readonly reload: () => Promise<void>
}

/** Minimal LanguageModelV3-shaped stand-in for conformance (not a full AI SDK type). */
export type LanguageModelV3Like = {
  specificationVersion: "v3"
  provider: string
  modelId: string
  [key: string]: unknown
}

/**
 * Minimal ModelV2Info stand-in (OpenCode sdk/v2). Full upstream type is large;
 * plugins typically read `providerID`, `id`, and `api.id`.
 */
export type ModelV2InfoLike = {
  id: string
  providerID: string
  name?: string
  api: { id: string; [key: string]: unknown }
  [key: string]: unknown
}

export type SdkEvent = {
  readonly model: ModelV2InfoLike
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

export type LanguageEvent = {
  readonly model: ModelV2InfoLike
  readonly sdk: unknown
  readonly options: Record<string, unknown>
  language?: LanguageModelV3Like | unknown
}

type HookCallback<E> = (event: E) => void | Promise<void>

type AisdkInternal = {
  hooks: AisdkHooks
  emitSdk: (event: SdkEvent) => Promise<SdkEvent>
  emitLanguage: (event: LanguageEvent) => Promise<LanguageEvent>
}

export type AisdkHooks = {
  /** Register an aisdk `sdk` hook (OpenCode Promise v2 shape). */
  sdk: (callback: HookCallback<SdkEvent>) => Promise<Registration>
  /** Register an aisdk `language` hook (OpenCode Promise v2 shape). */
  language: (callback: HookCallback<LanguageEvent>) => Promise<Registration>
  /** Host diagnostics: number of listeners for a named hook. */
  listenerCount(event: "sdk" | "language"): number
  /** Host diagnostics: events that currently have listeners. */
  events(): Array<"sdk" | "language">
}

export type Plugin = {
  readonly id: string
  readonly setup: (context: PluginContext) => Promise<void> | void
}

/** @deprecated Prefer `Plugin` (OpenCode name). */
export type PromisePlugin = Plugin

export type PluginDomain = {
  readonly add: (plugin: Plugin) => Promise<void>
  readonly remove: (id: string) => Promise<void>
}

export type PluginContext = {
  readonly options: Record<string, unknown>
  readonly aisdk: AisdkHooks
  readonly plugin: PluginDomain & { id?: string; [key: string]: unknown }
  /** Loud stubs for T4 domains until wired */
  readonly agent: LoudDomain & Reload
  readonly catalog: LoudDomain & Reload
  readonly command: LoudDomain & Reload
  readonly skill: LoudDomain & Reload
  readonly reference: LoudDomain & Reload
  readonly integration: LoudDomain & Reload
}

type LoudDomain = {
  [key: string]: (...args: unknown[]) => never
}

export type LanguageModelInput = {
  providerID: string
  modelID: string
  package?: string
  options?: Record<string, unknown>
  sdk?: unknown
  model?: Partial<ModelV2InfoLike>
  [key: string]: unknown
}

export type PromiseV2Host = {
  readonly ctx: PluginContext
  /** Register + run `setup` for a Promise v2 plugin. */
  register(plugin: Plugin): Promise<Plugin>
  /** Remove a previously registered plugin by id. */
  remove(id: string): Promise<void>
  /** Provider-resolve: run sdk then language hooks; return mutated fields. */
  resolveProvider(input: LanguageModelInput): Promise<{
    language?: unknown
    sdk: unknown
    model: ModelV2InfoLike
  }>
  /** List plugin ids currently registered via `plugin.add` / `register`. */
  plugins(): string[]
}

const ctxInternal = new WeakMap<PluginContext, AisdkInternal>()

function loudDomain(name: string): LoudDomain & Reload {
  const reload = async (): Promise<never> => {
    throw new Error(
      `${PKG}: Promise v2 domain "${name}" reload is not implemented. See docs/ocp/0.1.md §7.`,
    )
  }
  return new Proxy(
    { reload },
    {
      get(target, prop) {
        if (prop === "reload") return target.reload
        if (prop === Symbol.toStringTag) return `LoudDomain(${name})`
        return (..._args: unknown[]): never => {
          throw new Error(
            `${PKG}: Promise v2 domain "${name}" is not implemented (called: ${String(prop)}). See docs/ocp/0.1.md §7.`,
          )
        }
      },
    },
  ) as unknown as LoudDomain & Reload
}

function createAisdkInternal(): AisdkInternal {
  const sdkHandlers = new Set<HookCallback<SdkEvent>>()
  const languageHandlers = new Set<HookCallback<LanguageEvent>>()

  const hooks: AisdkHooks = {
    async sdk(callback) {
      sdkHandlers.add(callback)
      return {
        async dispose() {
          sdkHandlers.delete(callback)
        },
      }
    },
    async language(callback) {
      languageHandlers.add(callback)
      return {
        async dispose() {
          languageHandlers.delete(callback)
        },
      }
    },
    listenerCount(event) {
      return event === "sdk" ? sdkHandlers.size : languageHandlers.size
    },
    events() {
      const out: Array<"sdk" | "language"> = []
      if (sdkHandlers.size > 0) out.push("sdk")
      if (languageHandlers.size > 0) out.push("language")
      return out
    },
  }

  return {
    hooks,
    async emitSdk(event) {
      for (const handler of [...sdkHandlers]) {
        await handler(event)
      }
      return event
    },
    async emitLanguage(event) {
      for (const handler of [...languageHandlers]) {
        await handler(event)
      }
      return event
    },
  }
}

function modelFromInput(input: LanguageModelInput): ModelV2InfoLike {
  const providerID = String(input.providerID ?? input.model?.providerID ?? "")
  const modelID = String(input.modelID ?? input.model?.id ?? "")
  return {
    id: modelID,
    providerID,
    name: input.model?.name ?? modelID,
    api: { id: modelID, ...(input.model?.api ?? {}) },
    ...input.model,
  }
}

type HostState = {
  plugins: Map<string, Plugin>
  aisdk: AisdkInternal
  options: Record<string, unknown>
  ctx: PluginContext
}

function buildHost(options: Record<string, unknown>): HostState {
  const aisdk = createAisdkInternal()
  const plugins = new Map<string, Plugin>()

  const state: HostState = {
    plugins,
    aisdk,
    options,
    ctx: null as unknown as PluginContext,
  }

  const pluginDomain: PluginDomain & { id?: string; [key: string]: unknown } = {
    async add(plugin) {
      await registerOnHost(state, plugin)
    },
    async remove(id) {
      state.plugins.delete(id)
    },
  }

  const ctx: PluginContext = {
    options,
    aisdk: aisdk.hooks,
    plugin: pluginDomain,
    agent: loudDomain("agent"),
    catalog: loudDomain("catalog"),
    command: loudDomain("command"),
    skill: loudDomain("skill"),
    reference: loudDomain("reference"),
    integration: loudDomain("integration"),
  }
  state.ctx = ctx
  ctxInternal.set(ctx, aisdk)
  return state
}

async function registerOnHost(state: HostState, plugin: Plugin): Promise<Plugin> {
  const defined = define(plugin)
  state.plugins.set(defined.id, defined)
  state.ctx.plugin.id = defined.id
  await defined.setup(state.ctx)
  return defined
}

async function resolveOnHost(
  state: HostState,
  input: LanguageModelInput,
): Promise<{ language?: unknown; sdk: unknown; model: ModelV2InfoLike }> {
  const model = modelFromInput(input)
  const pkg = String(input.package ?? "")
  const opts = { ...(input.options ?? {}) }

  const sdkEvent: SdkEvent = {
    model,
    package: pkg,
    options: opts,
    sdk: input.sdk,
  }
  await state.aisdk.emitSdk(sdkEvent)

  const languageEvent: LanguageEvent = {
    model,
    sdk: sdkEvent.sdk,
    options: opts,
    language: undefined,
  }
  await state.aisdk.emitLanguage(languageEvent)

  return {
    language: languageEvent.language,
    sdk: sdkEvent.sdk,
    model,
  }
}

/**
 * Create an OCP-layer Promise v2 host.
 * Call `register` for each v2 plugin, then `resolveProvider` at provider-resolve time.
 */
export function createPromiseV2Host(
  options: Record<string, unknown> = {},
): PromiseV2Host {
  const state = buildHost(options)
  return {
    ctx: state.ctx,
    async register(plugin) {
      return registerOnHost(state, plugin)
    },
    async remove(id) {
      state.plugins.delete(id)
    },
    async resolveProvider(input) {
      return resolveOnHost(state, input)
    },
    plugins() {
      return [...state.plugins.keys()]
    },
  }
}

/** @deprecated Prefer `createPromiseV2Host().ctx.aisdk`. */
export function createAisdkBus(): AisdkHooks {
  return createAisdkInternal().hooks
}

/** Create a PluginContext for the OCP layer / hosts that wire this kit. */
export function createPluginContext(
  options: Record<string, unknown> = {},
  plugin: { id?: string; [key: string]: unknown } = {},
): PluginContext {
  const host = createPromiseV2Host(options)
  if (plugin.id) host.ctx.plugin.id = plugin.id
  for (const [key, value] of Object.entries(plugin)) {
    if (key === "id") continue
    host.ctx.plugin[key] = value
  }
  return host.ctx
}

/**
 * Promise v2 `define()` — identity + validation (OpenCode-compatible).
 * The OCP layer / host must `register` / invoke `setup` at load time.
 */
export function define(plugin: Plugin): Plugin {
  if (!plugin || typeof plugin.setup !== "function") {
    throw new Error(`${PKG}: define() requires { id, setup(ctx) }`)
  }
  if (typeof plugin.id !== "string" || plugin.id.length === 0) {
    throw new Error(`${PKG}: define() requires a non-empty string id`)
  }
  return plugin
}

export function isPromisePlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Plugin).setup === "function" &&
    typeof (value as Plugin).id === "string"
  )
}

/** Run plugin setup against a fresh OCP-layer host (conformance helper). */
export async function runPromisePlugin(
  plugin: Plugin,
  init?: {
    options?: Record<string, unknown>
  },
): Promise<{ host: PromiseV2Host; ctx: PluginContext; plugin: Plugin }> {
  const host = createPromiseV2Host(init?.options ?? {})
  const defined = await host.register(plugin)
  return { host, ctx: host.ctx, plugin: defined }
}

function requireInternal(ctx: PluginContext): AisdkInternal {
  const internal = ctxInternal.get(ctx)
  if (!internal) {
    throw new Error(
      `${PKG}: PluginContext was not created by this host kit. ` +
        "Use createPromiseV2Host() / runPromisePlugin() / createPluginContext().",
    )
  }
  return internal
}

/**
 * Host provider-resolve helper: emit `sdk` then `language` against ctx listeners.
 * Prefer `createPromiseV2Host().resolveProvider` when you own the host.
 */
export async function injectLanguageModel(
  ctx: PluginContext,
  input: LanguageModelInput = { providerID: "", modelID: "" },
): Promise<{ language?: unknown; sdk?: unknown }> {
  const internal = requireInternal(ctx)
  const model = modelFromInput(input)
  const opts = { ...(input.options ?? {}) }
  const sdkEvent: SdkEvent = {
    model,
    package: String(input.package ?? ""),
    options: opts,
    sdk: input.sdk,
  }
  await internal.emitSdk(sdkEvent)
  const languageEvent: LanguageEvent = {
    model,
    sdk: sdkEvent.sdk,
    options: opts,
  }
  await internal.emitLanguage(languageEvent)
  return { language: languageEvent.language, sdk: sdkEvent.sdk }
}

/** Emit `aisdk` `sdk` hook (optional T3 companion). */
export async function injectSdk(
  ctx: PluginContext,
  input: LanguageModelInput = { providerID: "", modelID: "" },
  seed: { sdk?: unknown } = {},
): Promise<{ sdk?: unknown }> {
  const internal = requireInternal(ctx)
  const model = modelFromInput(input)
  const sdkEvent: SdkEvent = {
    model,
    package: String(input.package ?? ""),
    options: { ...(input.options ?? {}) },
    sdk: seed.sdk ?? input.sdk,
  }
  await internal.emitSdk(sdkEvent)
  return { sdk: sdkEvent.sdk }
}

/** Full host resolve path: language + sdk hooks on an existing ctx. */
export async function resolveProvider(
  ctx: PluginContext,
  input: LanguageModelInput,
): Promise<{ language?: unknown; sdk: unknown }> {
  const out = await injectLanguageModel(ctx, input)
  return { language: out.language, sdk: out.sdk }
}