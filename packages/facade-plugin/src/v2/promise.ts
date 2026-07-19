/**
 * Facade path for `@opencode-ai/plugin/v2/promise`.
 * T3 surface — requires host kit (`@opencode-compat/host-promise-v2`) + capable host.
 */
import { detect } from "@opencode-compat/profile"
import {
  createPluginContext,
  createPromiseV2Host,
  define as hostDefine,
  injectLanguageModel,
  injectSdk,
  resolveProvider,
  runPromisePlugin,
  type LanguageModelInput,
  type LanguageModelV3Like,
  type Plugin,
  type PluginContext,
  type PromisePlugin,
  type PromiseV2Host,
} from "@opencode-compat/host-promise-v2"

export const PKG_V2_PROMISE = "@opencode-compat/facade-plugin/v2/promise" as const

export type {
  LanguageModelInput,
  LanguageModelV3Like,
  Plugin,
  PluginContext,
  PromisePlugin,
  PromiseV2Host,
}

/** Re-exports for hosts / tests that import through the facade path. */
export {
  createPluginContext,
  createPromiseV2Host,
  injectLanguageModel,
  injectSdk,
  resolveProvider,
  runPromisePlugin,
}

export function define(plugin: Plugin): Plugin {
  const result = detect()
  if (!result.supported) {
    throw new Error(
      `${PKG_V2_PROMISE}: host ${result.id} cannot load OCP plugins. ${result.message ?? ""}`.trim(),
    )
  }
  if (!result.profile.capabilities.promiseV2) {
    throw new Error(
      `${PKG_V2_PROMISE}: Promise v2 not available on host "${result.profile.id}". ` +
        "Wire @opencode-compat/host-promise-v2 from the OCP layer (or run on OpenCode). " +
        "See docs/ocp/0.1.md §7.",
    )
  }
  return hostDefine(plugin)
}
