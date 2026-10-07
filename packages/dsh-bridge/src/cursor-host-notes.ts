/**
 * Optional Cursor contract: DSH host notes after a step's tool results.
 *
 * DSH appends host-formed user messages after tool results: a refreshed
 * `time-context` snapshot, the `plan-mode` notice after `plan_enter`, child
 * `agent-message` / `subagent-settled` notices. Every such message carries a
 * `source.form` (`dsh-llm` `ContextFormed`); a person's message does not.
 * cursor-opencode-provider continues its held Cursor Run only when the prompt
 * ends on tool results, so a trailing note read as a new user turn: the held
 * Run was cancelled mid-answer and a fresh Run sent the note as the user's
 * message. OpenCode's own shape for such a note is a user message wrapping
 * `<system-update>`, which the provider appends to the last tool result.
 * Other providers keep DSH's native message shape.
 */
import type { DshGenerateOptions, DshMessage } from "./translate/context.js"

const OPEN = "<system-update>"
const CLOSE = "</system-update>"

function isHostNote(message: DshMessage): boolean {
  return message.role === "user"
    && message.source?.kind !== "tool"
    && typeof message.source?.form === "string"
    && (message.content ?? []).every((block) => block?.type === "text")
}

function isToolResult(message: DshMessage): boolean {
  if (message.role === "tool") return true
  return message.role === "user"
    && (message.source?.kind === "tool" || (message.content ?? []).some((block) => block?.type === "tool-result"))
}

function noteText(message: DshMessage): string {
  return (message.content ?? [])
    .map((block) => (typeof block?.text === "string" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
}

/** Wrap host notes that trail tool results so the step stays a continuation. */
export function lowerCursorTrailingHostNotes(options: DshGenerateOptions): DshGenerateOptions {
  const messages = options.messages
  let start = messages.length
  while (start > 0 && isHostNote(messages[start - 1]!)) start--
  if (start === messages.length || start === 0 || !isToolResult(messages[start - 1]!)) return options
  const notes = messages.slice(start).flatMap((message): DshMessage[] => {
    const text = noteText(message)
    return text ? [{ ...message, content: [{ type: "text", text: `${OPEN}\n${text}\n${CLOSE}` }] }] : []
  })
  return { ...options, messages: [...messages.slice(0, start), ...notes] }
}
