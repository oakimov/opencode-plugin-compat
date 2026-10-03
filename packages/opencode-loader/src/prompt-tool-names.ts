/**
 * Restate host tool names inside host prompt text.
 *
 * Bridges hand providers a canonical OpenCode catalog (`glob`, `task`,
 * `todowrite`, `question`, …) but forward the host's own system prompt, which
 * names tools in the host's vocabulary. A model that follows that prompt is
 * told to call names the catalog does not have, or — when the host reused a
 * canonical name for another role, as MiMo did with `task` — the wrong tool.
 *
 * Only unambiguous references are rewritten: a code span whose whole content is
 * a renamed host tool name, and (opt-in) a `- name: …` tool-list line. Prose
 * words such as "find" or "task" stay untouched. Every reference is resolved
 * against the host name in one pass, so swapped names never chain.
 */
export type PromptToolNameOptions = {
  /** Also rewrite `- name: description` tool-list lines (pi's system prompt). */
  toolListItems?: boolean
}

export function translatePromptToolNames(
  text: string,
  renames: ReadonlyMap<string, string>,
  options: PromptToolNameOptions = {},
): string {
  if (renames.size === 0 || text.length === 0) return text
  const translate = (prose: string): string => {
    // Consume whole Markdown delimiters and escaped literals. A single-tick
    // regex can pair delimiters from unrelated spans or rewrite literal code.
    const tokens = /\\[\\`]|`+|^([ \t]*- )([A-Za-z0-9_.-]+)(: )/gm
    let out = ""
    let offset = 0
    for (let token = tokens.exec(prose); token; token = tokens.exec(prose)) {
      out += prose.slice(offset, token.index)
      const delimiter = token[0]
      if (delimiter.startsWith("`")) {
        const closes = /`+/g
        closes.lastIndex = tokens.lastIndex
        let close = closes.exec(prose)
        while (close && close[0].length !== delimiter.length) close = closes.exec(prose)
        if (close) {
          const name = prose.slice(tokens.lastIndex, close.index)
          out += delimiter + (renames.get(name) ?? name) + delimiter
          tokens.lastIndex = closes.lastIndex
        } else out += delimiter
      } else if (options.toolListItems && token[2]) {
        out += token[1] + (renames.get(token[2]) ?? token[2]) + token[3]
      } else out += delimiter
      offset = tokens.lastIndex
    }
    return out + prose.slice(offset)
  }
  let out = ""
  let prose = ""
  let fence: string | undefined
  for (const line of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (fence) {
      out += line
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
    } else if (marker) {
      out += translate(prose) + line
      prose = ""
      fence = marker[1]
    } else prose += line
  }
  return out + translate(prose)
}

/** Host → canonical names for the tools a call actually advertises. */
export function hostToolRenames(
  hostToolNames: Iterable<string>,
  canonicalName: (hostName: string) => string,
): Map<string, string> {
  const renames = new Map<string, string>()
  for (const host of hostToolNames) {
    const canonical = canonicalName(host)
    if (canonical && canonical !== host) renames.set(host, canonical)
  }
  return renames
}
