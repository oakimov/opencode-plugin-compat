/**
 * Load one unchanged OpenCode plugin package for one binding and expose the
 * model aliases the operator configured for it.
 *
 * Generic: nothing here knows a particular provider. The package is resolved
 * only inside the OCP install root, its version and entry checksum are
 * recorded, the neutral path/skills contracts are installed before import, and
 * auth runs through the plugin's own `auth` hook against a durable store.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  collectConfigHookCatalog,
  createPluginInputStub,
  derivePackageName,
  inspectOpenCodePluginModule,
  instantiateHooks,
  loadProviderOptions,
  mergeFactoryOptions,
  type AiSdkFactory,
  type AuthStore,
  type OpenCodeAuth,
  type OpenCodeAuthHook,
  type OpenCodeHooks,
  type OpenCodeModelEntry,
} from "@opencode-compat/opencode-loader"
import type { BindingSpec, PluginSpec, ZcodePaths } from "./config.js"
import { DurableAuthStore, generationAuthView } from "./auth-store.js"
import { installZcodePathBridge } from "./path-bridge.js"

export class PluginLoadError extends Error {
  constructor(
    readonly code: "not-installed" | "version-mismatch" | "entry-unresolved" | "contract-unsupported" | "factory-failed" | "unknown-upstream-model",
    message: string,
  ) {
    super(message)
    this.name = "PluginLoadError"
  }
}

export type ResolvedPackage = {
  name: string
  version: string
  /** Real path of the imported entry file. */
  entry: string
  /** sha256 of the entry file. */
  sha256: string
}

