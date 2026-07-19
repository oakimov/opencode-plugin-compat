import { describe, expect, test } from "bun:test"
import {
  FIXTURES,
  formatMatrix,
  matrixOk,
  runMatrix,
} from "../fixtures/index.ts"
import {
  createPluginContext,
  define,
  injectLanguageModel,
  injectSdk,
  isPromisePlugin,
  resolveProvider,
  runPromisePlugin,
  type LanguageModelV3Like,
} from "../packages/host-promise-v2/src/index.ts"

describe("@opencode-compat/host-promise-v2", () => {
  test("define + language injection", async () => {
    const plugin = define({
      async setup(ctx) {
        ctx.aisdk.on("language", async (_input, output) => {
          output.language = {
            specificationVersion: "v3",
            provider: "demo",
            modelId: "m1",
          } satisfies LanguageModelV3Like
        })
      },
    })
    const { ctx } = await runPromisePlugin(plugin, { plugin: { id: "demo" } })
    expect(ctx.aisdk.listenerCount("language")).toBe(1)
    expect(ctx.aisdk.events()).toEqual(["language"])
    const out = await injectLanguageModel(ctx, {
      providerID: "demo",
      modelID: "m1",
    })
    expect((out.language as LanguageModelV3Like).modelId).toBe("m1")
  })

  test("sdk hook + resolveProvider", async () => {
    const { ctx } = await runPromisePlugin({
      async setup(pluginCtx) {
        pluginCtx.aisdk.on("sdk", async (_input, output) => {
          output.tagged = true
        })
        pluginCtx.aisdk.on("language", async (_input, output) => {
          output.language = {
            specificationVersion: "v3",
            provider: "p",
            modelId: "m",
          }
        })
      },
    })
    const resolved = await resolveProvider(ctx, {
      providerID: "p",
      modelID: "m",
    })
    expect((resolved.language as LanguageModelV3Like).provider).toBe("p")
    expect(resolved.sdk.tagged).toBe(true)
    const sdkOnly = await injectSdk(ctx, {}, { base: 1 })
    expect(sdkOnly.base).toBe(1)
    expect(sdkOnly.tagged).toBe(true)
  })

  test("loud domain stubs", () => {
    const ctx = createPluginContext()
    expect(() => ctx.catalog.register("x")).toThrow(/catalog/)
    expect(isPromisePlugin({ setup() {} })).toBe(true)
    expect(isPromisePlugin({})).toBe(false)
    expect(() => define({} as never)).toThrow(/setup/)
  })
})

describe("OCP §10 fixtures", () => {
  test("ships all §10 fixture ids", () => {
    const ids = FIXTURES.map((f) => f.id).sort()
    expect(ids).toEqual(
      [
        "alias.resolve-plugin",
        "classic.auth.oauth-shape",
        "classic.chat-params",
        "classic.config-mutate",
        "classic.tool-before-after",
        "local.dot-opencode-scan",
        "v2.aisdk.language",
        "v2.unsupported-domain",
        "zcode.t0-doctor",
      ].sort(),
    )
  })

  test("matrix has no failures (skips allowed)", async () => {
    const results = await runMatrix()
    expect(matrixOk(results)).toBe(true)
    expect(results.some((r) => r.status === "pass")).toBe(true)
    expect(results.some((r) => r.status === "skip")).toBe(true)
    expect(results.every((r) => r.status !== "fail")).toBe(true)
    const text = formatMatrix(results)
    expect(text).toMatch(/pass=\d+ fail=0 skip=\d+/)
  })

  test("compat-scan turns mimo/kilo T2 local scan green", async () => {
    const without = await runMatrix({
      hosts: ["mimo", "kilo"],
      fixtureIds: ["local.dot-opencode-scan"],
    })
    expect(without.every((r) => r.status === "skip")).toBe(true)

    const withScan = await runMatrix({
      hosts: ["mimo", "kilo"],
      fixtureIds: ["local.dot-opencode-scan"],
      compatScanEnabled: true,
    })
    expect(withScan.every((r) => r.status === "pass")).toBe(true)
  })

  test("opencode T3 aisdk language passes", async () => {
    const results = await runMatrix({
      hosts: ["opencode"],
      fixtureIds: ["v2.aisdk.language"],
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("pass")
  })

  test("mimo T3 aisdk language skips until OCP wires promiseV2", async () => {
    const results = await runMatrix({
      hosts: ["mimo"],
      fixtureIds: ["v2.aisdk.language"],
    })
    expect(results[0]?.status).toBe("skip")
  })
})

describe("@opencode-compat/cli matrix", () => {
  test("matrix() runs fixtures", async () => {
    const { matrix, loadFixtures } = await import(
      "../packages/cli/src/index.ts"
    )
    const results = await matrix({
      hosts: ["zcode"],
      fixtureIds: ["zcode.t0-doctor"],
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("pass")
    const mod = await loadFixtures()
    expect(mod.matrixOk(results)).toBe(true)
  })
})