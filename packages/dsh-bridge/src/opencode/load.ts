/**
 * Loading and shape-detection for an *unmodified* OpenCode plugin package.
 *
 * Two independent conventions are detected on the same module:
 *   1. the AI-SDK provider factory — `createXxx(options) => {languageModel(id)}`
 *      (the de-facto Vercel AI SDK convention `@ai-sdk/openai`,
 *      `@ai-sdk/anthropic`, and OpenCode `aisdk`-type plugins all follow);
 *   2. the classic OpenCode plugin factory — `(input: PluginInput) => Hooks`,
 *      which is where the standardized `auth` (OAuth + API key) and `config`
 *      (model catalog) hooks live.
 *
 * Neither is plugin-specific, so nothing here knows about any particular
 * provider.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { OpenCodeHooks, OpenCodePluginFactory } from "./types.js"

export interface AiSdkLikeProvider {
  languageModel(modelId: string): LanguageModelV3
}

export type AiSdkFactory = (options?: Record<string, unknown>) => AiSdkLikeProvider | Promise<AiSdkLikeProvider>

function hasLanguageModelMethod(value: unknown): value is AiSdkLikeProvider {
  return typeof value === "object" && value !== null && typeof (value as { languageModel?: unknown }).languageModel === "function"
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function"
}

/** Resolve the AI-SDK provider factory from a loaded module's exports. */
export function detectAiSdkFactory(
  moduleExports: Record<string, unknown>,
  exportName?: string,
  packageSpecifier?: string,
): AiSdkFactory {
  if (exportName) {
    const named = moduleExports[exportName]
    if (isFunction(named)) return named as AiSdkFactory
    if (hasLanguageModelMethod(named)) return () => named
    throw new Error(`pi-bridge: export "${exportName}" is neither a factory function nor an object with .languageModel`)
  }

  const createExportNames = Object.keys(moduleExports).filter(name => /^create[A-Z]/.test(name) && isFunction(moduleExports[name]))
  if (createExportNames.length === 1) return moduleExports[createExportNames[0]!] as AiSdkFactory
  if (createExportNames.length > 1) {
    if (packageSpecifier) {
      const preferred = preferredFactoryName(packageSpecifier)
      if (preferred && createExportNames.includes(preferred)) return moduleExports[preferred] as AiSdkFactory
    }
    throw new Error(`pi-bridge: multiple createXxx exports found (${createExportNames.join(", ")}); set "factoryExport" to disambiguate`)
  }

  const rootCandidate = moduleExports.default ?? moduleExports
  if (hasLanguageModelMethod(rootCandidate)) return () => rootCandidate
  if (isFunction(rootCandidate)) return rootCandidate as AiSdkFactory

  throw new Error(
    "pi-bridge: could not detect an AI-SDK provider factory (no createXxx export, and the default/root export has no .languageModel); set \"factoryExport\" explicitly",
  )
}

/**
 * Resolve the classic OpenCode plugin factory, if the package has one.
 * Returns `undefined` rather than throwing: a plugin without one is still
 * usable (it just supplies no auth/model hooks), so the caller decides whether
 * that is fatal.
 */
export function detectPluginFactory(
  moduleExports: Record<string, unknown>,
  options: { exportName?: string; exclude?: unknown; packageSpecifier?: string } = {},
): OpenCodePluginFactory | undefined {
  if (options.exportName) {
    const named = moduleExports[options.exportName]
    if (!isFunction(named)) {
      throw new Error(`pi-bridge: export "${options.exportName}" is not a function, so it cannot be an OpenCode plugin factory`)
    }
    return named as OpenCodePluginFactory
  }

  // Convention: OpenCode plugin factories are named `<Something>Plugin`.
  const pluginNamed = Object.keys(moduleExports).filter(name => /Plugin$/.test(name) && isFunction(moduleExports[name]))
  if (pluginNamed.length === 1) return moduleExports[pluginNamed[0]!] as OpenCodePluginFactory
  if (pluginNamed.length > 1) {
    if (options.packageSpecifier) {
      const preferred = preferredPluginName(options.packageSpecifier)
      if (preferred && pluginNamed.includes(preferred)) return moduleExports[preferred] as OpenCodePluginFactory
    }
    throw new Error(`pi-bridge: multiple *Plugin exports found (${pluginNamed.join(", ")}); set "pluginExport" to disambiguate`)
  }

  // Fall back to a default export, as long as it isn't the AI-SDK factory we already found.
  const fallback = moduleExports.default
  if (isFunction(fallback) && fallback !== options.exclude) return fallback as OpenCodePluginFactory
  return undefined
}

