import type { DshMessage } from "./context.js"

const CHILD_NOTICE_KINDS = new Set(["agent-message", "subagent-settled"])
const VISIBLE_REPLY_ECHO = "dsh-visible-reply-echo"

export type ChildNoticeContinuation = {
  reason: string
  visibleReply: string
  replayState: { response: { ocp: typeof VISIBLE_REPLY_ECHO } }
}

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

function isVisibleReplyEcho(message: DshMessage): boolean {
  const replay = message.source?.replayState as { response?: { ocp?: unknown } } | undefined
  return replay?.response?.ocp === VISIBLE_REPLY_ECHO
}

/**
 * Cursor-specific DSH continuation suppression. After a text-only stop, DSH
 * may wake the parent again for child relay/settled notices. Preserve that
 * reply as the new final visible answer without reopening Cursor; DSH folds
 * the earlier step into the completed Turn's process.
 */
export function cursorChildNoticeContinuation(messages: readonly DshMessage[]): ChildNoticeContinuation | undefined {
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
  const visibleReply = isVisibleReplyEcho(messages[lastAssistant]!) ? "" : messages[lastAssistant]!.content
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n")
  return {
    reason: trailing.map(childNoticeKind).join("+"),
    visibleReply,
    replayState: { response: { ocp: VISIBLE_REPLY_ECHO } },
  }
}

/** The echo is for DSH Chat presentation only; it is not another model turn. */
export function removeVisibleReplyEchoes(messages: readonly DshMessage[]): DshMessage[] {
  return messages.filter(message => message.role !== "assistant" || !isVisibleReplyEcho(message))
}
