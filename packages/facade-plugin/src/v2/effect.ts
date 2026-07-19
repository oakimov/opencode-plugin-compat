/**
 * Facade path for `@opencode-ai/plugin/v2/effect` — loud fail unless host capable.
 */
export const PKG_V2_EFFECT = "@opencode-compat/facade-plugin/v2/effect" as const

export function define(_plugin: unknown): never {
  throw new Error(
    "@opencode-compat/facade-plugin/v2/effect: Effect v2 not supported by this host/facade build",
  )
}
