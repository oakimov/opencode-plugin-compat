/**
 * Facade path for `@opencode-ai/plugin/v2/promise`.
 * T3 surface — requires host kit (`@opencode-compat/host-promise-v2`) + capable host.
 */
import { detect } from "@opencode-compat/profile"
import {
  createPluginContext,
  define as hostDefine,
  injectLanguageModel,
  injectSdk,
  resolveProvider,
  runPromisePlugin,
  type LanguageModelInput,
  type LanguageModelV3Like,
  type PluginContext,
  type PromisePlugin,
} from "@opencode-compat/host-promise-v2"

export const PKG_V2_PROMISE = "@opencode-compat/facade-plugin/v2/promise" as const

export type {
  LanguageModelInput,
  LanguageModelV3Like,
  PluginContext,
  PromisePlugin,
}

/** Re-exports for hosts / tests that import through the facade path. */
export {
  createPluginContext,
  injectLanguageModel,
  injectSdk,
  resolveProvider,
  runPromisePlugin,
}

export function define(plugin: PromisePlugin): PromisePlugin {
  const result = detect()
  if (!result.supported) {
    throw new Error(
      `${PKG_V2_PROMISE}: host ${result.id} cannot load OCP plugins. ${result.message ?? ""}`.trim(),
    )
  }
  if (!result.profile.capabilities.promiseV2) {
    throw new Error(
      `${PKG_V2_PROMISE}: Promise v2 not available on host "${result.profile.id}". ` +
        "Embed @opencode-compat/host-promise-v2 via an M1 host patch, or run on OpenCode. " +
        "See docs/ocp/0.1.md §7.",
    )
  }
  return hostDefine(plugin)
}
