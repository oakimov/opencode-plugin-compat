import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createConfigSchema, providerSpecs, settingsAddress } from "../packages/dsh-bridge/src/settings.ts"
import { registerDshPlugin } from "../packages/dsh-bridge/src/register.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** Records the Schemastery calls the schema makes, without the DSH package. */
function recordingFactory() {
  const node = (shape: Record<string, unknown>, meta: Record<string, unknown> = {}): any => ({
    ...shape, meta,
    required: () => node(shape, { ...meta, required: true }),
    role: (role: string) => node(shape, { ...meta, role }),
    default: (value: unknown) => node(shape, { ...meta, default: value }),
    volatile: () => node(shape, { ...meta, volatile: true }),
  })
  return {
    object: (dict: Record<string, unknown>) => node({ type: "object", dict }),
    array: (inner: unknown) => node({ type: "array", inner }),
    string: () => node({ type: "string" }),
  }
}

describe("dsh-bridge Settings → Models contract", () => {
  test("providers are one volatile field; only Settings-read keys are declared", () => {
    const schema: any = createConfigSchema(recordingFactory())
    const providers = schema.dict.providers
    expect(providers.type).toBe("array")
    expect(providers.meta).toEqual({ default: [], volatile: true })
    expect(Object.keys(providers.inner.dict)).toEqual(["package", "apiKeyEnv"])
    expect(providers.inner.dict.package.meta).toEqual({ required: true })
    expect(providers.inner.dict.apiKeyEnv.meta).toEqual({ role: "credential-ref" })
  })

  test("providers are read from a frozen volatile snapshot as owned copies", () => {
    const snapshot = Object.freeze([Object.freeze({ package: "acme", apiKeyEnv: "ACME_API_KEY" })])
    const read = providerSpecs({ providers: { get: () => snapshot } }) as Array<Record<string, unknown>>
    expect(read).toEqual([{ package: "acme", apiKeyEnv: "ACME_API_KEY" }])
    expect(Object.isFrozen(read[0])).toBe(false)
    expect(providerSpecs({ providers: [{ package: "plain" }] })).toEqual([{ package: "plain" }])
  })

  test("rows address their profile entry and index", () => {
    expect(settingsAddress("ocp-dsh-bridge", 1)).toEqual({ settingsNs: "ocp-dsh-bridge", settingsPath: ["providers", "1"] })
    expect(settingsAddress(undefined, 0)).toBeUndefined()
  })

  for (const field of ["apiKeyEnv", "apiKey"] as const) {
    test(`registration declares the row and resolves credentials through ${field}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ocp-dsh-settings-")); roots.push(root)
      const packageDir = path.join(root, "acme-provider"); mkdirSync(packageDir)
      writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "acme-provider", type: "module", main: "index.js" }))
      writeFileSync(path.join(packageDir, "index.js"), `
        export function createAcme(options) { return { languageModel: () => ({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
          c.enqueue({ type: "text-start", id: "t" }); c.enqueue({ type: "text-delta", id: "t", delta: options.apiKey ?? "none" });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({ type: "finish", finishReason: { unified: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }); c.close()
        } }) }) }) } }
      `)
      const directory: unknown[] = []
      const resolved: string[] = []
      let adapter: any
      await registerDshPlugin({
        llm: {
          registerAdapter(_ids: string[], value: unknown) { adapter = value; return Object.assign(() => {}, { replace() {} }) },
          registerConfigurableProviders(entries: unknown[]) { directory.push(...entries) },
        },
        credentials: { resolve: async (ref: string) => { resolved.push(ref); return { value: "secret" } } },
      } as never, {
        package: packageDir, providerName: "acme", [field]: "ACME_API_KEY",
        models: [{ id: "m", name: "M" }],
      } as never, false, undefined, settingsAddress("ocp-dsh-bridge", 0))
      expect(directory).toEqual([{ provider: "acme", displayName: "acme", settingsNs: "ocp-dsh-bridge", settingsPath: ["providers", "0"] }])
      for await (const _ of adapter.stream({ provider: "acme", model: "m", messages: [] })) { /* drain */ }
      expect(resolved).toContain("ACME_API_KEY")
    })
  }
})
