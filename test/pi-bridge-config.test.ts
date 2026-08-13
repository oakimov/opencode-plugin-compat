/**
 * Config file handling + end-to-end registration through the config path.
 *
 * `registerProvidersFromConfig`'s error isolation matters because a host's
 * extension loader treats a thrown extension factory as a total load failure —
 * one bad provider entry must not stop the others in the same file.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { configSearchPaths, loadConfig, registerProvidersFromConfig, resolveConfigPath } from "../packages/pi-bridge/src/config.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "pi-bridge-acme-provider.ts")
const AUTH_CATALOG_FIXTURE = path.join(import.meta.dir, "fixtures", "pi-bridge-auth-catalog-provider.ts")

async function refreshRegisteredModels(config: Record<string, unknown>, apiKey: string) {
  if (typeof config.fetchDynamicModels === "function") {
    return config.fetchDynamicModels(apiKey)
  }
  if (typeof config.refreshModels === "function") {
    return config.refreshModels({
      credential: { type: "oauth", access: apiKey, refresh: "refresh", expires: 1_900_000_000_000 },
      allowNetwork: true,
      signal: new AbortController().signal,
    })
  }
  throw new Error("registered provider has no dynamic model refresh")
}

describe("config path resolution", () => {
  test("PI_BRIDGE_CONFIG wins outright", () => {
    expect(configSearchPaths({ PI_BRIDGE_CONFIG: "/custom/path.json" })).toEqual(["/custom/path.json"])
  })

  test("both hosts' agent dirs are searched, so one file works on either", () => {
    const paths = configSearchPaths({ HOME: "/home/x" })
    expect(paths).toContain("/home/x/.omp/agent/pi-bridge.json")
    expect(paths).toContain("/home/x/.pi/agent/pi-bridge.json")
  })

  test("PI_CODING_AGENT_DIR is searched first when set", () => {
    expect(configSearchPaths({ HOME: "/home/x", PI_CODING_AGENT_DIR: "/custom/agent" })[0]).toBe("/custom/agent/pi-bridge.json")
  })

  test("resolveConfigPath returns undefined when nothing exists", () => {
    expect(resolveConfigPath({ HOME: path.join(tmpdir(), "pi-bridge-nonexistent-home") })).toBeUndefined()
  })
})

describe("loadConfig", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-bridge-config-test-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("returns undefined when the file doesn't exist", () => {
    expect(loadConfig(path.join(dir, "nope.json"))).toBeUndefined()
  })

  test("a provider entry needs only a package name", () => {
    const file = path.join(dir, "minimal.json")
    writeFileSync(file, JSON.stringify({ providers: [{ package: "cursor-opencode-provider" }] }))
    expect(loadConfig(file)).toEqual({ providers: [{ package: "cursor-opencode-provider" }] })
  })

  test("the older packageSpecifier key is still accepted, normalized to package", () => {
    const file = path.join(dir, "legacy.json")
    writeFileSync(file, JSON.stringify({ providers: [{ packageSpecifier: "some-plugin", providerName: "x" }] }))
    expect(loadConfig(file)).toEqual({ providers: [{ package: "some-plugin", providerName: "x" }] })
  })

  test("throws for an entry with no package at all", () => {
    const file = path.join(dir, "invalid.json")
    writeFileSync(file, JSON.stringify({ providers: [{ providerName: "x" }] }))
    expect(() => loadConfig(file)).toThrow(/must be an array of/)
  })

  test("throws when providers isn't an array", () => {
    const file = path.join(dir, "not-array.json")
    writeFileSync(file, JSON.stringify({ providers: "nope" }))
    expect(() => loadConfig(file)).toThrow(/must be an array of/)
  })
})

describe("registerProvidersFromConfig", () => {
  test("registers a plugin from a package name alone — id, models and oauth all come from the plugin", async () => {
    const registered: Array<{ name: string; config: Record<string, unknown> }> = []
    const pi = { registerProvider: (name: string, config: Record<string, unknown>) => registered.push({ name, config }) }

    await registerProvidersFromConfig(pi, { providers: [{ package: FIXTURE }] })

    expect(registered).toHaveLength(1)
    // Provider id came from the plugin's own auth hook, not the file path.
    expect(registered[0]!.name).toBe("acme")
    expect(registered[0]!.config.api).toBe("acme-bridge")
    expect(typeof registered[0]!.config.streamSimple).toBe("function")
    expect(registered[0]!.config.oauth).toBeDefined()
    expect(registered[0]!.config.models).toHaveLength(2)
  })

  test("a broken entry is isolated: the following entry still registers", async () => {
    const registered: string[] = []
    const pi = { registerProvider: (name: string) => registered.push(name) }
    const originalConsoleError = console.error
    const errors: string[] = []
    console.error = (msg: string) => errors.push(String(msg))
    try {
      await registerProvidersFromConfig(pi, {
        providers: [
          { package: "definitely-does-not-exist-anywhere", providerName: "broken" },
          { package: FIXTURE, providerName: "fine-one" },
        ],
      })
    } finally {
      console.error = originalConsoleError
    }

    expect(registered).toEqual(["fine-one"])
    expect(errors.some(e => e.includes("broken"))).toBe(true)
  })

  test("an explicit providerName/api overrides what the plugin declares", async () => {
    const registered: Array<{ name: string; config: Record<string, unknown> }> = []
    const pi = { registerProvider: (name: string, config: Record<string, unknown>) => registered.push({ name, config }) }

    await registerProvidersFromConfig(pi, { providers: [{ package: FIXTURE, providerName: "my-acme", api: "my-acme-api" }] })

    expect(registered[0]!.name).toBe("my-acme")
    expect(registered[0]!.config.api).toBe("my-acme-api")
  })

  test("disableOAuth registers the provider without the plugin's auth hook", async () => {
    const registered: Array<{ config: Record<string, unknown> }> = []
    const pi = { registerProvider: (_name: string, config: Record<string, unknown>) => registered.push({ config }) }

    await registerProvidersFromConfig(pi, { providers: [{ package: FIXTURE, disableOAuth: true, apiKey: "ACME_API_KEY" }] })

    expect(registered[0]!.config.oauth).toBeUndefined()
    expect(registered[0]!.config.apiKey).toBe("ACME_API_KEY")
  })

  test("successful login makes a credential-gated catalog available on the host refresh", async () => {
    const registered: Array<{ config: Record<string, unknown> }> = []
    const pi = { registerProvider: (_name: string, config: Record<string, unknown>) => registered.push({ config }) }

    await registerProvidersFromConfig(pi, { providers: [{ package: AUTH_CATALOG_FIXTURE }] })

    const config = registered[0]!.config
    expect(config.models).toBeUndefined()
    const oauth = config.oauth as {
      login(callbacks: { onAuth(info: unknown): void }): Promise<{ access: string }>
    }
    const credential = await oauth.login({ onAuth: () => {} })
    const models = await refreshRegisteredModels(config, credential.access)

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe("auth-model")
  })

  test("a host-restored credential refreshes a gated catalog after bridge restart", async () => {
    const registered: Array<{ config: Record<string, unknown> }> = []
    const pi = { registerProvider: (_name: string, config: Record<string, unknown>) => registered.push({ config }) }

    await registerProvidersFromConfig(pi, { providers: [{ package: AUTH_CATALOG_FIXTURE }] })
    const models = await refreshRegisteredModels(registered[0]!.config, "restored-access-token")

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe("auth-model")
  })

})
