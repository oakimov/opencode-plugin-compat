/**
 * Keep a completed Cursor reply as the turn's last step.
 *
 * DSH `latestAnswer` is only the last step, and only when that step has reply
 * text and no tool call (`packages/client/ui-chat/.../turn-process.ts`).
 * A later helper-notice step either reprints that text or, with no text,
 * folds the reply into thinking. `agent/pre-step` can enter with no messages
 * and the loop then does not open the step
 * (`packages/core/agent-loop/src/agent.ts`).
 */
import {
  applyChildNoticeHold,
  loggedDshMessages,
  loggedDshRouteProvider,
  type ChildNoticeHoldDecision,
} from "./translate/cursor-continuation.js"

type NoticeMessage = { content?: unknown; source?: { kind?: unknown } }

type PreStepPayload = {
  agent?: {
    id?: unknown
    options?: { provider?: unknown }
    session?: { snapshotEvents?: () => readonly { type?: string; data?: unknown }[] }
  }
  messages?: readonly NoticeMessage[]
}

type PreStepDecision = { kind: "reject" } | { kind: "enter"; messages: unknown[] }

type PreStepListener = (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

export function installCursorChildNoticeHold(
  on: ((event: string, listener: PreStepListener, prepend?: boolean) => void) | undefined,
  cursorProviders: ReadonlySet<string>,
): void {
  if (!on) return
  const held = new Map<string, NoticeMessage[]>()
  // Outermost, so a later hook cannot put messages back onto an empty enter
  // and start the step this hold exists to prevent.
  on("agent/pre-step", async (payload, next) => {
    const sessionId = typeof payload.agent?.id === "string" ? payload.agent.id : ""
    let events: readonly { type?: string; data?: unknown }[] | undefined
    try {
      events = payload.agent?.session?.snapshotEvents?.() ?? []
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: child-notice hold could not read the session — ${error instanceof Error ? error.message : String(error)}`)
    }
    // The step's route, not `options.provider`: the web UI picks the model per
    // session after the agent was created on the profile default.
    const provider = events && (loggedDshRouteProvider(events) ?? payload.agent?.options?.provider)
    const claimed = payload.messages ?? []
    const pending = held.get(sessionId) ?? []
    const decision: ChildNoticeHoldDecision<NoticeMessage> = events && typeof provider === "string" && cursorProviders.has(provider)
      ? applyChildNoticeHold(loggedDshMessages(events), claimed, pending)
      // Off Cursor, or with an unreadable log, notices held earlier still reach the next real step.
      : { action: "enter", release: claimed.length > 0 ? [...pending] : [] }
    if (decision.action === "hold") {
      held.set(sessionId, decision.held)
      // eslint-disable-next-line no-console
      console.log(`dsh-bridge: held child-notice step sessionId=${sessionId || "-"} count=${claimed.length}`)
      return { kind: "enter", messages: [] }
    }
    const entered = await next()
    if (entered.kind !== "enter" || decision.release.length === 0) return entered
    held.delete(sessionId)
    return { ...entered, messages: [...decision.release, ...entered.messages] }
  }, true)
}
