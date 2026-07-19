/**
 * Facade path for `@opencode-ai/plugin/v2/promise` — stub.
 * T3 surface; host kit lives in `@opencode-compat/host-promise-v2`.
 */
export const PKG_V2_PROMISE = "@opencode-compat/facade-plugin/v2/promise" as const

export function define(_plugin: unknown): never {
  throw new Error(
    "@opencode-compat/facade-plugin/v2/promise: not implemented yet — see host-promise-v2",
  )
}
