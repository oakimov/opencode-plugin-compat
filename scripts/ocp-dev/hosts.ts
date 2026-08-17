import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOSTS = ["opencode", "mimo", "kilo", "pi", "omp"] as const
export type HostId = (typeof HOSTS)[number]
export type HostFamily = "clone" | "pi"
export type WireMode = "local" | "npm"

export function isHostId(value: string): value is HostId {
  return (HOSTS as readonly string[]).includes(value)
}

export function familyOf(host: HostId): HostFamily {
  return host === "pi" || host === "omp" ? "pi" : "clone"
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export function configDir(host: HostId): string {
  switch (host) {
    case "opencode":
      return env("OPENCODE_CONFIG_DIR") ?? join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "opencode")
    case "mimo":
      return env("MIMOCODE_HOME") ? join(env("MIMOCODE_HOME")!, "config")
        : join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "mimocode")
    case "kilo":
      return env("KILO_CONFIG_DIR") ?? join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "kilo")
    case "pi":
      return env("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent")
    case "omp":
      return env("PI_CODING_AGENT_DIR") ?? join(homedir(), ".omp", "agent")
  }
}

export function configCandidates(host: HostId): string[] {
  if (host === "pi" || host === "omp") {
    if (env("PI_BRIDGE_CONFIG")) return [env("PI_BRIDGE_CONFIG")!]
    return [join(configDir(host), "pi-bridge.json")]
  }
  const dir = configDir(host)
  if (host === "mimo") return [join(dir, "mimocode.json"), join(dir, "mimocode.jsonc")]
  if (host === "kilo") {
    return ["kilo.jsonc", "kilo.json", "opencode.json", "opencode.jsonc", "config.json"].map((name) => join(dir, name))
  }
  return [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]
}

export function configFile(host: HostId): string {
  const candidates = configCandidates(host)
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!
}

export function packagesDir(host: Exclude<HostId, "pi" | "omp">): string {
  if (host === "mimo" && env("MIMOCODE_HOME")) return join(env("MIMOCODE_HOME")!, "cache", "packages")
  const cacheRoot = env("XDG_CACHE_HOME") ?? join(homedir(), ".cache")
  const app = host === "mimo" ? "mimocode" : host
  return join(cacheRoot, app, "packages")
}

const FALLBACK_CLI: Record<HostId, string> = {
  opencode: join(homedir(), ".opencode", "bin", "opencode"),
  mimo: join(homedir(), ".mimocode", "bin", "mimo"),
  kilo: join(homedir(), ".local", "bin", "kilo"),
  pi: "/opt/local/bin/pi",
  omp: join(homedir(), ".bun", "bin", "omp"),
}

export async function resolveCli(host: HostId): Promise<string> {
  const found = Bun.which(host)
  if (found) return found
  const fallback = FALLBACK_CLI[host]
  if (existsSync(fallback)) return fallback
  throw new Error(`${host} CLI not found on PATH (tried ${fallback})`)
}

export async function isInstalled(host: HostId): Promise<boolean> {
  try {
    await resolveCli(host)
    return true
  } catch {
    return false
  }
}

export async function installedHosts(): Promise<HostId[]> {
  const found: HostId[] = []
  for (const host of HOSTS) {
    if (await isInstalled(host)) found.push(host)
  }
  return found
}
