/**
 * OpenCode `auth` hook → Pi-family `ProviderConfig.oauth`.
 *
 * This is what makes OAuth work for *any* unmodified OpenCode plugin with no
 * per-plugin adapter: OpenCode already standardizes interactive auth as
 * `auth.methods[]` (`type: "oauth"` with `authorize() → {url, callback()}`, and
 * `type: "api"` with `prompts[]`), and Pi already standardizes it as
 * `oauth.login(callbacks)`. Both sides are conventions, so the mapping is
 * mechanical.
 *
 * Refresh deserves note. OpenCode plugins expose no standalone "refresh"
 * entry point — they renew an expiring token *inside* `auth.loader` and persist
 * it by calling `client.auth.set(...)`. So Pi's `refreshToken` is implemented
 * by invoking that same loader against a stub client and reading back whatever
 * the plugin wrote, which is exactly how OpenCode itself drives refresh.
 */
import type { AuthStore } from "./host-stub.js"
import type { OpenCodeAuth, OpenCodeAuthHook, OpenCodeAuthMethod, OpenCodeAuthPrompt } from "./types.js"

/** Pi's `OAuthCredentials` (both hosts: `{access, refresh, expires}` + optional extras). */
export type PiOAuthCredentials = {
  access: string
  refresh: string
  expires: number
  [key: string]: unknown
}

export type PiOAuthAuthInfo = { url: string; launchUrl?: string; instructions?: string }
export type PiOAuthPrompt = { message: string; placeholder?: string; allowEmpty?: boolean }

export type PiOAuthLoginCallbacks = {
  onAuth: (info: PiOAuthAuthInfo) => void
  onProgress?: (message: string) => void
  onManualCodeInput?: () => Promise<string>
  onPrompt?: (prompt: PiOAuthPrompt) => Promise<string>
  signal?: AbortSignal
}

export type PiOAuthConfig = {
  name: string
  login(callbacks: PiOAuthLoginCallbacks): Promise<PiOAuthCredentials>
  refreshToken(credentials: PiOAuthCredentials, signal?: AbortSignal): Promise<PiOAuthCredentials>
  getApiKey(credentials: PiOAuthCredentials): string
}

const HOUR_MS = 3_600_000

/**
 * Best-effort expiry for a bearer token. JWT is a universal format (not a
 * provider detail), so decoding `exp` here stays generic; anything undecodable
 * falls back to an hour out, matching what Pi's own built-in OAuth flows do.
 */
export function tokenExpiryMs(token: string, now = Date.now()): number {
  const segment = token.split(".")[1]
  if (segment) {
    try {
      const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
      const payload = JSON.parse(json) as { exp?: unknown }
      if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000
    } catch {
      // fall through
    }
  }
  return now + HOUR_MS
}

/** OpenCode stored credential → Pi credentials. */
export function toPiCredentials(auth: OpenCodeAuth, now = Date.now()): PiOAuthCredentials {
  if (auth.type === "oauth") {
    return { access: auth.access, refresh: auth.refresh, expires: auth.expires || tokenExpiryMs(auth.access, now) }
  }
  // An API-key method yields a key (often already an exchanged JWT) plus an
  // optional refresh token in metadata. Represent it in the same credential
  // shape so `getApiKey` and the streaming path stay uniform.
  const refresh = auth.metadata?.refreshToken ?? ""
  return { access: auth.key, refresh, expires: tokenExpiryMs(auth.key, now) }
}

/** Pi credentials → OpenCode stored credential, for handing back to a plugin's loader. */
export function toOpenCodeAuth(credentials: PiOAuthCredentials): OpenCodeAuth {
  return { type: "oauth", access: credentials.access, refresh: credentials.refresh, expires: credentials.expires }
}

function pickMethod(methods: OpenCodeAuthMethod[], preferred?: "oauth" | "api"): OpenCodeAuthMethod | undefined {
  if (preferred) return methods.find(m => m.type === preferred)
  return methods.find(m => m.type === "oauth") ?? methods.find(m => m.type === "api")
}

