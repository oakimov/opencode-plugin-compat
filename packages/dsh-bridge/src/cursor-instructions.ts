/**
 * Optional Cursor contract: DSH workspace instructions as system context.
 *
 * DSH delivers AGENTS.md and scoped instruction files as user-role messages
 * tagged `source.kind: "agent-instructions"` (`<system-reminder>` text), not in
 * `system`. cursor-opencode-provider reaches the model with host system context
 * only through an always-apply rule built from the system prompt, and sends
 * just the latest user message as a turn's live text: an instruction message
 * elsewhere in the request never reaches the model, and one after tool results
 * reads as a new user turn. Folding these messages into `system` makes them
 * part of that rule; later changes arrive through the provider's own
 * mid-conversation update. Other providers keep DSH's native message shape.
 */
import type { DshGenerateOptions, DshMessage } from "./translate/context.js"

const AGENT_INSTRUCTIONS = "agent-instructions"

function isAgentInstructions(message: DshMessage): boolean {
  return message.role === "user" && message.source?.kind === AGENT_INSTRUCTIONS
}

function messageText(message: DshMessage): string {
  return (message.content ?? [])
    .flatMap((block) => {
      const rec = block as { type?: unknown; text?: unknown } | null
      return rec && rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0 ? [rec.text] : []
    })
    .join("\n")
}

/** Move DSH workspace-instruction messages into `system`, in request order. */
export function foldCursorAgentInstructions(options: DshGenerateOptions): DshGenerateOptions {
  if (!options.messages.some(isAgentInstructions)) return options
  const instructions: string[] = []
  const messages = options.messages.filter((message) => {
    if (!isAgentInstructions(message)) return true
    const text = messageText(message)
    if (text) instructions.push(text)
    return false
  })
  const system = [options.system, ...instructions].filter((part): part is string => !!part).join("\n\n")
  return { ...options, ...(system ? { system } : {}), messages }
}
