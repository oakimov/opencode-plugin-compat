/**
 * DSH `grep` result text → OpenCode's.
 *
 * DSH (`packages/fs/tool-fs-search/src/grep.ts` `formatGrepOutput`):
 *   Found 1 match | Found N matches | Found K of N matches
 *   <blank>
 *   /path/file
 *   Line 12: text
 *   … blank line between files, optional `(…)` recovery footer.
 *
 * OpenCode (`packages/opencode/src/tool/grep.ts`):
 *   Found N matches[ (more matches available)]
 *   /path/file:
 *     Line 12: text
 *
 * A provider that reads OpenCode's shape found no previews in DSH's and fell
 * back to a file list: the model saw which file matched but no matching line.
 */
const DSH_HEADER = /^Found (\d+)(?: of \d+)? match(?:es)?$/
const DSH_LINE = /^Line (\d+): ?(.*)$/

export function formatOpenCodeGrepResult(text: string): string {
  const lines = text.split("\n")
  const header = DSH_HEADER.exec(lines[0]?.trim() ?? "")
  // Indented previews are OpenCode's shape already.
  if (!header || lines.some((line) => /^[ \t]+Line \d+:/.test(line))) return text
  const capped = /\bof \d+ match/.test(lines[0]!)
  const out = [`Found ${header[1]} matches${capped ? " (more matches available)" : ""}`]
  let inFile = false
  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      inFile = false
      out.push("")
      continue
    }
    const preview = DSH_LINE.exec(line)
    if (inFile && preview) {
      out.push(`  Line ${preview[1]}: ${preview[2]}`)
      continue
    }
    if (!inFile && !line.startsWith("(")) {
      out.push(`${line}:`)
      inFile = true
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}
