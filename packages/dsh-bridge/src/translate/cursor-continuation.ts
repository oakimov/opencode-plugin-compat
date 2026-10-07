import type { DshMessage } from "./context.js"

const CHILD_NOTICE_KINDS = new Set(["agent-message", "subagent-settled"])
const VISIBLE_REPLY_ECHO = "dsh-visible-reply-echo"

export type ChildNoticeContinuation = {
  reason: string
}

function isToolResult(message: DshMessage): boolean {
  if (message.role === "tool") return true
  if (message.role !== "user") return false
  if (message.source?.kind === "tool") return true
  return (message.content ?? []).some(block =>
    Boolean(block && typeof block === "object" && (block as { type?: string }).type === "tool-result"),
  )
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

function toolCallIds(message: DshMessage): string[] {
  const ids: string[] = []
  for (const block of message.content ?? []) {
    if (!block || typeof block !== "object") continue
    const rec = block as { type?: unknown; id?: unknown; toolCallId?: unknown }
    if (rec.type !== "tool-call") continue
    if (typeof rec.id === "string" && rec.id.length > 0) ids.push(rec.id)
    else if (typeof rec.toolCallId === "string" && rec.toolCallId.length > 0) ids.push(rec.toolCallId)
  }
  return ids
}

function answeredToolCallIds(messages: readonly DshMessage[], after: number): Set<string> {
  const ids = new Set<string>()
  for (let i = after + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) ids.add(message.toolCallId)
    const callId = message.source?.callId
    if (typeof callId === "string" && callId.length > 0) ids.add(callId)
    for (const block of message.content ?? []) {
      if (!block || typeof block !== "object") continue
      const rec = block as { type?: unknown; toolCallId?: unknown }
      if (rec.type === "tool-result" && typeof rec.toolCallId === "string" && rec.toolCallId.length > 0) {
        ids.add(rec.toolCallId)
      }
    }
  }
  return ids
}

function hasUnansweredToolCall(messages: readonly DshMessage[], lastAssistant: number): boolean {
  const ids = toolCallIds(messages[lastAssistant]!)
  if (ids.length === 0) return false
  const answered = answeredToolCallIds(messages, lastAssistant)
  return ids.some(id => !answered.has(id))
}

function assistantReplyText(message: DshMessage): string {
  return (message.content ?? [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n")
    .trim()
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
 * Cursor-specific DSH continuation suppression. After the parent has already
 * answered in text, DSH still proposes a step for child relay/settled notices.
 * That step must not run: a new assistant message either copies the reply or,
 * when empty, becomes the turn's last step and Compact/Standard fold the reply
 * into thinking. {@link shouldHoldChildNotices} is what stops the step.
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
  if (hasUnansweredToolCall(messages, lastAssistant)) return undefined
  if (!assistantReplyText(messages[lastAssistant]!)) return undefined

  const trailing: DshMessage[] = []
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role === "system" || isToolResult(message)) continue
    if (message.role === "user") trailing.push(message)
  }
  if (trailing.length === 0) return undefined
  if (!trailing.every(isChildNotice)) return undefined
  return { reason: trailing.map(childNoticeKind).join("+") }
}

function messageSource(source: { kind?: unknown } | undefined): DshMessage["source"] {
  const kind = typeof source?.kind === "string" ? source.kind : "user"
  return { ...(source ?? {}), kind }
}

/** Project durable session events into the message list the continuation predicate reads. */
export function loggedDshMessages(events: readonly { type?: string; data?: unknown }[]): DshMessage[] {
  const messages: DshMessage[] = []
  for (const event of events) {
    if (!event.data || typeof event.data !== "object") continue
    const data = event.data as {
      content?: unknown
      source?: { kind?: unknown }
      message?: { content?: unknown; source?: { kind?: unknown }; toolCallId?: unknown }
    }
    if (event.type === "user/message") {
      messages.push({
        role: "user",
        content: Array.isArray(data.content) ? data.content : [],
        source: messageSource(data.source),
      })
      continue
    }
    const message = data.message
    if (!message) continue
    if (event.type === "assistant/message") {
      messages.push({
        role: "assistant",
        content: Array.isArray(message.content) ? message.content : [],
        source: messageSource(message.source),
      })
      continue
    }
    if (event.type === "tool/result") {
      messages.push({
        role: "tool",
        content: Array.isArray(message.content) ? message.content : [],
        source: messageSource(message.source),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      })
    }
  }
  return messages
}

/**
 * Provider of the session's next request, resolved from durable events the way
 * DSH's session model selection does (`session-controller` `selectionFor`): a
 * `model/selection` after the last `request/header` is still pending, otherwise
 * the header's route. `AgentOptions.provider` is only the default captured when
 * the session was created; a per-session selection never updates it.
 */
export function loggedDshRouteProvider(events: readonly { type?: string; data?: unknown }[]): string | undefined {
  let provider: string | undefined
  for (const event of events) {
    const data = event.data as { provider?: unknown; header?: { config?: { provider?: unknown } } } | undefined
    if (event.type === "model/selection" && typeof data?.provider === "string") provider = data.provider
    else if (event.type === "request/header" && typeof data?.header?.config?.provider === "string") {
      provider = data.header.config.provider
    }
  }
  return provider
}

function userToDsh(message: { content?: unknown; source?: { kind?: unknown } }): DshMessage {
  return {
    role: "user",
    content: Array.isArray(message.content) ? message.content : [],
    source: messageSource(message.source),
  }
}

/**
 * A claimed batch of only child notices, after a completed text reply, must
 * not enter a step. The reply already on the log stays the turn's answer.
 */
export function shouldHoldChildNotices(history: readonly DshMessage[], claimed: readonly DshMessage[]): boolean {
  if (claimed.length === 0 || !claimed.every(isChildNotice)) return false
  return cursorChildNoticeContinuation([...history, ...claimed]) !== undefined
}

export type ChildNoticeHoldDecision<T> =
  | { action: "hold"; held: T[] }
  | { action: "enter"; release: T[] }

/**
 * Hold child-notice wakes until a real step. An empty claim does not release
 * them: that would start the step these notices are being kept out of.
 */
export function applyChildNoticeHold<T extends { content?: unknown; source?: { kind?: unknown } }>(
  history: readonly DshMessage[],
  claimed: readonly T[],
  held: readonly T[],
): ChildNoticeHoldDecision<T> {
  if (claimed.length === 0) return { action: "enter", release: [] }
  if (shouldHoldChildNotices(history, claimed.map(userToDsh))) {
    return { action: "hold", held: [...held, ...claimed] }
  }
  return { action: "enter", release: [...held] }
}

/** The echo is for DSH Chat presentation only; it is not another model turn. */
export function removeVisibleReplyEchoes(messages: readonly DshMessage[]): DshMessage[] {
  return messages.filter(message => message.role !== "assistant" || !isVisibleReplyEcho(message))
}
