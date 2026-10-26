/**
 * Structural host-skills capability installed before an unchanged OpenCode
 * provider loads. Same install timing as `opencode.host.path-bridge`.
 *
 * Wire shape: `{ name, description, location? }` — no
 * skill body. Built-in / marker locations are omitted by the provider.
 */

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
let latestCatalogText: string | undefined

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

export function recordHostSkillCatalogText(text: string | undefined): void {
  latestCatalogText = text && text.trim().length > 0 ? text : undefined
}

export function latestHostSkillCatalogText(): string | undefined {
  return latestCatalogText
}

export function currentRecordedHostSkills(): HostSkill[] {
  return skillsFromCatalogText(latestCatalogText)
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

const CATALOG = /<available_skills\b[^>]*>([\s\S]*?)<\/available_skills>/i
const ENTRY_C1 = /<skill\b[^>]*>([\s\S]*?)<\/skill>/gi

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function tagText(entry: string, tag: string): string | undefined {
  const match = entry.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))
  return match?.[1] === undefined ? undefined : decodeXml(match[1].trim())
}

/** Parse OpenCode-1-shaped `<available_skills>` into HostSkill rows. */
export function parseAvailableSkillsCatalog(text: string): HostSkill[] {
  const catalog = CATALOG.exec(text)?.[1]
  if (!catalog) return []
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const match of catalog.matchAll(ENTRY_C1)) {
    const entry = match[1] ?? ""
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
    const match = line.match(/^\s*-\s*`([^`]+)`\s*:\s*(.*)$/)
    if (!match) continue
    const name = match[1]!.trim()
    const description = (match[2] ?? "").trim()
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
  const block = /<skills>([\s\S]*?)<\/skills>/i.exec(text)?.[1] ?? text
  const out: HostSkill[] = []
  const seen = new Set<string>()
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*-\s*(?:`?skill:\/\/)?`?([^:`]+)`?:\s*(.*)$/)
    if (!match) continue
    const name = match[1]!.trim()
    const description = (match[2] ?? "").trim()
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