/** Drive a method's `prompts[]` through Pi's own `onPrompt` callback. */
async function collectInputs(
  prompts: OpenCodeAuthPrompt[] | undefined,
  callbacks: PiOAuthLoginCallbacks,
): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {}
  if (!prompts?.length) return inputs
  if (!callbacks.onPrompt) {
    throw new Error("pi-bridge: this plugin's auth method requires interactive prompts, but the host supplied no onPrompt callback")
  }
  for (const prompt of prompts) {
    const message =
      prompt.type === "select"
        ? `${prompt.message} (${prompt.options.map(o => o.value).join(" | ")})`
        : prompt.message
    const value = await callbacks.onPrompt({
      message,
      ...(prompt.type === "text" && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    })
    if (prompt.type === "text" && prompt.validate) {
      const error = prompt.validate(value)
      if (error) throw new Error(`pi-bridge: ${error}`)
    }
    inputs[prompt.key] = value
  }
  return inputs
}

export type BuildOAuthOptions = {
  authHook: OpenCodeAuthHook
  /** Label shown by the host's `/login` picker. Defaults to the plugin's own method label. */
  name?: string
  /** Force a specific method type when a plugin offers both. */
  prefer?: "oauth" | "api"
  /**
   * Invokes the plugin's `auth.loader` with the given credentials and returns
   * whatever the plugin persisted back through the stubbed client (its refresh
   * path). Supplied by the caller because it owns the plugin instance + stub.
   */
  runLoader?: (auth: OpenCodeAuth, signal?: AbortSignal) => Promise<OpenCodeAuth | undefined>
}

/**
 * Build a Pi `oauth` config from an OpenCode auth hook. Always supplies
 * `refreshToken` and `getApiKey` — pi marks both required, omp marks both
 * optional, so providing them satisfies either host.
 */
export function buildPiOAuth(options: BuildOAuthOptions): PiOAuthConfig | undefined {
  const { authHook } = options
  const method = pickMethod(authHook.methods ?? [], options.prefer)
  if (!method) return undefined

  return {
    name: options.name ?? method.label ?? authHook.provider,

    async login(callbacks) {
      const inputs = await collectInputs(method.prompts, callbacks)

      if (method.type === "oauth") {
        const authorized = await method.authorize(inputs)
        callbacks.onAuth({
          url: authorized.url,
          ...(authorized.instructions ? { instructions: authorized.instructions } : {}),
        })
        callbacks.onProgress?.("Waiting for browser authentication...")
        const result = await authorized.callback()
        if (result.type !== "success") {
          throw new Error(`pi-bridge: OAuth login failed for provider "${authHook.provider}"`)
        }
        return {
          access: result.access,
          refresh: result.refresh,
          expires: result.expires || tokenExpiryMs(result.access),
        }
      }

      if (!method.authorize) {
        throw new Error(`pi-bridge: plugin "${authHook.provider}" exposes an API-key auth method with no authorize()`)
      }
      const result = await method.authorize(inputs)
      if (result.type !== "success") {
        throw new Error(`pi-bridge: API-key authorization failed for provider "${authHook.provider}"`)
      }
      return toPiCredentials({ type: "api", key: result.key, metadata: result.metadata })
    },

    async refreshToken(credentials, signal) {
      // No refresh material (e.g. a bare API key) — nothing to renew.
      if (!credentials.refresh || !options.runLoader) return credentials
      const refreshed = await options.runLoader(toOpenCodeAuth(credentials), signal)
      return refreshed ? toPiCredentials(refreshed) : credentials
    },

    getApiKey(credentials) {
      return credentials.access
    },
  }
}

/**
 * Build the `runLoader` used above: call the plugin's `auth.loader` with a
 * getter returning `auth`, then read back whatever it persisted to `store`.
 */
export function createLoaderRunner(authHook: OpenCodeAuthHook, store: AuthStore) {
  return async (auth: OpenCodeAuth): Promise<OpenCodeAuth | undefined> => {
    if (!authHook.loader) return undefined
    await store.set(auth)
    await authHook.loader(async () => store.get())
    const next = await store.get()
    return next && next !== auth ? next : undefined
  }
}
