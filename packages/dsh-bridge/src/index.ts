/**
 * Cordis plugin entry for `@opencode-compat/dsh-bridge`.
 * Mirrors `packages/llm/llm-deepseek/src/index.ts` (name/inject/Config/apply).
 * One registration per OpenCode provider: Cordis `LlmAdapter` + shared loader.
 */
import { installDshPathBridge } from "./path-bridge.js"
import { isCursorProviderPackage, validateConfig } from "./config.js"
import { registerDshPlugin } from "./register.js"
import { loadConfigSchema, providerSpecs, settingsAddress } from "./settings.js"

export const name = "dsh-bridge"
export const inject = ["llm", "credentials"] as const

// Config is the `config` field of the Cordis patch entry:
// config: { providers: Array<{package, providerName?, apiKeyEnv?, createOptions?, ...}> }
// Inside DSH it is a Schemastery schema whose volatile `providers` field is the
// Settings → Models surface. Outside DSH it is `undefined`, which makes
// `vendor/cordis/src/fiber.ts:50` skip validation; `apply` validates manually.
export const Config = await loadConfigSchema() as never

type DshBridgeConfig = {
  providers: Array<{ package: string; [k: string]: unknown }>
}

type ApplyContext = {
  llm: any
  credentials: any
  logger?: any
  fiber?: { entry?: { options: { id?: string } }; restart(): Promise<unknown> }
  on?: (event: string, listener: (...args: any[]) => any) => void
  inject?: (deps: string[], fn: (ctx: any) => void) => PromiseLike<unknown>
}

export async function apply(ctx: ApplyContext, config: DshBridgeConfig): Promise<void> {
  // Path bridge must land even when no provider config yet — like pi-bridge extension.ts:93
  try {
    installDshPathBridge("dsh")
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`dsh-bridge: path bridge not installed — ${err instanceof Error ? err.message : String(err)}`)
  }
  const validated = validateConfig({ providers: providerSpecs(config) })
  const entryId = Config === undefined ? undefined : ctx.fiber?.entry?.options.id
  if (Config === undefined) {
    // eslint-disable-next-line no-console
    console.error("dsh-bridge: @deepseek-ai/schemastery is unavailable; providers work but are not listed in Settings → Models")
  } else {
    // Settings → Models is this plugin's surface; no generic auto page.
    const presentation = ctx.inject?.(["settings"], child => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    void Promise.resolve(presentation).catch(error => console.error("dsh-bridge: settings presentation failed", error))
    // A volatile `providers` edit does not remount the plugin; re-register.
    ctx.on?.("loader/volatile-update", () => {
      void ctx.fiber?.restart().catch(error => console.error("dsh-bridge: reload after provider edit failed", error))
    })
  }
  const cursorProviders = new Set<string>()
  const hasCursor = validated.providers.some(spec => isCursorProviderPackage(spec.package))
  let isPlanActive: ((sessionId: string) => boolean) | undefined
  if (hasCursor) {
    const { registerCursorPlanEntry } = await import("./cursor-plan-tools.js")
    const activation = ctx.inject?.(["tools", "commands", "agents", "sessionProjections"], planCtx => {
      registerCursorPlanEntry(planCtx, cursorProviders)
      isPlanActive = sessionId => {
        const agent = planCtx.agents.get(sessionId)
        return agent !== undefined && planCtx.sessionProjections.stateOf(agent.session, "plan")?.active === true
      }
    })
    void Promise.resolve(activation).catch(error => console.error("dsh-bridge: plan entry injection failed", error))
  }
  for (const [index, spec] of validated.providers.entries()) {
    try {
      const result = await registerDshPlugin(ctx as never, spec as never, hasCursor, sessionId => isPlanActive?.(sessionId) === true,
        settingsAddress(entryId, index))
      if (isCursorProviderPackage(spec.package)) {
        cursorProviders.add(result.providerName)
        const { loadCursorImageSave, registerCursorImageTool } = await import("./cursor-image-tool.js")
        const save = await loadCursorImageSave(spec.package)
        if (save) {
          const activation = ctx.inject?.(["tools", "sandboxPolicy", "approval"], imageCtx => {
            registerCursorImageTool(imageCtx, save)
          })
          void Promise.resolve(activation).catch(error => console.error("dsh-bridge: image save tool registration failed", error))
        } else {
          console.error(`dsh-bridge: Cursor image-save export is unavailable from ${spec.package}; binary images cannot be saved`)
        }
      }
      // eslint-disable-next-line no-console
      console.log(`dsh-bridge: registered provider "${result.providerName}" (${result.modelCount} models) from "${spec.package}"`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: failed to register provider "${spec.package}" — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export default { name, inject, Config, apply }
