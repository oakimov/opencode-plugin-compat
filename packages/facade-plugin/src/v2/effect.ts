/**
 * Facade path for `@opencode-ai/plugin/v2/effect` — loud fail unless host capable.
 */
import { detect } from "@opencode-compat/profile"

export const PKG_V2_EFFECT = "@opencode-compat/facade-plugin/v2/effect" as const

export function define(_plugin: unknown): never {
  const result = detect()
  if (result.supported && result.profile.capabilities.effectV2) {
    throw new Error(
      `${PKG_V2_EFFECT}: host declares effectV2 but Effect host bridge is not implemented in this facade build`,
    )
  }
  throw new Error(
    `${PKG_V2_EFFECT}: Effect v2 not supported by this host/facade build` +
      (result.supported ? ` (host=${result.profile.id})` : ""),
  )
}
