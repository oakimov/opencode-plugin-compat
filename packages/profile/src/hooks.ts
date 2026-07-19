/**
 * OCP 0.1 portable classic Hooks core set.
 * Source: docs/ocp/0.1.md §6 + docs/plans/phase0-hooks-parity.md
 */
export const CORE_HOOKS = [
  "dispose",
  "event",
  "config",
  "tool",
  "auth",
  "provider",
  "chat.message",
  "chat.params",
  "chat.headers",
  "permission.ask",
  "command.execute.before",
  "tool.execute.before",
  "tool.execute.after",
  "shell.env",
  "tool.definition",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.provider.small_model",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
] as const

export type CoreHook = (typeof CORE_HOOKS)[number]

/** MiMo host-extension hooks — non-portable (ADR-7) */
export const MIMO_EXTENSION_HOOKS = [
  "actor.preStop",
  "actor.postStop",
  "session.pre",
  "session.post",
  "session.userQuery.pre",
  "session.userQuery.post",
] as const

/** MiMo gaps vs OCP core */
export const MIMO_MISSING_HOOKS = [
  "dispose",
  "experimental.provider.small_model",
] as const
