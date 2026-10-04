import { beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createPluginInputStub } from "../packages/opencode-loader/src/host-stub.ts"
import { registerDshPlugin } from "../packages/dsh-bridge/src/register.ts"
import { factoryKeys, loaderKeys } from "./fixtures/dsh-auth-provider.ts"
import { offered, seenAuth } from "./fixtures/dsh-auth-methods-provider.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "dsh-auth-provider.ts")

describe("dsh provider authentication", () => {
  beforeEach(() => {
    loaderKeys.length = 0
    factoryKeys.length = 0
  })

  test("absent client.session does not throw, and other client keys do", () => {
    const stub = createPluginInputStub({
      directory: "/tmp/workspace",
      bridgeName: "dsh-bridge",
      absentClientKeys: ["session"],
    })
    const client = stub.client as { session?: { promptAsync?: () => void }; app: { missing(): void } }
    expect(client.session).toBeUndefined()
    expect(() => client.app.missing()).toThrow(/dsh-bridge: this OpenCode plugin called host API "client.app.missing"/)
  })

  test("a resolved credential runs auth.loader before the catalog is read", async () => {
    const registered: unknown[] = []
    const result = await registerDshPlugin({
      llm: { registerAdapter: (_names, adapter) => { registered.push(adapter); return () => {} } },
      credentials: { resolve: async () => ({ value: "durable-key" }) },
    }, { package: FIXTURE, apiKey: "DSH_AUTH_KEY" })

    expect(result.modelCount).toBe(1)
    expect(result.hasOAuth).toBe(true)
    expect(loaderKeys).toEqual(["durable-key"])
    expect(registered).toHaveLength(1)
  })

  test("each generate prepares the credential again and passes it to the factory", async () => {
    let adapter: { stream: (options: { model: string; messages: [] }) => AsyncIterable<unknown> } | undefined
    await registerDshPlugin({
      llm: { registerAdapter: (_names, next) => { adapter = next as typeof adapter; return () => {} } },
      credentials: { resolve: async () => ({ value: "durable-key" }) },
    }, { package: FIXTURE, apiKey: "DSH_AUTH_KEY", createOptions: { apiKey: "$apiKey" } })

    expect(adapter).toBeDefined()
    const chunks = []
    for await (const chunk of adapter!.stream({ model: "auth-model", messages: [] })) chunks.push(chunk)
    expect(loaderKeys).toEqual(["durable-key", "durable-key"])
    expect(factoryKeys).toEqual(["durable-key"])
    expect(chunks.some(chunk => (chunk as { type?: string }).type === "finish")).toBe(true)
  })

  test("without a credential the loader does not invent one and the catalog stays empty", async () => {
    const result = await registerDshPlugin({
      llm: { registerAdapter: () => () => {} },
      credentials: { resolve: async () => undefined },
    }, { package: FIXTURE, apiKey: "DSH_AUTH_KEY" })
    expect(result.modelCount).toBe(0)
    expect(loaderKeys).toEqual([])
  })

  describe("a resolved CredentialRef is an API key, not an OAuth session", () => {
    const METHODS = path.join(import.meta.dir, "fixtures", "dsh-auth-methods-provider.ts")
    const register = (spec: Record<string, unknown>) => registerDshPlugin({
      llm: { registerAdapter: () => () => {} },
      credentials: { resolve: async () => ({ value: "crsr_raw" }) },
    }, { package: METHODS, apiKeyEnv: "CURSOR_API_KEY", ...spec } as never)
    beforeEach(() => { seenAuth.length = 0; offered.methods = ["oauth", "api"] })

    test("the plugin's API method receives the key even when OAuth is listed first", async () => {
      await register({})
      expect(seenAuth).toEqual([{ type: "api", key: "crsr_raw" }])
    })

    test("an explicit preferAuthMethod still selects OAuth", async () => {
      await register({ preferAuthMethod: "oauth" })
      expect(seenAuth[0]).toMatchObject({ type: "oauth", access: "crsr_raw" })
    })

    test("an OAuth-only plugin keeps its only method", async () => {
      offered.methods = ["oauth"]
      await register({})
      expect(seenAuth[0]).toMatchObject({ type: "oauth", access: "crsr_raw" })
    })
  })
})
