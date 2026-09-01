/**
 * Cordis plugin entry for `@opencode-compat/dsh-bridge`.
 * Mirrors `packages/llm/llm-deepseek/src/index.ts` (name/inject/Config/apply).
 * One registration per OpenCode provider: Cordis `LlmAdapter` + shared loader.
 */
import { installDshPathBridge } from "./path-bridge.js"
import { validateConfig } from "./config.js"
import { registerDshPlugin } from "./register.js"
import { installDshBridgeSettings } from "./settings.js"
import type { DshBridgeProviderProfile } from "./settings.js"

export const name = "dsh-bridge"
export const inject = ["llm", "credentials"] as const

// Config is the `config` field of the Cordis patch entry:
// config: { providers: Array<{package, providerName?, apiKey?, createOptions?, ...}> }
// No Standard Schema — manual validation in `apply` via `validateConfig`.
// Exporting `undefined` makes `vendor/cordis/src/fiber.ts:50` skip `~standard` validation.
export const Config = undefined as unknown as never

type DshBridgeConfig = {
  providers: Array<{ package: string; [k: string]: unknown }>
}

type ApplyContext = {
  llm: any
  credentials: any
  logger?: any
  inject?: (deps: string[], fn: (ctx: any) => void) => void
}

export async function apply(ctx: ApplyContext, config: DshBridgeConfig): Promise<void> {
  // Path bridge must land even when no provider config yet — like pi-bridge extension.ts:93
  try {
    installDshPathBridge("dsh")
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`dsh-bridge: path bridge not installed — ${err instanceof Error ? err.message : String(err)}`)
  }

  const validated = validateConfig(config as never)
  const profiles: Record<string, DshBridgeProviderProfile> = {}

  for (const spec of validated.providers) {
    try {
      const result = await registerDshPlugin(ctx as never, spec as never)
      const profile: DshBridgeProviderProfile = { displayName: result.providerName }
      if (typeof spec.apiKey === "string" && spec.apiKey.length > 0) profile.apiKeyEnv = spec.apiKey
      profiles[result.providerName] = profile
      // eslint-disable-next-line no-console
      console.log(`dsh-bridge: registered provider "${result.providerName}" (${result.modelCount} models) from "${spec.package}"`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: failed to register provider "${spec.package}" — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    installDshBridgeSettings(ctx, { providers: profiles })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`dsh-bridge: settings section not installed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

export default { name, inject, Config, apply }
