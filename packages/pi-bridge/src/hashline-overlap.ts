export type LineRange = { start: number; end: number }

export type HashlinePatchMeta = {
  path?: string
  tag?: string
  ranges: LineRange[]
}

const HEADER = /\[([^\]#]+)(?:#([0-9A-Fa-f]{4}))?\]/
const RANGE = /(?:PUT|CUT)\s+(\d+)\.=(\d+)/gi
const BLOCK = /(?:PUT|CUT)\s+(\d+)\*/gi

export function parseHashlinePatch(input: string): HashlinePatchMeta {
  const header = input.match(HEADER)
  const ranges: LineRange[] = []
  for (const match of input.matchAll(RANGE)) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (Number.isInteger(start) && Number.isInteger(end)) ranges.push({ start, end: Math.max(start, end) })
  }
  for (const match of input.matchAll(BLOCK)) {
    const start = Number(match[1])
    if (Number.isInteger(start)) ranges.push({ start, end: Number.POSITIVE_INFINITY })
  }
  return {
    path: header?.[1]?.trim() || undefined,
    tag: header?.[2]?.toUpperCase() || undefined,
    ranges,
  }
}

export function rangesOverlap(left: readonly LineRange[], right: readonly LineRange[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a.start <= b.end && b.start <= a.end) return true
    }
  }
  return false
}

const claimed = new Map<string, Array<{ tag: string; ranges: LineRange[] }>>()

export function resetHashlineOverlapClaims(): void {
  claimed.clear()
  mintedByPath.clear()
}

export function claimHashlinePatch(meta: HashlinePatchMeta): void {
  if (!meta.path || !meta.tag || meta.ranges.length === 0) return
  const prior = claimed.get(meta.path) ?? []
  const siblings = prior.filter(entry => entry.tag === meta.tag)
  if (siblings.some(entry => rangesOverlap(entry.ranges, meta.ranges))) {
    throw new Error(
      `hashline hunk overlaps another in-flight or just-applied patch for ${meta.path}#${meta.tag}. ` +
        "Re-read the file and issue one hunk, or keep parallel hunks on disjoint line ranges.",
    )
  }
  claimed.set(meta.path, [...prior, { tag: meta.tag, ranges: meta.ranges }])
}

export function releaseHashlinePatch(meta: HashlinePatchMeta): void {
  if (!meta.path || !meta.tag) return
  const prior = claimed.get(meta.path)
  if (!prior) return
  const index = prior.findIndex(
    entry => entry.tag === meta.tag && entry.ranges === meta.ranges,
  )
  if (index < 0) return
  const next = prior.slice(0, index).concat(prior.slice(index + 1))
  if (next.length === 0) claimed.delete(meta.path)
  else claimed.set(meta.path, next)
}

/**
 * Session-scoped record of section tags OCP has seen minted by a successful
 * hashline apply this session. The host's per-path snapshot store keeps only a
 * short version history (default 4), so a tag can be recorded in-session and
 * later evicted by enough subsequent edits to the same file. When the host then
 * rejects a `[path#tag]` hunk with "hash is not from this session", a tag in
 * this registry proves the diagnosis is wrong — the tag WAS from this session
 * and merely aged out. Paths allow relative/absolute spelling drift, but tags
 * never match an unrelated path because the host hash is only four hex digits.
 * Reset on session_start.
 */
const mintedByPath = new Map<string, Set<string>>()

export function recordHashlineTagMinted(path: string, tag: string): void {
  if (!path || !tag) return
  const upper = tag.toUpperCase()
  let set = mintedByPath.get(path)
  if (!set) mintedByPath.set(path, (set = new Set()))
  set.add(upper)
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
}

function pathsMayMatch(left: string, right: string): boolean {
  const a = normalizedPath(left)
  const b = normalizedPath(right)
  if (a === b) return true
  const aAbsolute = a.startsWith("/") || /^[A-Za-z]:\//.test(a)
  const bAbsolute = b.startsWith("/") || /^[A-Za-z]:\//.test(b)
  if (aAbsolute && bAbsolute) return false
  if (!aAbsolute && !bAbsolute) return false
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function hasHashlineTagMinted(path: string | undefined, tag: string | undefined): boolean {
  if (!path || !tag) return false
  const upper = tag.toUpperCase()
  if (mintedByPath.get(path)?.has(upper)) return true
  for (const [mintedPath, tags] of mintedByPath) {
    if (tags.has(upper) && pathsMayMatch(path, mintedPath)) return true
  }
  return false
}

const NOT_FROM_SESSION_RE = /hash #([0-9A-Fa-f]{4}) is not from this session/
const CURRENT_HASH_RE = /The current file hashes to (#[0-9A-Fa-f]{4})/

/**
 * Return the rejected 4-hex tag when `text` is the host's "hash is not from
 * this session" rejection, or `undefined` for any other text.
 */
export function tagRejectedAsNotFromSession(text: string): string | undefined {
  return NOT_FROM_SESSION_RE.exec(text)?.[1]?.toUpperCase()
}

/**
 * Rewrite the host's "not from this session" rejection (which falsely accuses
 * the model of inventing or reusing a stale tag) into an accurate diagnostic
 * for the evicted-in-session case: the write was rejected because a concurrent
 * edit advanced the snapshot history and the in-session snapshot for the tag
 * was dropped. Keeps the host's anchored-context trailer verbatim so the model
 * still sees the live anchor lines.
 */
export function restateEvictedSessionHashlineFailure(
  path: string | undefined,
  tag: string,
  original: string,
): string {
  const current = CURRENT_HASH_RE.exec(original)?.[1]
  const pathText = path ? ` for ${path}` : ""
  const currentText = current ? ` The file now hashes to ${current}.` : ""
  // Drop the host's two header lines (rejection + "never invent the tag"
  // guidance); the blank separator and the anchored-context trailer stay.
  const rest = original.split("\n").slice(2).join("\n")
  const head =
    `Write rejected${pathText}: hash #${tag} was recorded earlier in this session but is no longer applicable — ` +
    `a concurrent edit to this file advanced its snapshot history and the host keeps only recent versions. ` +
    `Re-read the file to copy a current [path#tag] header, then retry this hunk with updated line anchors.${currentText}`
  return [head, rest].join("\n")
}

/**
 * Replace a rejected hashline error with the accurate evicted-in-session
 * diagnostic when the rejection names a tag OCP saw minted this session.
 * Returns the original error unchanged otherwise.
 */
export function restateEvictedSessionHashlineError(
  meta: { path?: string; tag?: string },
  error: unknown,
): unknown {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : ""
  const rejected = tagRejectedAsNotFromSession(text)
  const tag = rejected ?? meta.tag
  if (!rejected || !tag || !hasHashlineTagMinted(meta.path, tag)) return error
  const restated = new Error(restateEvictedSessionHashlineFailure(meta.path, tag, text))
  restated.name = "HashlineEvictedSessionTag"
  restated.cause = error
  return restated
}
