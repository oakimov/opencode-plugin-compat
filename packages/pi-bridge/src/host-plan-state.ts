/**
 * The host's plan mode per session, translated into the OpenCode agent the
 * plugin's `chat.params` hook sees (`plan` while the host is planning, `build`
 * otherwise). The reader is installed for the running host by the extension
 * entry: omp reads its live plan-mode state, plain pi reads the plan-mode
 * extension's session entries.
 */
import type { OpenCodeHostAgent } from "@opencode-compat/opencode-loader"

export type PiHostPlanReader = (sessionId: string) => boolean | undefined | Promise<boolean | undefined>

let reader: PiHostPlanReader | undefined

export function setPiHostPlanReader(next: PiHostPlanReader | undefined): void {
  reader = next
}

/** OpenCode agent for this session's next request; `build` when the host is not planning. */
export async function piHostAgent(sessionId: string | undefined): Promise<OpenCodeHostAgent> {
  if (!sessionId || !reader) return "build"
  try {
    return (await reader(sessionId)) === true ? "plan" : "build"
  } catch {
    return "build"
  }
}

/** Per-session plan flags observed from host events (bounded). */
export function createSessionPlanFlags(max = 256): {
  set(sessionId: string, active: boolean): void
  get(sessionId: string): boolean | undefined
} {
  const flags = new Map<string, boolean>()
  return {
    set(sessionId, active) {
      if (!sessionId) return
      flags.delete(sessionId)
      flags.set(sessionId, active)
      while (flags.size > max) flags.delete(flags.keys().next().value!)
    },
    get(sessionId) {
      return flags.get(sessionId)
    },
  }
}
