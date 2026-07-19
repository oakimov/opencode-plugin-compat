/**
 * Facade path for `@opencode-ai/plugin/tui`.
 *
 * Runtime values are loaded lazily from the host’s native plugin `./tui`.
 * Portable type stubs cover the common TuiPlugin* surface for type-only imports.
 */
import { importNativePlugin } from "@opencode-compat/adapter"

export const PKG_TUI = "@opencode-compat/facade-plugin/tui" as const

/** Loose portable stubs — full fidelity comes from native host tui. */
export type TuiPlugin = (
  api: TuiPluginApi,
  options: Record<string, unknown> | undefined,
  meta: TuiPluginMeta,
) => Promise<void>

export type TuiPluginModule = {
  id?: string
  tui: TuiPlugin
  server?: never
}

export type TuiPluginState = "first" | "updated" | "same"

export type TuiPluginEntry = {
  id: string
  source: "file" | "npm" | "internal"
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
}

export type TuiPluginMeta = TuiPluginEntry & {
  state: TuiPluginState
}

export type TuiPluginApi = {
  [key: string]: unknown
}

type NativeTui = Record<string, unknown>

let nativePromise: Promise<NativeTui> | undefined
let nativeCache: NativeTui | undefined

export function getNativeTui(): Promise<NativeTui> {
  nativePromise ??= importNativePlugin("tui")
    .then((mod) => {
      nativeCache = mod
      return mod
    })
    .catch((err: unknown) => {
      nativePromise = undefined
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${PKG_TUI}: failed to load host native ./tui — ${message}. ` +
          "Ensure a cooperating host (opencode/mimo/kilo) is detected and its plugin package is installed.",
      )
    })
  return nativePromise
}

function bind(name: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    if (!nativeCache) {
      throw new Error(
        `${PKG_TUI}: native tui not loaded yet — call await getNativeTui() first, or use getNativeTui() for full exports. Missing eager bind: ${name}`,
      )
    }
    const value = nativeCache[name]
    if (typeof value !== "function") {
      throw new Error(`${PKG_TUI}: native export missing: ${name}`)
    }
    return (value as (...a: unknown[]) => unknown)(...args)
  }
}

/**
 * Async helpers that load native then invoke.
 * Prefer these over the sync binds when the host plugin may not be preloaded.
 */
export async function createBindingLookup(
  ...args: unknown[]
): Promise<unknown> {
  const native = await getNativeTui()
  const fn = native.createBindingLookup
  if (typeof fn !== "function") {
    throw new Error(`${PKG_TUI}: native export missing: createBindingLookup`)
  }
  return (fn as (...a: unknown[]) => unknown)(...args)
}

export async function stringifyKeySequence(
  ...args: unknown[]
): Promise<unknown> {
  const native = await getNativeTui()
  const fn = native.stringifyKeySequence
  if (typeof fn !== "function") {
    throw new Error(`${PKG_TUI}: native export missing: stringifyKeySequence`)
  }
  return (fn as (...a: unknown[]) => unknown)(...args)
}

export async function stringifyKeyStroke(
  ...args: unknown[]
): Promise<unknown> {
  const native = await getNativeTui()
  const fn = native.stringifyKeyStroke
  if (typeof fn !== "function") {
    throw new Error(`${PKG_TUI}: native export missing: stringifyKeyStroke`)
  }
  return (fn as (...a: unknown[]) => unknown)(...args)
}

export async function formatCommandBindings(
  ...args: unknown[]
): Promise<unknown> {
  const native = await getNativeTui()
  const fn = native.formatCommandBindings
  if (typeof fn !== "function") {
    throw new Error(`${PKG_TUI}: native export missing: formatCommandBindings`)
  }
  return (fn as (...a: unknown[]) => unknown)(...args)
}

export async function formatKeySequence(
  ...args: unknown[]
): Promise<unknown> {
  const native = await getNativeTui()
  const fn = native.formatKeySequence
  if (typeof fn !== "function") {
    throw new Error(`${PKG_TUI}: native export missing: formatKeySequence`)
  }
  return (fn as (...a: unknown[]) => unknown)(...args)
}

/** @deprecated Sync bind requires prior getNativeTui(); prefer async helpers. */
export const createBindingLookupSync = bind("createBindingLookup")
