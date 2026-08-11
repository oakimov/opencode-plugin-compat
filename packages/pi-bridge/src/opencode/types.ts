/**
 * Structural mirrors of the *standard* OpenCode plugin surface this bridge
 * consumes. Copied from `@opencode-ai/plugin`'s own type declarations (1.18.x
 * `dist/types.d.ts`) rather than imported, so the bridge never takes a runtime
 * or build dependency on the OpenCode plugin package — it only needs to
 * recognize these shapes on an already-loaded plugin module.
 *
 * These are *conventions every OpenCode plugin already implements*, which is
 * what lets the bridge work against unmodified plugins with no per-plugin code.
 */

export type OpenCodeAuthPrompt = {
  type: "text"
  key: string
  message: string
  placeholder?: string
  validate?: (value: string) => string | undefined
} | {
  type: "select"
  key: string
  message: string
  options: Array<{ label: string; value: string; hint?: string }>
}

/** `authorize()` result for a `type: "oauth"` method. */
export type OpenCodeAuthOAuthResult = {
  url: string
  instructions?: string
  method?: "auto" | "code" | string
  /** Completes the flow — polls / exchanges, returning durable credentials. */
  callback: (input?: unknown) => Promise<OpenCodeOAuthCallbackResult>
}

export type OpenCodeOAuthCallbackResult =
  | { type: "success"; provider?: string; access: string; refresh: string; expires: number; [key: string]: unknown }
  | { type: "failed"; [key: string]: unknown }

export type OpenCodeApiAuthorizeResult =
  | { type: "success"; key: string; provider?: string; metadata?: Record<string, string> }
  | { type: "failed" }

export type OpenCodeAuthMethod =
  | {
      type: "oauth"
      label: string
      prompts?: OpenCodeAuthPrompt[]
      authorize(inputs?: Record<string, string>): Promise<OpenCodeAuthOAuthResult>
    }
  | {
      type: "api"
      label: string
      prompts?: OpenCodeAuthPrompt[]
      authorize?(inputs?: Record<string, string>): Promise<OpenCodeApiAuthorizeResult>
    }

/** The credential shape OpenCode persists (and plugins read back via `getAuth()`). */
export type OpenCodeAuth =
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown }
  | { type: "api"; key: string; metadata?: Record<string, string>; [key: string]: unknown }

export type OpenCodeAuthHook = {
  provider: string
  methods: OpenCodeAuthMethod[]
  /**
   * Given a live credential getter, returns provider options. Plugins also use
   * this as their refresh + warmup path — it is where a plugin renews an
   * expiring token and persists it via `client.auth.set(...)`, which is
   * precisely how this bridge implements Pi's required `oauth.refreshToken`.
   */
  loader?: (auth: () => Promise<OpenCodeAuth | undefined>, provider?: unknown) => Promise<Record<string, unknown>>
}

/** models.dev / OpenCode model entry (what a `config` hook writes per model id). */
export type OpenCodeModelEntry = {
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  modalities?: { input?: string[]; output?: string[] }
  options?: Record<string, unknown>
  [key: string]: unknown
}

export type OpenCodeProviderConfigEntry = {
  name?: string
  npm?: string
  models?: Record<string, OpenCodeModelEntry>
  options?: Record<string, unknown>
  [key: string]: unknown
}

export type OpenCodeConfig = {
  provider?: Record<string, OpenCodeProviderConfigEntry>
  [key: string]: unknown
}

/** The subset of OpenCode `Hooks` this bridge reads. */
export type OpenCodeHooks = {
  auth?: OpenCodeAuthHook
  config?: (config: OpenCodeConfig) => Promise<void> | void
  [key: string]: unknown
}

export type OpenCodePluginFactory = (input: unknown) => Promise<OpenCodeHooks> | OpenCodeHooks
