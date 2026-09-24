/** A Pi-family local compaction replaces history without calling the provider. */
const pending = new Set<string>()
const MAX_PENDING = 256

export function markCursorHistoryRewrite(sessionId: string): void {
  if (!sessionId) return
  pending.delete(sessionId)
  pending.add(sessionId)
  while (pending.size > MAX_PENDING) pending.delete(pending.values().next().value!)
}

/** Lifecycle requests (for example title generation) must not consume it. */
export function takeCursorHistoryRewrite(sessionId: string | undefined, hasTools: boolean): boolean {
  if (!sessionId || !hasTools || !pending.has(sessionId)) return false
  pending.delete(sessionId)
  return true
}

export function registerCursorHistoryRewriteListener(on: (
  event: string,
  handler: (...args: unknown[]) => unknown,
) => void): void {
  on("session_compact", (_event, context) => {
    const manager = (context as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager
    const sessionId = manager?.getSessionId?.()
    if (sessionId) markCursorHistoryRewrite(sessionId)
  })
}
