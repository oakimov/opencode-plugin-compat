/**
 * @opencode-compat/facade-plugin — classic entry scaffold.
 * Install overrides map `@opencode-ai/plugin` → this package inside fork caches.
 */
export const PKG = "@opencode-compat/facade-plugin" as const
export const VERSION = "0.1.0" as const

/** Placeholder classic plugin surface — implement against OPHP 0.1 core Hooks. */
export type Hooks = Record<string, unknown>
