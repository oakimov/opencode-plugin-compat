/**
 * OpenCode's `chat.params` plugin hook, called the way OpenCode calls it before
 * each model request: with the session, the OpenCode agent running the turn,
 * and the model, and with `output.options` seeded from the model/variant
 * options the hook may extend. The returned options become the provider's
 * `providerOptions` entry for that request.
 *
 * The agent is OpenCode vocabulary: hosts that are not OpenCode translate their
 * own mode into it (`plan` while the host is planning, `build` otherwise).
 * Nothing here knows any particular plugin.
 */
import type { OpenCodeHooks } from "./types.js"

/** OpenCode primary agents a non-OpenCode host's mode maps onto. */
export type OpenCodeHostAgent = "plan" | "build"

export type ChatParamsInput = {
  sessionID: string
  agent: string
  providerID: string
  modelID: string
  /** Model/variant options OpenCode would hand the hook in `output.options`. */
  options: Record<string, unknown>
}

type ChatParamsHook = (
  input: Record<string, unknown>,
  output: {
    temperature: number | undefined
    topP: number | undefined
    topK: number | undefined
    maxOutputTokens: number | undefined
    options: Record<string, unknown>
  },
) => unknown

/** True when the plugin defines OpenCode's `chat.params` hook. */
export function hasChatParamsHook(hooks: OpenCodeHooks | undefined): boolean {
  return typeof hooks?.["chat.params"] === "function"
}

/**
 * Run the plugin's `chat.params` hook and return the resulting options. A
 * plugin without the hook gets its options back unchanged; a hook failure
 * propagates, as it fails the request in OpenCode.
 */
export async function runChatParamsHook(
  hooks: OpenCodeHooks | undefined,
  input: ChatParamsInput,
): Promise<Record<string, unknown>> {
  const options = { ...input.options }
  const hook = hooks?.["chat.params"] as ChatParamsHook | undefined
  if (typeof hook !== "function") return options
  const model = { id: input.modelID, providerID: input.providerID }
  const output = {
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    maxOutputTokens: undefined,
    options,
  }
  await hook.call(hooks, {
    sessionID: input.sessionID,
    agent: input.agent,
    model,
    provider: { info: { id: input.providerID }, options: {} },
    message: { sessionID: input.sessionID, role: "user", agent: input.agent, model: { providerID: input.providerID, modelID: input.modelID } },
  }, output)
  return output.options && typeof output.options === "object" ? output.options : options
}
