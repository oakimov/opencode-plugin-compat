/**
 * Start implementing after a Cursor plan is approved in DSH's plan review.
 *
 * Cursor's CreatePlan ends the Cursor turn once its answer arrives; Cursor CLI
 * then waits for the user to start the build. DSH `exit_plan_mode` approves
 * with "carry out the plan starting with your next step" and expects the same
 * model to keep going (`packages/plan/plan-mode`). So the DSH turn stopped with
 * an empty step and nothing ran. The provider's own kickoff covers only its
 * emulated review, through a host prompt DSH does not expose. A
 * `agent/turn-stopping` listener that steers a message continues the turn, as
 * DSH's own Stop hooks do (`packages/hooks/hooks-claude-code`).
 */
import { randomUUID } from "node:crypto"
import { loggedDshRouteProvider } from "./translate/cursor-continuation.js"

const PLAN_REVIEW = "exit_plan_mode"
/** The provider mirrors a Cursor plan into the todo list before ending its turn. */
const PLAN_TODO_MIRROR = "todo_write"
// Same words as the provider's OpenCode build kickoff (`hostAgentSwitchPromptText`).
const KICKOFF = "Plan mode has ended. Continue with the approved work."
const MAX_REMEMBERED = 256

type LoggedEvent = { type?: string; data?: unknown }

type TurnStoppingPayload = {
  agent?: {
    id?: unknown
    options?: { provider?: unknown }
    session?: { snapshotEvents?: () => readonly LoggedEvent[] }
    steer?: (message: unknown) => void
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

/**
 * The plan-review call approved in the current turn when nothing has run since:
 * no reply text and no tool call other than the provider's todo mirror.
 */
export function pendingPlanKickoff(events: readonly LoggedEvent[]): string | undefined {
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "turn/start") {
      start = i + 1
      break
    }
  }
  const names = new Map<string, string>()
  let approved: string | undefined
  for (const event of events.slice(start)) {
    const data = record(event.data)
    if (event.type === "tool/call") {
      if (typeof data?.callId === "string" && typeof data.name === "string") names.set(data.callId, data.name)
      continue
    }
    const message = record(data?.message)
    if (event.type === "tool/result") {
      const id = typeof message?.toolCallId === "string" ? message.toolCallId : undefined
      if (id && names.get(id) === PLAN_REVIEW && message?.isError !== true) approved = id
      continue
    }
    if (event.type !== "assistant/message" || !approved) continue
    const content = Array.isArray(message?.content) ? message.content : []
    const started = content.some((block) => {
      const rec = record(block)
      if (rec?.type === "text") return typeof rec.text === "string" && rec.text.trim().length > 0
      return rec?.type === "tool-call" && rec.name !== PLAN_TODO_MIRROR
    })
    if (started) approved = undefined
  }
  return approved
}

export function installCursorPlanKickoff(
  on: ((event: string, listener: (payload: TurnStoppingPayload) => Promise<void> | void) => void) | undefined,
  cursorProviders: ReadonlySet<string>,
): void {
  if (!on) return
  const kicked = new Set<string>()
  on("agent/turn-stopping", (payload) => {
    const agent = payload.agent
    if (typeof agent?.steer !== "function") return
    let events: readonly LoggedEvent[]
    try {
      events = agent.session?.snapshotEvents?.() ?? []
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: plan kickoff could not read the session — ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const provider = loggedDshRouteProvider(events) ?? agent.options?.provider
    if (typeof provider !== "string" || !cursorProviders.has(provider)) return
    const approval = pendingPlanKickoff(events)
    if (!approval || kicked.has(approval)) return
    kicked.add(approval)
    if (kicked.size > MAX_REMEMBERED) kicked.delete(kicked.values().next().value!)
    // eslint-disable-next-line no-console
    console.log(`dsh-bridge: starting approved plan sessionId=${typeof agent.id === "string" ? agent.id : "-"}`)
    agent.steer(Object.freeze({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: KICKOFF }],
      // No context `form`: this is the build turn's instruction, as the
      // provider's OpenCode kickoff is a user prompt, not a host note.
      source: { kind: "dsh-bridge" },
    }))
  })
}
