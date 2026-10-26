/**
 * Keep a step's tool results contiguous for providers that only continue a
 * held Run from trailing tool messages (notes after them, never between).
 *
 * Only `system` messages that sit among a step's tool results are moved to
 * just after the last result. User messages stay put (host steer = turn
 * boundary). Results are not reordered across steps or relative to each other.
 */

export type ContiguousPromptMessage = {
  role: string
  content?: unknown
  [key: string]: unknown
}

/** Move interleaved system notes behind a step's results without crossing a turn. */
export function ensureToolResultContiguity<T extends ContiguousPromptMessage>(prompt: readonly T[]): T[] {
  const out: T[] = []
  let cursor = 0
  while (cursor < prompt.length) {
    const message = prompt[cursor++]!
    out.push(message)
    if (message.role !== "assistant") continue
    const notes: T[] = []
    let seenTool = false
    while (cursor < prompt.length) {
      const next = prompt[cursor]!
      if (next.role === "user" || next.role === "assistant") break
      cursor++
      if (next.role === "tool") {
        out.push(next)
        seenTool = true
      } else if (next.role === "system" && seenTool) {
        notes.push(next)
      } else {
        out.push(...notes, next)
        notes.length = 0
        seenTool = false
      }
    }
    out.push(...notes)
  }
  return out
}
