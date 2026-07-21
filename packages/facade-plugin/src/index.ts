/**
 * @opencode-compat/facade-plugin — install-override stand-in for `@opencode-ai/plugin`.
 *
 * Classic surface: Hooks types + `tool` re-export.
 * Subpaths: `./tool`, `./tui`, `./v2/promise`, `./v2/effect`.
 */
export const PKG = "@opencode-compat/facade-plugin" as const
export const VERSION = "0.1.3" as const

export * from "./tool"
export type {
  AuthHook,
  AuthOAuthResult,
  AuthOuathResult,
  AuthPrompt,
  BunShell,
  Config,
  Event,
  HostClient,
  Hooks,
  Message,
  Model,
  ModelV2,
  Part,
  Permission,
  Plugin,
  PluginInput,
  PluginModule,
  PluginOptions,
  Project,
  Provider,
  ProviderContext,
  ProviderHook,
  ProviderHookContext,
  ProviderV2,
  UserMessage,
  WorkspaceAdapter,
  WorkspaceInfo,
  WorkspaceTarget,
} from "./types"
