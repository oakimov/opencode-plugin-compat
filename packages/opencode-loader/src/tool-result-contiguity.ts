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

function isToolMessage(message: ContiguousPromptMessage): boolean {
  return message.role === "tool"
}

function isSystemMessage(message: ContiguousPromptMessage): boolean {
  return message.role === "system"
}

function isStepBoundary(message: ContiguousPromptMessage): boolean {
  return message.role === "user" || message.role === "assistant"
}

/**
 * Mutate-free reorder: within each window that starts at an assistant message
 * and ends before the next user/assistant, move interleaved system notes to
 * after the last tool result of that window.
 */
export function ensureToolResultContiguity<T extends ContiguousPromptMessage>(
  prompt: readonly T[],
): T[] {
  if (prompt.length < 3) return [...prompt]

  const out: T[] = []
  let i = 0
  while (i < prompt.length) {
    const message = prompt[i]!
    out.push(message)
    i++
    if (message.role !== "assistant") continue

    const tools: T[] = []
    const notes: T[] = []
    while (i < prompt.length) {
      const next = prompt[i]!
      if (isStepBoundary(next)) break
      if (isToolMessage(next)) {
        tools.push(next)
        i++
        continue
      }
      if (isSystemMessage(next) && tools.length > 0) {
        // System among results of this step — defer until after tools.
        notes.push(next)
        i++
        continue
      }
      // Non-system, non-tool (e.g. unexpected role) or system before any tool:
      // flush deferred notes first so later tools stay after earlier notes
      // that were not mid-batch, then keep the message in place.
      if (notes.length > 0 && tools.length === 0) {
        out.push(...notes)
        notes.length = 0
      }
      if (tools.length > 0) {
        out.push(...tools)
        tools.length = 0
        if (notes.length > 0) {
          out.push(...notes)
          notes.length = 0
        }
      }
      out.push(next)
      i++
    }
    if (tools.length > 0) out.push(...tools)
    if (notes.length > 0) out.push(...notes)
  }
  return out
}
