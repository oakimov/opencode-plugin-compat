/**
 * Structural host-skills capability installed before an unchanged OpenCode
 * provider loads. Same install timing as `opencode.host.path-bridge`.
 *
 * Wire shape: `{ name, description, location? }` — no
 * skill body. Built-in / marker locations are omitted by the provider.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { fileURLToPath } from "node:url"

export const HOST_SKILLS_BRIDGE = Symbol.for("opencode.host.skills")

export type HostSkill = {
  name: string
  id?: string
  description: string
  /** Absolute path, `file:` URL, or host URI (`skill://…`). Omit built-ins. */
  location?: string
}

export type OpenCodeSkillsBridge = {
  list(input: { directory: string; sessionID?: string }): Promise<HostSkill[]>
}

const MARKERS = new Set(["<built-in>", "builtin"])
// Install-tree bundles share one global reader, so its async request context
// must also be shared. Keep the key versioned as this crosses module copies.
const REQUEST_SKILLS_CONTEXT = Symbol.for("opencode.host.skills.request-context.v1")
const shared = globalThis as typeof globalThis & {
  [REQUEST_SKILLS_CONTEXT]?: AsyncLocalStorage<readonly HostSkill[]>
}
const requestSkills = shared[REQUEST_SKILLS_CONTEXT] ??= new AsyncLocalStorage<readonly HostSkill[]>()

export function isUsableSkillLocation(location: string | undefined): boolean {
  if (typeof location !== "string") return false
  const value = location.trim()
  if (!value) return false
  if (MARKERS.has(value)) return false
  if (value.startsWith("/builtin/")) return false
  return true
}

export function normalizeSkillLocation(location: string): string {
  const value = location.trim()
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value)
    } catch {
      return value
    }
  }
  return value
}

/** Scope the host's advertised catalog to this provider request and its async work. */
export function withHostSkills<T>(skills: readonly HostSkill[], run: () => T): T {
  return requestSkills.run(projectPathDescSkills(skills), run)
}

export function currentRecordedHostSkills(): HostSkill[] {
  return projectPathDescSkills(requestSkills.getStore() ?? [])
}

/** Install or replace the process-wide skills bridge. */
export function installHostSkillsBridge(
  bridge: OpenCodeSkillsBridge | ((input: { directory: string; sessionID?: string }) => Promise<HostSkill[]> | HostSkill[]),
): void {
  const installed: OpenCodeSkillsBridge = typeof bridge === "function"
    ? { async list(input) { return projectPathDescSkills(await bridge(input)) } }
    : bridge
  ;(globalThis as Record<PropertyKey, unknown>)[HOST_SKILLS_BRIDGE] = installed
}

export function clearHostSkillsBridge(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[HOST_SKILLS_BRIDGE]
}

export function hostSkillsBridge(): OpenCodeSkillsBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[HOST_SKILLS_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodeSkillsBridge>
  return typeof bridge.list === "function" ? (bridge as OpenCodeSkillsBridge) : undefined
}

/** Scan tags without retrying an unbounded regex at every unmatched opener. */
function tagBodies(text: string, tag: string): string[] {
  const lower = text.replace(/[A-Z]/g, character => character.toLowerCase())
  const open = `<${tag}`
  const close = `</${tag}>`
  const out: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = lower.indexOf(open, cursor)
    if (start < 0) break
    cursor = start + open.length
    const boundary = lower[cursor]
    if (boundary !== ">" && boundary?.trim() !== "") continue
    const bodyStart = lower.indexOf(">", cursor)
    if (bodyStart < 0) break
    const end = lower.indexOf(close, bodyStart + 1)
    if (end < 0) break
    out.push(text.slice(bodyStart + 1, end))
    cursor = end + close.length
  }
  return out
}

function decodeXml(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity: string) => entities[entity]!)
}

