/**
 * The generic OpenCode-plugin surface: shape detection, the `PluginInput` stub,
 * `auth` → Pi oauth, and `config` → Pi models.
 *
 * Everything is exercised through `test/fixtures/pi-bridge-acme-provider.ts`, a
 * synthetic plugin that implements only standard OpenCode conventions. That it
 * works with zero per-plugin code in the bridge is the actual claim under test.
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { buildPiOAuth, createLoaderRunner, openCodeAuthFromOAuthCallback, openCodeAuthFromResolvedKey, toOpenCodeAuth, toPiCredentials, tokenExpiryMs } from "../packages/pi-bridge/src/opencode/auth.ts"
import { createMemoryAuthStore, createPluginInputStub } from "../packages/pi-bridge/src/opencode/host-stub.ts"
import { derivePackageName, detectAiSdkFactory, detectPluginFactory, instantiateHooks, loadOpenCodePluginModule } from "../packages/pi-bridge/src/opencode/load.ts"
import { extractModelsFromConfigHook, toPiModel } from "../packages/pi-bridge/src/opencode/models.ts"
import { loadModuleThroughHost } from "../packages/pi-bridge/src/host-module-loader.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "pi-bridge-acme-provider.ts")

async function loadFixtureHooks() {
  const loaded = await loadOpenCodePluginModule({ packageSpecifier: FIXTURE })
  const stub = createPluginInputStub({ directory: "/tmp/workspace" })
  const hooks = await instantiateHooks(loaded.pluginFactory!, stub)
  return { loaded, stub, hooks }
}

describe("shape detection", () => {
  test("loads a provider through the host's static extension graph", async () => {
    const loaded = await loadModuleThroughHost({
      registerProvider() {},
      pi: {
        getPluginsDir: () => "/unused",
        async loadExtensions(paths) {
          for (const extensionPath of paths) {
            const extension = await import(`${extensionPath}?test=${Date.now()}`)
            await extension.default({})
          }
          return { errors: [] }
        },
      },
    }, FIXTURE)
    expect(typeof loaded?.createAcme).toBe("function")
    expect(typeof loaded?.AcmePlugin).toBe("function")
  })

  test("bare package names without getPluginsDir do not throw a host-API error", async () => {
    const loaded = await loadModuleThroughHost({
      registerProvider() {},
      pi: {
        async loadExtensions() {
          return { errors: [] }
        },
      },
    }, "definitely-not-installed-opencode-provider")
    expect(loaded).toBeUndefined()
  })

  test("finds both conventions on one module without them colliding", async () => {
    const loaded = await loadOpenCodePluginModule({ packageSpecifier: FIXTURE })
    expect(typeof loaded.factory).toBe("function")
    expect(typeof loaded.pluginFactory).toBe("function")
    // The AI-SDK factory must not be mistaken for the plugin factory.
    expect(loaded.factory).not.toBe(loaded.pluginFactory)
  })

  test("detectAiSdkFactory picks the sole createXxx export", () => {
    const createFoo = () => ({ languageModel: () => ({}) })
    expect(detectAiSdkFactory({ createFoo, other: 1 })).toBe(createFoo as never)
  })

  test("detectAiSdkFactory refuses to guess between multiple createXxx exports", () => {
    const createFoo = () => ({ languageModel: () => ({}) })
    const createBar = () => ({ languageModel: () => ({}) })
    expect(() => detectAiSdkFactory({ createFoo, createBar })).toThrow(/multiple createXxx exports/)
  })

  test("detectAiSdkFactory prefers create<Package> from a dist/index.js path", () => {
    const createDevin = () => ({ languageModel: () => ({}) })
    const createWindsurf = () => ({ languageModel: () => ({}) })
    expect(detectAiSdkFactory(
      { createDevin, createWindsurf },
      undefined,
      "/abs/devin-opencode-provider/dist/index.js",
    )).toBe(createDevin as never)
  })

  test("detectPluginFactory prefers a *Plugin export over the default export", () => {
    const AcmePlugin = () => ({})
    const other = () => ({})
    expect(detectPluginFactory({ AcmePlugin, default: other })).toBe(AcmePlugin as never)
  })

  test("detectPluginFactory returns undefined when a module has only an AI-SDK factory", () => {
    const createFoo = () => ({ languageModel: () => ({}) })
    expect(detectPluginFactory({ createFoo, default: createFoo }, { exclude: createFoo })).toBeUndefined()
  })

  test("derivePackageName handles bare, scoped, and path specifiers", () => {
    expect(derivePackageName("cursor-opencode-provider")).toBe("cursor-opencode-provider")
    expect(derivePackageName("@foo/bar")).toBe("foo-bar")
    expect(derivePackageName("/abs/path/dist/index.js")).toBe("index")
  })
})

describe("PluginInput stub", () => {
  test("client.auth.set is real and captures what the plugin persists", async () => {
    const stub = createPluginInputStub({ directory: "/tmp/w" })
    await (stub.client as { auth: { set(a: unknown): Promise<unknown> } }).auth.set({
      path: { id: "acme" },
      body: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    })
    expect(await stub.store.get()).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 1 })
  })

  test("an unemulated host API throws an attributable error instead of failing silently", async () => {
    const stub = createPluginInputStub({ directory: "/tmp/w" })
    expect(() => (stub.client as unknown as { session: { list(): void } }).session.list()).toThrow(/does not emulate/)
  })
})

describe("auth translation", () => {
  test("credential shapes round-trip between OpenCode and Pi", () => {
    const piCreds = toPiCredentials({ type: "oauth", access: "a", refresh: "r", expires: 123 })
    expect(piCreds).toEqual({ access: "a", refresh: "r", expires: 123 })
    expect(toOpenCodeAuth(piCreds)).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 123 })
  })

  test("an API-key credential is normalized into the same shape, keeping its refresh token", () => {
    const creds = toPiCredentials({ type: "api", key: "exchanged:acme_x", metadata: { refreshToken: "r" } })
    expect(creds.access).toBe("exchanged:acme_x")
    expect(creds.refresh).toBe("r")
  })

  test("tokenExpiryMs decodes a JWT exp, and falls back an hour out", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000 })).toString("base64url")
    expect(tokenExpiryMs(`h.${payload}.s`)).toBe(2_000_000_000)
    expect(tokenExpiryMs("not-a-jwt", 1_000)).toBe(1_000 + 3_600_000)
    expect(tokenExpiryMs(undefined, 1_000)).toBe(1_000 + 3_600_000)
  })

  test("OAuth callback success may return {key} instead of {access,refresh,expires}", () => {
    expect(openCodeAuthFromOAuthCallback({ type: "success", key: "devin-session-token$abc" })).toEqual({
      type: "api",
      key: "devin-session-token$abc",
    })
    expect(openCodeAuthFromOAuthCallback({
      type: "success",
      access: "a",
      refresh: "r",
      expires: 9,
    })).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 9 })
  })

  test("OAuth login accepts a plugin that returns the OpenCode {key} success shape", async () => {
    const oauth = buildPiOAuth({
      authHook: {
        provider: "acme",
        methods: [{
          type: "oauth",
          label: "Acme",
          async authorize() {
            return {
              url: "https://acme.example/login",
              async callback() {
                return { type: "success" as const, provider: "acme", key: "k" }
              },
            }
          },
        }],
      },
    })!
    const credentials = await oauth.login({ onAuth: () => {} })
    expect(credentials.access).toBe("k")
    expect(oauth.getApiKey(credentials)).toBe("k")
  })

  test("a resolved host key is reconstructed using the selected plugin auth method", async () => {
    const { hooks } = await loadFixtureHooks()
    expect(openCodeAuthFromResolvedKey(hooks.auth!, "oauth-access")).toMatchObject({
      type: "oauth",
      access: "oauth-access",
      refresh: "",
    })
    expect(openCodeAuthFromResolvedKey(hooks.auth!, "api-access", "api")).toEqual({
      type: "api",
      key: "api-access",
    })
  })

  test("OAuth login drives the plugin's own authorize()/callback() flow", async () => {
    const { hooks, stub } = await loadFixtureHooks()
    const oauth = buildPiOAuth({ authHook: hooks.auth!, authStore: stub.store })!

    let shownUrl: string | undefined
    const credentials = await oauth.login({
      onAuth: info => {
        shownUrl = info.url
      },
      onPrompt: async () => "",
    })

    expect(shownUrl).toBe("https://acme.example/login?challenge=abc")
    expect(credentials).toEqual({ access: "acme-access-token", refresh: "acme-refresh-token", expires: 1_800_000_000_000 })
    expect(oauth.getApiKey(credentials)).toBe("acme-access-token")
    expect(await stub.store.get()).toEqual({
      type: "oauth",
      access: "acme-access-token",
      refresh: "acme-refresh-token",
      expires: 1_800_000_000_000,
    })
  })

  test("the API-key method's prompts are driven through the host's onPrompt", async () => {
    const { hooks } = await loadFixtureHooks()
    const oauth = buildPiOAuth({ authHook: hooks.auth!, prefer: "api" })!

    const asked: string[] = []
    const credentials = await oauth.login({
      onAuth: () => {},
      onPrompt: async prompt => {
        asked.push(prompt.message)
        return "acme_secret"
      },
    })

    expect(asked).toEqual(["Acme API key"])
    expect(credentials.access).toBe("exchanged:acme_secret")
  })

  test("a prompt failing the plugin's own validate() is rejected", async () => {
    const { hooks } = await loadFixtureHooks()
    const oauth = buildPiOAuth({ authHook: hooks.auth!, prefer: "api" })!
    await expect(oauth.login({ onAuth: () => {}, onPrompt: async () => "wrong-prefix" })).rejects.toThrow(/should start with acme_/)
  })

  test("refreshToken renews via the plugin's loader and reads back what it persisted", async () => {
    const { hooks, stub } = await loadFixtureHooks()
    const oauth = buildPiOAuth({ authHook: hooks.auth!, runLoader: createLoaderRunner(hooks.auth!, stub.store) })!

    const refreshed = await oauth.refreshToken({ access: "old", refresh: "acme-refresh-token", expires: 1 })
    expect(refreshed.access).toBe("acme-access-token-v2")
    expect(refreshed.refresh).toBe("acme-refresh-token")
  })

  test("credentials with no refresh material are returned unchanged rather than erroring", async () => {
    const { hooks, stub } = await loadFixtureHooks()
    const oauth = buildPiOAuth({ authHook: hooks.auth!, runLoader: createLoaderRunner(hooks.auth!, stub.store) })!
    const creds = { access: "bare-api-key", refresh: "", expires: 0 }
    expect(await oauth.refreshToken(creds)).toBe(creds)
  })

  test("a plugin with no auth methods yields no oauth config", () => {
    expect(buildPiOAuth({ authHook: { provider: "x", methods: [] } })).toBeUndefined()
  })
})

describe("model translation", () => {
  test("models come straight from the plugin's config hook", async () => {
    const { hooks } = await loadFixtureHooks()
    const { providerId, models } = await extractModelsFromConfigHook(hooks, "acme")

    expect(providerId).toBe("acme")
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({
      id: "acme-large",
      name: "Acme Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    })
  })

  test("sparse entries fall back to sane defaults instead of NaN/undefined", () => {
    expect(toPiModel("m", {})).toEqual({
      id: "m",
      name: "m",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    })
  })

  test("a plugin without a config hook yields no models rather than throwing", async () => {
    expect(await extractModelsFromConfigHook({})).toEqual({ models: [], callData: new Map() })
  })
})

describe("memory auth store", () => {
  test("seeds from initial credentials and accepts updates", async () => {
    const store = createMemoryAuthStore({ type: "oauth", access: "a", refresh: "r", expires: 1 })
    expect((await store.get())?.type).toBe("oauth")
    await store.set({ type: "api", key: "k" })
    expect(await store.get()).toEqual({ type: "api", key: "k" })
  })
})
