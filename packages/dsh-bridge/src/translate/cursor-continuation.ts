import type { DshMessage } from "./context.js"

const CHILD_NOTICE_KINDS = new Set(["agent-message", "subagent-settled"])

function isToolResult(message: DshMessage): boolean {
  return message.role === "user" && message.source?.kind === "tool"
}

function firstText(message: DshMessage): string {
  for (const block of message.content ?? []) {
    if (!block || typeof block !== "object") continue
    const rec = block as { type?: string; text?: unknown }
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0) return rec.text
  }
  return ""
}

function isChildNotice(message: DshMessage): boolean {
  if (message.role !== "user") return false
  const kind = message.source?.kind
  if (typeof kind === "string" && CHILD_NOTICE_KINDS.has(kind)) return true
  const text = firstText(message)
  return /^Agent \S+ sent a message:/m.test(text)
    || /^Background subagent \S+ (?:finished|was stopped|ran out of room|declined the task|failed|ended abnormally)/m.test(text)
}

function hasToolCall(message: DshMessage): boolean {
  for (const block of message.content ?? []) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "tool-call") return true
  }
  return false
}

function childNoticeKind(message: DshMessage): string {
  const kind = message.source?.kind
  if (typeof kind === "string" && CHILD_NOTICE_KINDS.has(kind)) return kind
  return "child-notice"
}

/**
 * Cursor-specific DSH continuation suppression. After a text-only stop, DSH
 * may wake the parent again for child relay/settled notices; reopening Cursor
 * for that notice produces a duplicate wait-for-continue banner. Keep this in
 * OCP and activate it only for the explicitly matched Cursor package.
 */
export function cursorSilentChildNoticeReason(messages: readonly DshMessage[]): string | undefined {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return undefined
  if (hasToolCall(messages[lastAssistant]!)) return undefined

  const trailing: DshMessage[] = []
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === "system" || isToolResult(message)) continue
    if (message.role === "user") trailing.push(message)
  }
  if (trailing.length === 0) return undefined
  if (!trailing.every(isChildNotice)) return undefined
  return trailing.map(childNoticeKind).join("+")
}