function encodeXml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
  return value.replace(/[&<>"]/g, character => entities[character]!)
}

function tagText(entry: string, tag: string): string | undefined {
  const body = tagBodies(entry, tag)[0]
  return body === undefined ? undefined : decodeXml(body.trim())
}

/** Parse OpenCode-1-shaped `<available_skills>` into HostSkill rows. */
export function parseAvailableSkillsCatalog(text: string): HostSkill[] {
  const catalog = tagBodies(text, "available_skills")[0]
  if (!catalog) return []
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const entry of tagBodies(catalog, "skill")) {
    const name = tagText(entry, "name")
    const id = tagText(entry, "id")
    const description = tagText(entry, "description")
    const locationRaw = tagText(entry, "location")
    if (!name || seen.has(name)) continue
    seen.add(name)
    const location = locationRaw && isUsableSkillLocation(locationRaw)
      ? normalizeSkillLocation(locationRaw)
      : undefined
    out.push({
      name,
      ...(id ? { id } : {}),
      description: description ?? "",
      ...(location ? { location } : {}),
    })
  }
  return out
}

/** Render HostSkill rows as OpenCode-1 `<available_skills>` catalog text. */
export function formatAvailableSkillsCatalog(skills: readonly HostSkill[]): string {
  if (skills.length === 0) return ""
  const body = skills
    .map((skill) => {
      const location = skill.location && isUsableSkillLocation(skill.location)
        ? encodeXml(normalizeSkillLocation(skill.location))
        : encodeXml("<built-in>")
      return `<skill>\n<name>${encodeXml(skill.name)}</name>${skill.id ? `\n<id>${encodeXml(skill.id)}</id>` : ""}\n<description>${encodeXml(skill.description)}</description>\n<location>${location}</location>\n</skill>`
    })
    .join("\n")
  return `<available_skills>\n${body}\n</available_skills>`
}

/**
 * Convert DSH skill-catalog reminder lines
 * (`- \`name\`: description`) into HostSkill rows (no locations).
 */
export function parseDshSkillReminder(text: string): HostSkill[] {
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const line of text.split("\n")) {
    const bullet = line.trim()
    if (!bullet.startsWith("-")) continue
    const item = bullet.slice(1).trimStart()
    if (!item.startsWith("`")) continue
    const end = item.indexOf("`", 1)
    if (end < 0) continue
    const tail = item.slice(end + 1).trimStart()
    if (!tail.startsWith(":")) continue
    const name = item.slice(1, end).trim()
    const description = tail.slice(1).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, description })
  }
  return out
}

/**
 * Convert OMP `<skills>` bullet lines (`- name: description`) into HostSkill
 * rows with `skill://<name>` locations.
 */
export function parseOmpSkillsBlock(text: string): HostSkill[] {
  const block = tagBodies(text, "skills")[0]
  if (block === undefined) return []
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const line of block.split("\n")) {
    const bullet = line.trim()
    if (!bullet.startsWith("-")) continue
    let item = bullet.slice(1).trimStart()
    if (item.startsWith("`")) item = item.slice(1)
    if (item.startsWith("skill://")) item = item.slice("skill://".length)
    const colon = item.indexOf(":")
    if (colon < 0) continue
    const name = item.slice(0, colon).trim().replace(/`$/, "")
    if (name.includes("`")) continue
    const description = item.slice(colon + 1).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, description, location: `skill://${name}` })
  }
  return out
}

export function skillsFromCatalogText(text: string | undefined): HostSkill[] {
  if (!text) return []
  const c1 = parseAvailableSkillsCatalog(text)
  return c1.length > 0 ? projectPathDescSkills(c1) : projectPathDescSkills(parseOmpSkillsBlock(text))
}

export const buildAvailableSkillsCatalog = formatAvailableSkillsCatalog

/** Keep usable locations only; drop marker/builtin locations. */
export function projectPathDescSkills(skills: readonly HostSkill[]): HostSkill[] {
  return skills.map((skill) => {
    if (!skill.location || !isUsableSkillLocation(skill.location)) {
      const { location: _omit, ...rest } = skill
      return rest
    }
    return { ...skill, location: normalizeSkillLocation(skill.location) }
  })
}