export type LoadedOpenCodePlugin = {
  moduleExports: Record<string, unknown>
  factory: AiSdkFactory
  pluginFactory?: OpenCodePluginFactory
}

export function inspectOpenCodePluginModule(
  moduleExports: Record<string, unknown>,
  spec: { packageSpecifier: string; factoryExport?: string; pluginExport?: string },
): LoadedOpenCodePlugin {
  const factory = detectAiSdkFactory(moduleExports, spec.factoryExport, spec.packageSpecifier)
  const pluginFactory = detectPluginFactory(moduleExports, {
    exportName: spec.pluginExport,
    exclude: factory,
    packageSpecifier: spec.packageSpecifier,
  })
  return { moduleExports, factory, pluginFactory }
}

/** Dynamically import a plugin package and detect both conventions on it. */
export async function loadOpenCodePluginModule(spec: {
  packageSpecifier: string
  factoryExport?: string
  pluginExport?: string
}): Promise<LoadedOpenCodePlugin> {
  const moduleExports = (await import(spec.packageSpecifier)) as Record<string, unknown>
  return inspectOpenCodePluginModule(moduleExports, spec)
}

/** Invoke a plugin factory and sanity-check that it produced a hooks-shaped object. */
export async function instantiateHooks(pluginFactory: OpenCodePluginFactory, input: unknown): Promise<OpenCodeHooks> {
  const hooks = await pluginFactory(input)
  if (!hooks || typeof hooks !== "object") {
    throw new Error("pi-bridge: OpenCode plugin factory did not return a hooks object")
  }
  return hooks as OpenCodeHooks
}

/**
 * Derive a stable, sanitized default identifier from a package specifier —
 * `"cursor-opencode-provider"` → itself, `"@foo/bar"` → `"foo-bar"`, a path or
 * `file://` URL → its basename without extension (weak; prefer an explicit
 * `providerName` for path specifiers, which are per-machine).
 */
export function derivePackageName(packageSpecifier: string): string {
  const withoutExt = packageSpecifier.replace(/\.(m?js|c?js|ts)$/, "")
  const isPathOrUrl = /^[./]|:\/\//.test(packageSpecifier)
  const base = isPathOrUrl ? (withoutExt.split("/").filter(Boolean).pop() ?? withoutExt) : withoutExt.replace(/^@/, "")
  return base.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase()
}

function toPascalCase(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase()
}

function preferredNameStem(packageSpecifier: string): string | undefined {
  const derived = derivePackageName(packageSpecifier)
  if (derived && derived !== "index" && derived !== "dist" && derived !== "src") {
    return derived.split("-")[0]
  }
  const parts = packageSpecifier.replace(/\\/g, "/").split("/").filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!.replace(/\.(m?js|c?js|ts)$/, "")
    if (part && part !== "index" && part !== "dist" && part !== "src") return part.split("-")[0]
  }
  return undefined
}

function preferredFactoryName(packageSpecifier: string): string | undefined {
  const stem = preferredNameStem(packageSpecifier)
  if (!stem) return undefined
  return `create${toPascalCase(stem)}`
}

function preferredPluginName(packageSpecifier: string): string | undefined {
  const stem = preferredNameStem(packageSpecifier)
  if (!stem) return undefined
  return `${toPascalCase(stem)}Plugin`
}

/** Recursively substitute the literal string `"$apiKey"` anywhere in a JSON-shaped value. */
export function substituteApiKey(value: unknown, apiKey: string | undefined): unknown {
  if (value === "$apiKey") return apiKey
  if (Array.isArray(value)) return value.map(v => substituteApiKey(v, apiKey))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteApiKey(v, apiKey)]))
  }
  return value
}
