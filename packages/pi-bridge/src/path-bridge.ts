/**
 * Install the same structural host-path surface as the OpenCode-clone adapter,
 * so an unmodified OpenCode provider resolves project/global config dirs under
 * `.omp` / `.pi` instead of inventing `.opencode`.
 *
 * Kept inside pi-bridge rather than importing `@opencode-compat/adapter` — the
 * Pi family deliberately stays a separate package graph from the clone path.
 */
import { homedir } from "node:os"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { PiHostId } from "./host/profile.js"
import {
  currentRecordedHostSkills,
  installHostSkillsBridge,
  recordHostSkillCatalogText,
  type HostSkill,
} from "@opencode-compat/opencode-loader"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => path.resolve(value)),
    ),
  ]
}

function homeDir(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || homedir()
}

let hostAgentDir: { hostId: PiHostId; resolve: () => string } | undefined

/**
 * Manifest-selected host entries inject the host's own agent-dir resolver
 * (pi: `getAgentDir()` from its `@earendil-works/pi-coding-agent` virtual
 * module), so the bridge follows the host rather than re-deriving its layout.
 */
export function installPiHostAgentDir(hostId: PiHostId, resolve: () => string): void {
  hostAgentDir = { hostId, resolve }
}

/** Test hook: forget the injected host agent-dir resolver. */
export function resetPiHostAgentDir(): void {
  hostAgentDir = undefined
}

function agentRoot(id: PiHostId, env: Record<string, string | undefined>): string {
  if (hostAgentDir?.hostId === id) {
    const dir = hostAgentDir.resolve()
    if (typeof dir === "string" && dir.trim()) return path.resolve(dir)
  }
  if (env.PI_CODING_AGENT_DIR) return path.resolve(env.PI_CODING_AGENT_DIR)
  const configDir = env.PI_CONFIG_DIR || (id === "pi" ? ".pi" : ".omp")
  return path.join(homeDir(env), configDir, "agent")
}

/** Install path bridge for the running Pi-family host. Idempotent. */
export function installPiPathBridge(
  id: PiHostId,
  env: Record<string, string | undefined> = process.env,
): void {
  const projectName = id === "pi" ? ".pi" : ".omp"
  const globalRoot = agentRoot(id, env)
  const cacheRoot = path.join(globalRoot, "cache", "opencode-providers")
  const fallbackCwd = process.cwd()
  const bridge = {
    globalDataDir() {
      return globalRoot
    },
    globalCacheDir() {
      return cacheRoot
    },
    projectConfigDirs(workspaceRoot: string) {
      const root = path.resolve(workspaceRoot || fallbackCwd)
      return unique([path.join(root, projectName)])
    },
    globalConfigDirs() {
      return unique([globalRoot])
    },
    configFileNames: ["settings.json", "pi-bridge.json"],
  }
  ;(globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] = bridge
  ;(globalThis as typeof globalThis & Record<typeof LEGACY_PATH_BRIDGE_KEY, unknown>)[LEGACY_PATH_BRIDGE_KEY] = bridge
  installHostSkillsBridge(async () => {
    const recorded = currentRecordedHostSkills()
    return recorded.length > 0 ? recorded : skillsFromFiles([path.join(globalRoot, "skills")])
  })
}

export { recordHostSkillCatalogText }

/**
 * Host plan directory: `<globalDataDir()>/plans` of the installed path bridge —
 * the same location the consumer provider computes from that bridge.
 */
export function piHostPlansDir(): string {
  const bridge = (globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] as
    | { globalDataDir?: () => string }
    | undefined
  const root = bridge?.globalDataDir?.()
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("pi-bridge: host path bridge is not installed; cannot resolve the host plans directory")
  }
  return path.join(root, "plans")
}

function skillsFromFiles(roots: readonly string[]): HostSkill[] {
  const out: HostSkill[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const file = path.join(dir, name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        visit(file, depth + 1)
        continue
      }
      if (!name.endsWith(".md")) continue
      const text = readFileSync(file, "utf8")
      const description = frontmatterValue(text, "description") ?? headingDescription(text)
      if (!description) continue
      out.push({
        name: frontmatterValue(text, "name") ?? path.basename(file).replace(/\.md$/i, ""),
        description,
        location: path.resolve(file),
      })
    }
  }
  for (const root of roots) visit(root, 0)
  return out
}

function frontmatterValue(text: string, key: string): string | undefined {
  if (!text.startsWith("---")) return undefined
  const end = text.indexOf("\n---", 3)
  if (end < 0) return undefined
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const at = line.indexOf(":")
    if (at < 0 || line.slice(0, at).trim() !== key) continue
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "")
    return value || undefined
  }
  return undefined
}

function headingDescription(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("#") && trimmed !== "---") return trimmed
  }
  return undefined
}