/** Resolve `spec` inside the OCP install root and verify the pinned version. */
export function resolveInstalledPackage(installRoot: string, spec: PluginSpec): ResolvedPackage {
  const manifestPath = join(installRoot, "node_modules", ...spec.package.split("/"), "package.json")
  if (!existsSync(manifestPath)) {
    throw new PluginLoadError("not-installed", `plugin "${spec.id}": ${spec.package} is not installed in the OCP install root (run: ocp zcode install ${spec.package}@${spec.version})`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown }
  if (manifest.version !== spec.version) {
    throw new PluginLoadError("version-mismatch", `plugin "${spec.id}": installed ${spec.package}@${String(manifest.version)} does not match the configured version ${spec.version}`)
  }
  const specifier = spec.entry ? `${spec.package}${spec.entry.slice(1)}` : spec.package
  let entry: string
  try {
    entry = realpathSync(Bun.resolveSync(specifier, installRoot))
  } catch (error) {
    throw new PluginLoadError("entry-unresolved", `plugin "${spec.id}": cannot resolve ${specifier} from the OCP install root: ${error instanceof Error ? error.message : String(error)}`)
  }
  const packageRoot = realpathSync(join(manifestPath, ".."))
  if (!entry.startsWith(`${packageRoot}/`)) {
    throw new PluginLoadError("entry-unresolved", `plugin "${spec.id}": ${specifier} resolved outside its package (${entry})`)
  }
  const sha256 = createHash("sha256").update(readFileSync(entry)).digest("hex")
  return { name: spec.package, version: spec.version, entry, sha256 }
}

export type ModelInfo = {
  alias: string
  upstream: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  input: ("text" | "image")[]
  reasoning: boolean
}

export type AuthReadiness = "not-required" | "ready" | "login-required"

export type ModelCallContext = {
  sessionId?: string
  signal?: AbortSignal
}

export type LoadedPlugin = {
  spec: PluginSpec
  binding: BindingSpec
  resolved: ResolvedPackage
  providerId: string
  hooks?: OpenCodeHooks
  authHook?: OpenCodeAuthHook
  authStore: DurableAuthStore
  models: Map<string, ModelInfo>
  authReadiness(): AuthReadiness
  /** Resolve the AI-SDK model for an alias (runs `auth.loader` with the stored credential). */
  languageModel(alias: string): Promise<LanguageModelV3>
  /** Re-run the config hook (e.g. after login) and refresh catalog facts. */
  refreshCatalog(): Promise<void>
  /** Run a callback with the durable auth view pinned for one operation. */
  withAuthOperation<T>(run: () => Promise<T>): Promise<T>
}

type ImportModule = (url: string) => Promise<Record<string, unknown>>

export type LoadPluginOptions = {
  paths: ZcodePaths
  /** Override for tests: import the resolved entry. */
  importModule?: ImportModule
  /** Override for tests: skip install-root resolution. */
  resolvePackage?: (spec: PluginSpec) => ResolvedPackage
}

function catalogInfo(alias: string, upstream: string, entry: OpenCodeModelEntry | undefined): ModelInfo {
  const declared = entry?.modalities?.input
  const input = Array.isArray(declared)
    ? declared.filter((value): value is "text" | "image" => value === "text" || value === "image")
    : entry?.attachment ? ["text" as const, "image" as const] : ["text" as const]
  return {
    alias,
    upstream,
    name: entry?.name ?? upstream,
    ...(entry?.limit?.context !== undefined ? { contextWindow: entry.limit.context } : {}),
    ...(entry?.limit?.output !== undefined ? { maxOutputTokens: entry.limit.output } : {}),
    input: input.length > 0 ? input : ["text"],
    reasoning: entry?.reasoning ?? false,
  }
}

export async function loadPlugin(binding: BindingSpec, spec: PluginSpec, options: LoadPluginOptions): Promise<LoadedPlugin> {
  if (spec.contract !== "classic") {
    throw new PluginLoadError(
      "contract-unsupported",
      `plugin "${spec.id}": contract "${spec.contract}" is not supported by the ZCode bridge yet (only "classic" is implemented)`,
    )
  }
  const resolved = (options.resolvePackage ?? (s => resolveInstalledPackage(options.paths.installRoot, s)))(spec)
  installZcodePathBridge(options.paths)

  const importModule: ImportModule = options.importModule ?? (url => import(url) as Promise<Record<string, unknown>>)
  const moduleExports = await importModule(pathToFileURL(resolved.entry).href)
  const loaded = inspectOpenCodePluginModule(moduleExports, {
    packageSpecifier: spec.package,
    label: "ocp-zcode",
    ...(spec.factoryExport ? { factoryExport: spec.factoryExport } : {}),
    ...(spec.pluginExport ? { pluginExport: spec.pluginExport } : {}),
  })

  // One store per (binding, plugin, provider); operations pin their own view.
  const declaredProvider = spec.providerId ?? derivePackageName(spec.package)
  let authStore = DurableAuthStore.forPlugin(options.paths.stateDir, binding.id, spec.id, declaredProvider)
  const operation = new AsyncLocalStorage<AuthStore>()
  const delegatingStore: AuthStore = {
    get: () => (operation.getStore() ?? generationAuthView(authStore)).get(),
    set: auth => (operation.getStore() ?? generationAuthView(authStore)).set(auth),
  }
  const stub = createPluginInputStub({
    directory: binding.workspace,
    store: delegatingStore,
    providerId: declaredProvider,
    bridgeName: "ocp-zcode",
    absentClientKeys: ["session"],
  })

  let hooks: OpenCodeHooks | undefined
  if (loaded.pluginFactory) {
    try {
      hooks = await instantiateHooks(loaded.pluginFactory, stub, "ocp-zcode")
    } catch (error) {
      throw new PluginLoadError("factory-failed", `plugin "${spec.id}": OpenCode plugin factory failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const authHook = hooks?.auth
  const providerId = spec.providerId ?? authHook?.provider ?? declaredProvider
  if (providerId !== declaredProvider) authStore = DurableAuthStore.forPlugin(options.paths.stateDir, binding.id, spec.id, providerId)

  const withAuthOperation = <T>(run: () => Promise<T>) => operation.run(generationAuthView(authStore), run)

  const models = new Map<string, ModelInfo>()
  const refreshCatalog = async () => {
    const catalog = hooks
      ? await withAuthOperation(async () => {
        const stored = authStore.read().auth
        // Warm credential-dependent catalogs the way OpenCode does before reading config.
        if (stored && authHook?.loader) await loadProviderOptions(authHook, delegatingStore, stored)
        return collectConfigHookCatalog(hooks!, providerId)
      })
      : undefined
    models.clear()
    for (const model of spec.models) {
      models.set(model.alias, catalogInfo(model.alias, model.upstream, catalog?.entries[model.upstream]))
    }
  }
  await refreshCatalog()

  const authReadiness = (): AuthReadiness => {
    if (!authHook || authHook.methods.length === 0) return "not-required"
    return authStore.read().auth ? "ready" : "login-required"
  }

  const factory = loaded.factory as AiSdkFactory
  const resolveModel = async (alias: string): Promise<LanguageModelV3> => {
    const model = models.get(alias)
    if (!model) throw new PluginLoadError("unknown-upstream-model", `plugin "${spec.id}": unknown model alias "${alias}"`)
    const view = operation.getStore()!
    const stored = await view.get()
    const loaderOptions = await loadProviderOptions(authHook, view, stored)
    const current = await view.get()
    const options = mergeFactoryOptions({
      ...(spec.options ? { createOptions: spec.options } : {}),
      ...(credentialOf(current) !== undefined ? { apiKey: credentialOf(current)! } : {}),
      loaderOptions,
    })
    const provider = await factory(options)
    return provider.languageModel(model.upstream)
  }
  // Plugins write refreshed credentials through the stub client captured at
  // factory time; the operation scope routes those writes to this request's view.
  const languageModel = (alias: string): Promise<LanguageModelV3> =>
    operation.getStore() ? resolveModel(alias) : withAuthOperation(() => resolveModel(alias))

  return {
    spec,
    binding,
    resolved,
    providerId,
    ...(hooks ? { hooks } : {}),
    ...(authHook ? { authHook } : {}),
    authStore,
    models,
    authReadiness,
    languageModel,
    refreshCatalog,
    withAuthOperation,
  }
}

function credentialOf(auth: OpenCodeAuth | undefined): string | undefined {
  if (!auth) return undefined
  if (auth.type === "oauth") return auth.access || undefined
  return auth.key || undefined
}
