import { homedir } from "node:os"
import path from "node:path"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

export type RuntimeToolRoles = {
  tools?: {
    subagent?: string
    todoWrite?: string
    todoRead?: string
    question?: string
    planEnter?: string
    planExit?: string
  }
}

/** Per-host tool-role overrides needed by the zero-dep install-tree runtime. */
export function toolRolesForHostId(id: string): RuntimeToolRoles | undefined {
  switch (id) {
    case "mimo":
      return { tools: { subagent: "actor", todoWrite: "task", todoRead: "task" } }
    default:
      return undefined
  }
}

function hasEnvMarker(env: Record<string, string | undefined>, name: string): boolean {
  if (env[name]) return true
  const prefix = `${name}_`
  return Object.keys(env).some((key) => key.startsWith(prefix) && env[key])
}

function binaryTokens(argv: readonly unknown[], execPath?: unknown): string[] {
  return [...argv, execPath ?? ""].map((value) =>
    String(value).split(/[\\/]/).pop()?.toLowerCase() ?? "",
  )
}

export function detectHostId(
  env: Record<string, string | undefined> = process.env,
  argv: readonly unknown[] = process.argv,
  execPath: unknown = process.execPath,
  hostHint = "",
): string {
  const forced = env.OPENCODE_COMPAT_HOST
  if (typeof forced === "string" && forced.trim()) return forced.trim().toLowerCase()

  const tokens = binaryTokens(argv, execPath)
  if (tokens.some((token) => token === "mimo" || token === "mimocode" || token.startsWith("mimo-") || token.includes("mimocode"))) return "mimo"
  if (tokens.some((token) => token === "kilo" || token === "kilocode" || token.startsWith("kilo-") || token.includes("kilocode"))) return "kilo"
  if (tokens.some((token) => token === "opencode" || token.startsWith("opencode-") || token.includes("opencode"))) return "opencode"

  if (hasEnvMarker(env, "MIMOCODE")) return "mimo"
  if (hasEnvMarker(env, "KILO")) return "kilo"
  if (env.OPENCODE_CONFIG_DIR) return "opencode"

  const fallback = typeof hostHint === "string" ? hostHint.trim().toLowerCase() : ""
  if (fallback === "mimo" || fallback === "kilo" || fallback === "opencode") return fallback
  return "unknown"
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => path.resolve(value)))]
}

function xdgConfig(env: Record<string, string | undefined>): string {
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(env.HOME || env.USERPROFILE || homedir(), ".config")
}

function xdgData(env: Record<string, string | undefined>): string {
  return env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : path.join(env.HOME || env.USERPROFILE || homedir(), ".local", "share")
}

function xdgCache(env: Record<string, string | undefined>): string {
  return env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
    ? env.XDG_CACHE_HOME
    : path.join(env.HOME || env.USERPROFILE || homedir(), ".cache")
}

function hostConfigRoot(id: string, env: Record<string, string | undefined>): string {
  if (id === "mimo") {
    if (env.MIMOCODE_CONFIG_DIR) return path.resolve(env.MIMOCODE_CONFIG_DIR)
    if (env.MIMOCODE_HOME) return path.resolve(env.MIMOCODE_HOME, "config")
    return path.join(xdgConfig(env), "mimocode")
  }
  if (id === "kilo") {
    if (env.KILO_CONFIG_DIR) return path.resolve(env.KILO_CONFIG_DIR)
    return path.join(xdgConfig(env), "kilo")
  }
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR)
  return path.join(xdgConfig(env), "opencode")
}

function hostProjectNames(id: string): string[] {
  if (id === "mimo") return [".mimocode"]
  if (id === "kilo") return [".kilo", ".kilocode"]
  return [".opencode"]
}

function hostConfigFiles(id: string): string[] {
  if (id === "mimo") return ["config.json", "mimocode.json", "mimocode.jsonc"]
  if (id === "kilo") return ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"]
  return ["opencode.json", "opencode.jsonc"]
}

/** Install native host paths for an unchanged OpenCode plugin before it loads. */
export function installPathBridge(id: string, env: Record<string, string | undefined> = process.env): void {
  if (id !== "opencode" && id !== "mimo" && id !== "kilo") return
  const globalRoot = hostConfigRoot(id, env)
  const app = id === "mimo" ? "mimocode" : id
  const dataRoot = id === "mimo" && env.MIMOCODE_HOME
    ? path.resolve(env.MIMOCODE_HOME)
    : path.join(xdgData(env), app)
  const cacheRoot = id === "mimo" && env.MIMOCODE_HOME
    ? path.resolve(env.MIMOCODE_HOME, "cache")
    : path.join(xdgCache(env), app)
  const fallbackCwd = process.cwd()
  const bridge = {
    globalDataDir() {
      return dataRoot
    },
    globalCacheDir() {
      return cacheRoot
    },
    projectConfigDirs(workspaceRoot: string) {
      const root = path.resolve(workspaceRoot || fallbackCwd)
      return unique(hostProjectNames(id).map((name) => path.join(root, name)))
    },
    globalConfigDirs() {
      return unique([globalRoot])
    },
    configFileNames: hostConfigFiles(id),
  }
  ;(globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] = bridge
  // Transitional compatibility for unchanged providers published before the
  // structural host contract was renamed. Remove after those releases age out.
  ;(globalThis as typeof globalThis & Record<typeof LEGACY_PATH_BRIDGE_KEY, unknown>)[LEGACY_PATH_BRIDGE_KEY] = bridge
}
