import { access, readdir } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import {
  sanitizeCommandMarkdown,
  sanitizeSkillMarkdown,
} from "./markdown"
import type {
  FoundCommand,
  FoundManifest,
  FoundSkill,
  ManifestKind,
  PluginScan,
} from "./types"

function toPosix(p: string): string {
  return p.split(sep).join("/")
}

/** True for files or directories (Bun.file().exists() is file-only). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(path))) return undefined
  try {
    const text = await Bun.file(path).text()
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

async function loadManifest(
  pluginDir: string,
  relDir: string,
  kind: ManifestKind,
): Promise<FoundManifest | undefined> {
  const path = join(pluginDir, relDir, "plugin.json")
  const raw = await readJsonObject(path)
  if (!raw) return undefined
  return { kind, path, raw }
}

/**
 * Scan a plugin package for migratable marketplace assets.
 * Does not execute JS. Ignores host MCP config.
 */
export async function scanPluginPackage(pluginDir: string): Promise<PluginScan> {
  const pkg = await readJsonObject(join(pluginDir, "package.json"))
  const packageName =
    typeof pkg?.name === "string" ? pkg.name : undefined
  const packageVersion =
    typeof pkg?.version === "string" ? pkg.version : undefined

  const manifests: FoundManifest[] = []
  for (const [rel, kind] of [
    [".zcode-plugin", "zcode-plugin"],
    [".claude-plugin", "claude-plugin"],
    [".codex-plugin", "codex-plugin"],
  ] as const) {
    const m = await loadManifest(pluginDir, rel, kind)
    if (m) manifests.push(m)
  }

  const marketplacePath = join(pluginDir, ".zcode-plugin", "marketplace.json")
  const marketplaceRoot = join(pluginDir, "marketplace.json")
  for (const path of [marketplacePath, marketplaceRoot]) {
    const raw = await readJsonObject(path)
    if (raw) {
      manifests.push({ kind: "marketplace", path, raw })
    }
  }

  const skills: FoundSkill[] = []
  const skillRoot = join(pluginDir, "skills")
  if (await pathExists(skillRoot)) {
    const files = await walkFiles(skillRoot)
    for (const absPath of files) {
      if (!absPath.endsWith(".md")) continue
      const base = basename(absPath, ".md")
      const parent = basename(dirname(absPath))
      // SKILL.md → use parent dir name; otherwise use file stem.
      const fallback =
        base.toLowerCase() === "skill" ? parent : base
      const text = await Bun.file(absPath).text()
      const sanitized = sanitizeSkillMarkdown(text, fallback)
      skills.push({
        relPath: `skills/${sanitized.name}/SKILL.md`,
        absPath,
        name: sanitized.name,
        description: sanitized.description,
        body: sanitized.content,
      })
    }
  }

  const commands: FoundCommand[] = []
  const commandRoot = join(pluginDir, "commands")
  if (await pathExists(commandRoot)) {
    const files = await walkFiles(commandRoot)
    for (const absPath of files) {
      if (!absPath.endsWith(".md")) continue
      const fallback = basename(absPath, ".md")
      const text = await Bun.file(absPath).text()
      const sanitized = sanitizeCommandMarkdown(text, fallback)
      commands.push({
        relDir: toPosix(relative(pluginDir, absPath)),
        absPath,
        fileName: `${sanitized.name}.md`,
        name: sanitized.name,
        description: sanitized.description,
        body: sanitized.content,
        droppedFrontmatter: sanitized.dropped,
      })
    }
  }

  const jsEntrypoints: string[] = []
  if (typeof pkg?.main === "string") jsEntrypoints.push(pkg.main)
  if (pkg && isRecord(pkg.exports)) {
    const exp = pkg.exports["."]
    if (typeof exp === "string") jsEntrypoints.push(exp)
    else if (isRecord(exp) && typeof exp.import === "string") {
      jsEntrypoints.push(exp.import)
    }
  }

  return {
    pluginDir,
    packageName,
    packageVersion,
    skills,
    commands,
    manifests,
    jsEntrypoints,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}