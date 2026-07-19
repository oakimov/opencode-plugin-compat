/**
 * @opencode-compat/adapter — universal host adapter.
 * Autodetect HostProfile; dispatch to native SDK. No per-host publishable packages.
 * See docs/ocp/0.1.md and docs/plans/.
 */
export const PKG = "@opencode-compat/adapter" as const
export const VERSION = "0.1.0" as const

export {
  detect,
  type DetectOptions,
  type DetectResult,
  type HostId,
  type HostProfile,
} from "@opencode-compat/profile"

export {
  createPromiseV2Host,
  define as definePromisePlugin,
  runPromisePlugin,
  type LanguageModelInput,
  type LanguageModelV3Like,
  type Plugin as PromiseV2Plugin,
  type PluginContext,
  type PromiseV2Host,
} from "@opencode-compat/host-promise-v2"

import {
  createPromiseV2Host,
  type PromiseV2Host,
} from "@opencode-compat/host-promise-v2"
import {
  detect,
  formatProfileSummary,
  privacyGuideHint,
  type DetectOptions,
  type DetectResult,
  type HostProfile,
} from "@opencode-compat/profile"

/** Resolve the active host profile (throws if OCP load is not supported). */
export function requireHost(options?: DetectOptions): HostProfile {
  const result = detect(options)
  if (!result.supported) {
    throw new Error(result.message ?? `OCP: host ${result.id} is not supported`)
  }
  return result.profile
}

/**
 * Wire OCP-layer Promise v2 host kit for the active profile.
 * Call `host.register(plugin)` then `host.resolveProvider(input)` at
 * provider-resolve time (sidecar / operator helper — no host source edits).
 */
export function wirePromiseV2(
  options?: DetectOptions & { pluginOptions?: Record<string, unknown> },
): PromiseV2Host {
  const profile = requireHost(options)
  if (!profile.capabilities.promiseV2) {
    throw new Error(
      `${PKG}: Promise v2 not available on host "${profile.id}". ` +
        "See docs/ocp/0.1.md §7.",
    )
  }
  return createPromiseV2Host(options?.pluginOptions ?? {})
}

/** Native package names for the detected (or given) profile. */
export function nativePackages(profile: HostProfile): {
  plugin: string
  sdk: string
} {
  return {
    plugin: profile.nativePlugin,
    sdk: profile.nativeSdk,
  }
}

/**
 * Whether a portable classic hook should be treated as a no-op gap
 * (accept on facade, warn via doctor) on this host.
 */
export function isNoopHookGap(profile: HostProfile, hook: string): boolean {
  return profile.hooks.missing.includes(hook)
}

/** Warnings for hooks present on a plugin that the host cannot invoke. */
export function missingHookWarnings(
  profile: HostProfile,
  hooks: Record<string, unknown>,
): string[] {
  const warnings: string[] = []
  for (const name of profile.hooks.missing) {
    if (hooks[name] != null) {
      warnings.push(
        `OCP: host "${profile.id}" missing hook "${name}" — accepted as no-op (compat gap)`,
      )
    }
  }
  return warnings
}

/**
 * Normalize classic hooks for the active host: keep portable hooks, surface
 * doctor warnings for MiMo gaps, strip non-portable extension keys from the
 * portable path (extensions stay host-only).
 */
export function normalizeHooks<T extends Record<string, unknown>>(
  hooks: T,
  profile: HostProfile,
  options?: { onWarn?: (message: string) => void },
): T {
  for (const message of missingHookWarnings(profile, hooks)) {
    options?.onWarn?.(message)
  }
  return hooks
}

/** Build a specifier for a native plugin subpath (e.g. `@mimo-ai/plugin/tui`). */
export function nativePluginSpecifier(
  subpath?: string,
  options?: DetectOptions,
): string {
  const profile = requireHost(options)
  const base = profile.nativePlugin
  if (!subpath || subpath === "." || subpath === "") return base
  const cleaned = subpath.replace(/^\.\//, "").replace(/^\//, "")
  return `${base}/${cleaned}`
}

/** Build a specifier for a native SDK subpath. */
export function nativeSdkSpecifier(
  subpath?: string,
  options?: DetectOptions,
): string {
  const profile = requireHost(options)
  const base = profile.nativeSdk
  if (!subpath || subpath === "." || subpath === "") return base
  const cleaned = subpath.replace(/^\.\//, "").replace(/^\//, "")
  return `${base}/${cleaned}`
}

export type ImportNativeOptions = DetectOptions & {
  /** Optional custom importer (tests). */
  importer?: (specifier: string) => Promise<Record<string, unknown>>
}

async function dynamicImport(
  specifier: string,
  importer?: ImportNativeOptions["importer"],
): Promise<Record<string, unknown>> {
  if (importer) return importer(specifier)
  try {
    const mod = await import(specifier)
    return mod as Record<string, unknown>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${PKG}: failed to import native module ${JSON.stringify(specifier)}: ${message}`,
    )
  }
}

/** Dynamically import the host’s native plugin package (optional subpath). */
export async function importNativePlugin(
  subpath?: string,
  options?: ImportNativeOptions,
): Promise<Record<string, unknown>> {
  const specifier = nativePluginSpecifier(subpath, options)
  return dynamicImport(specifier, options?.importer)
}

/** Dynamically import the host’s native SDK package (optional subpath). */
export async function importNativeSdk(
  subpath?: string,
  options?: ImportNativeOptions,
): Promise<Record<string, unknown>> {
  const specifier = nativeSdkSpecifier(subpath, options)
  return dynamicImport(specifier, options?.importer)
}

/**
 * Wrap a classic plugin so returned hooks are normalized for the detected host.
 * The OCP layer / host kit may call this when loading `@opencode-ai/plugin` plugins via the bridge.
 */
export function wrapClassicPlugin<
  TInput,
  THooks extends Record<string, unknown>,
>(
  plugin: (input: TInput, options?: Record<string, unknown>) => Promise<THooks>,
  options?: DetectOptions & { onWarn?: (message: string) => void },
): (input: TInput, pluginOptions?: Record<string, unknown>) => Promise<THooks> {
  const profile = requireHost(options)
  return async (input, pluginOptions) => {
    const hooks = await plugin(input, pluginOptions)
    return normalizeHooks(hooks, profile, { onWarn: options?.onWarn })
  }
}

/** Adapter-facing doctor report built on profile detect(). */
export function doctorReport(options?: DetectOptions): {
  ok: boolean
  result: DetectResult
  summary: string
} {
  const result = detect(options)
  const privacy = privacyGuideHint(result.id)
  const summary = [
    formatProfileSummary(result.profile),
    `source: ${result.source}`,
    `supported: ${result.supported}`,
    result.message ? `message: ${result.message}` : undefined,
    privacy,
  ]
    .filter(Boolean)
    .join("\n")
  return {
    ok: result.supported,
    result,
    summary,
  }
}