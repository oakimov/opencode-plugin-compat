/**
 * Minimal YAML frontmatter helpers for skill/command markdown.
 * Only supports simple `key: value` lines (no nested YAML).
 */

export type FrontmatterParse = {
  attrs: Record<string, string>
  body: string
}

export function parseFrontmatter(text: string): FrontmatterParse {
  const normalized = text.replace(/^\uFEFF/, "")
  if (!normalized.startsWith("---")) {
    return { attrs: {}, body: normalized }
  }
  const end = normalized.indexOf("\n---", 3)
  if (end < 0) return { attrs: {}, body: normalized }
  const header = normalized.slice(4, end).trim()
  let body = normalized.slice(end + 4)
  if (body.startsWith("\n")) body = body.slice(1)
  const attrs: Record<string, string> = {}
  for (const line of header.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    attrs[key] = value
  }
  return { attrs, body }
}

export function stringifyFrontmatter(
  attrs: Record<string, string>,
  body: string,
): string {
  const keys = Object.keys(attrs)
  if (keys.length === 0) return body
  const lines = keys.map((k) => `${k}: ${attrs[k]}`)
  const trimmedBody = body.replace(/^\n+/, "")
  return `---\n${lines.join("\n")}\n---\n${trimmedBody}`
}

/** ZCode handbook: skills keep only name + description. */
export function sanitizeSkillMarkdown(
  text: string,
  fallbackName: string,
): { name: string; description: string; content: string; dropped: string[] } {
  const { attrs, body } = parseFrontmatter(text)
  const dropped = Object.keys(attrs).filter(
    (k) => k !== "name" && k !== "description",
  )
  const name = attrs.name?.trim() || fallbackName
  const description = attrs.description?.trim() || ""
  const content = stringifyFrontmatter(
    { name, ...(description ? { description } : {}) },
    body,
  )
  return { name, description, content, dropped }
}

/** Commands: keep description; drop agent/model/subtask and unknowns. */
export function sanitizeCommandMarkdown(
  text: string,
  fallbackName: string,
): {
  name: string
  description?: string
  content: string
  dropped: string[]
} {
  const { attrs, body } = parseFrontmatter(text)
  const keep = new Set(["name", "description"])
  const dropped = Object.keys(attrs).filter((k) => !keep.has(k))
  const name = attrs.name?.trim() || fallbackName
  const description = attrs.description?.trim()
  const outAttrs: Record<string, string> = {}
  if (description) outAttrs.description = description
  const content = stringifyFrontmatter(outAttrs, body)
  return { name, description, content, dropped }
}
