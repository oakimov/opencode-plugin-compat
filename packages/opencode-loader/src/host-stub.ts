/**
 * Minimal `PluginInput` stub for driving an unmodified OpenCode plugin outside
 * OpenCode.
 *
 * OpenCode hands plugins a rich host object; in practice an `aisdk`-type
 * provider plugin touches very little of it (`cursor-opencode-provider`, for
 * example, uses exactly `client.auth.set(...)` and `directory`). Rather than
 * emulate an OpenCode host, this supplies the small surface plugins actually
 * use and **loudly stubs** the rest — the same posture OCP's `host-promise-v2`
 * takes: a stub that throws a clear, attributable error beats one that silently
 * returns undefined and produces a confusing failure three layers later.
 *
 * `client.auth.set` is not merely tolerated, it is load-bearing: it is how a
 * plugin hands back credentials it refreshed inside `auth.loader`, which is how
 * this bridge implements Pi's required `oauth.refreshToken`.
 */
import type { OpenCodeAuth } from "./types.js"

export type AuthStore = {
  get(): Promise<OpenCodeAuth | undefined>
  set(auth: OpenCodeAuth): Promise<void>
}

/** In-memory credential store, seeded from whatever the host resolved. */
export function createMemoryAuthStore(initial?: OpenCodeAuth): AuthStore {
  let current = initial
  return {
    async get() {
      return current
    },
    async set(auth) {
      current = auth
    },
  }
}

export type PluginInputStub = {
  client: unknown
  directory: string
  worktree: string
  app: unknown
  $: unknown
  /** Credentials the plugin wrote back during this session (refresh capture). */
  readonly store: AuthStore
}

function loudStub(surface: string): never {
  throw new Error(
    `pi-bridge: this OpenCode plugin called host API "${surface}", which the Pi-family bridge does not emulate. ` +
      `Provider plugins that only register an AI-SDK model + auth/config hooks do not need it; if a plugin genuinely ` +
      `requires it, it is not usable through this bridge without adding that surface.`,
  )
}

/** Recursively-throwing proxy so any unstubbed nested access reports its own path. */
function loudProxy(path: string): unknown {
  return new Proxy(function () {} as unknown as object, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === Symbol.toStringTag) {
        return () => `[pi-bridge stub ${path}]`
      }
      if (prop === "then") return undefined // never look thenable to `await`
      return loudProxy(`${path}.${String(prop)}`)
    },
    apply() {
      return loudStub(path)
    },
  })
}

export type PluginInputStubOptions = {
  directory: string
  worktree?: string
  store?: AuthStore
  /** Provider id used to scope `client.auth.*` calls. */
  providerId?: string
}

/**
 * Build the stub. `client.auth.get/set` are real (backed by {@link AuthStore});
 * `client.app.*`, `$`, and every other client domain are loud stubs.
 */
export function createPluginInputStub(options: PluginInputStubOptions): PluginInputStub {
  const store = options.store ?? createMemoryAuthStore()

  const auth = {
    async set(args: { path?: { id?: string }; body?: OpenCodeAuth } | OpenCodeAuth) {
      const body = (args as { body?: OpenCodeAuth }).body ?? (args as OpenCodeAuth)
      if (body && typeof body === "object" && "type" in body) await store.set(body)
      return { data: body }
    },
    async get(_args?: unknown) {
      return { data: await store.get() }
    },
    async all() {
      const current = await store.get()
      return { data: current && options.providerId ? { [options.providerId]: current } : {} }
    },
    async remove(_args?: unknown) {
      return { data: undefined }
    },
  }

  const client = new Proxy(
    { auth },
    {
      get(target, prop) {
        if (prop === "auth") return target.auth
        if (prop === "then") return undefined
        return loudProxy(`client.${String(prop)}`)
      },
    },
  )

  return {
    client,
    directory: options.directory,
    worktree: options.worktree ?? options.directory,
    app: loudProxy("app"),
    $: loudProxy("$"),
    store,
  }
}
