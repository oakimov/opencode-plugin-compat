/**
 * pi turns every extension message into a `user` message before a provider
 * sees it (`convertToLlm`), including hidden context an extension injects for
 * the model (`display: false`, e.g. a plan-mode reminder after a tool
 * result). Read as user turns, such notes break a provider's live tool-result
 * continuation and can replace the user's own request.
 *
 * pi's `context` event still carries the original `custom` messages, so the
 * bridge records the hidden ones there and translates their converted copies
 * as host notes (`system`), the way omp's `developer` messages already are.
 * A converted message keeps its timestamp and text, which identify it.
 */
const MAX_NOTES = 512
const hiddenNotes = new Set<string>()

type ContentLike = string | ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined

function contentText(content: ContentLike): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") return undefined
    texts.push(part.text)
  }
  return texts.join("\n")
}

function noteKey(timestamp: unknown, content: ContentLike): string | undefined {
  if (typeof timestamp !== "number") return undefined
  const text = contentText(content)
  return text === undefined ? undefined : `${timestamp}\u0000${text}`
}

/** Remember the hidden extension messages of one pi `context` event. */
export function rememberHiddenHostNotes(messages: unknown): void {
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    const record = message as { role?: unknown; display?: unknown; timestamp?: unknown; content?: ContentLike } | undefined
    if (record?.role !== "custom" || record.display !== false) continue
    const key = noteKey(record.timestamp, record.content)
    if (!key) continue
    hiddenNotes.delete(key)
    hiddenNotes.add(key)
    while (hiddenNotes.size > MAX_NOTES) hiddenNotes.delete(hiddenNotes.values().next().value!)
  }
}

/** True when this provider-facing `user` message is a converted hidden extension note. */
export function isHiddenHostNote(message: { timestamp?: unknown; content?: ContentLike }): boolean {
  const key = noteKey(message.timestamp, message.content)
  return key !== undefined && hiddenNotes.has(key)
}

/** Test hook. */
export function resetHiddenHostNotes(): void {
  hiddenNotes.clear()
}

/** Record hidden notes from pi's `context` event, which runs before every model request. */
export function registerHiddenHostNoteListener(on: (
  event: string,
  handler: (...args: unknown[]) => unknown,
) => void): void {
  on("context", (event) => {
    rememberHiddenHostNotes((event as { messages?: unknown } | undefined)?.messages)
    return undefined
  })
}
