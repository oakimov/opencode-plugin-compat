/**
 * Shim / wirePromiseV2 entry for clone-host skills install.
 * `installPathBridge` already installs `opencode.host.skills` for mimo/kilo;
 * this re-installs only when that symbol is missing (call-order safety).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  currentRecordedHostSkills,
  hostSkillsBridge,
  installHostSkillsBridge,
  projectPathDescSkills,
  type HostSkill,
} from "@opencode-compat/opencode-loader"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")

type PathBridge = {
  projectConfigDirs?: (workspaceRoot: string) => string[]
  globalConfigDirs?: () => string[]
}

function pathBridge(): PathBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]
  return value && typeof value === "object" ? (value as PathBridge) : undefined
}

function readFrontmatter(file: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(file, "utf8")
    if (!text.startsWith("---")) return {}
    const end = text.indexOf("\n---", 3)
    if (end < 0) return {}
    const block = text.slice(3, end)
    let name: string | undefined
    let description: string | undefined
    for (const line of block.split("\n")) {
      const match = line.match(/^(\w+):\s*(.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2]!.trim().replace(/^["']|["']$/g, "")
      if (key === "name") name = value
      if (key === "description") description = value
    }
    return { name, description }
  } catch {
    return {}
  }
}

function walkSkillFiles(root: string, out: HostSkill[], seen: Set<string>): void {
  if (!existsSync(root)) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const full = path.join(root, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkSkillFiles(full, out, seen)
      continue
    }
    if (!st.isFile()) continue
    if (entry !== "SKILL.md" && entry !== "skill.md") continue
    const meta = readFrontmatter(full)
    const name = meta.name || path.basename(path.dirname(full))
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      description: meta.description || name,
      location: full,
    })
  }
}

async function listCloneSkills(input: { directory: string }): Promise<HostSkill[]> {
  const recorded = currentRecordedHostSkills()
  if (recorded.length > 0) return recorded
  const bridge = pathBridge()
  const roots = [
    ...(bridge?.projectConfigDirs?.(input.directory) ?? []),
    ...(bridge?.globalConfigDirs?.() ?? []),
  ]
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    walkSkillFiles(path.join(root, "skills"), out, seen)
    walkSkillFiles(path.join(root, "skill"), out, seen)
  }
  return projectPathDescSkills(out)
}

/** Install skills bridge for MiMo/Kilo when path bridge has not already. */
export function installSkillsBridge(id: string): void {
  if (id !== "mimo" && id !== "kilo") return
  if (hostSkillsBridge()) return
  installHostSkillsBridge(async (input) => listCloneSkills(input))
}
