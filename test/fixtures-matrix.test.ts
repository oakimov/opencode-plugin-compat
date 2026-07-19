import { describe, expect, test } from "bun:test"
import {
  FIXTURES,
  formatMatrix,
  matrixOk,
  runMatrix,
} from "../fixtures/index.ts"
import {
  createPluginContext,
  createPromiseV2Host,
  define,
  injectLanguageModel,
  injectSdk,
  isPromisePlugin,
  resolveProvider,
  runPromisePlugin,
  type LanguageModelV3Like,
} from "../packages/host-promise-v2/src/index.ts"

describe("@opencode-compat/host-promise-v2", () => {
  test("define + language injection (OpenCode aisdk shape)", async () => {
    const plugin = define({
      id: "demo",
      async setup(ctx) {
        await ctx.aisdk.language(async (event) => {
          event.language = {
            specificationVersion: "v3",
            provider: "demo",
            modelId: "m1",
          } satisfies LanguageModelV3Like
        })
      },
    })
    const { ctx } = await runPromisePlugin(plugin)
    expect(ctx.aisdk.listenerCount("language")).toBe(1)
    expect(ctx.aisdk.events()).toEqual(["language"])
    const out = await injectLanguageModel(ctx, {
      providerID: "demo",
      modelID: "m1",
    })
    expect((out.language as LanguageModelV3Like).modelId).toBe("m1")
  })

  test("sdk hook + resolveProvider via host", async () => {
    const host = createPromiseV2Host()
    await host.register({
      id: "sdk-demo",
      async setup(pluginCtx) {
        await pluginCtx.aisdk.sdk(async (event) => {
          event.sdk = { tagged: true }
        })
        await pluginCtx.aisdk.language(async (event) => {
          event.language = {
            specificationVersion: "v3",
            provider: "p",
            modelId: "m",
          }
        })
      },
    })
    const resolved = await host.resolveProvider({
      providerID: "p",
      modelID: "m",
      package: "demo-pkg",
    })
    expect((resolved.language as LanguageModelV3Like).provider).toBe("p")
    expect((resolved.sdk as { tagged: boolean }).tagged).toBe(true)
    expect(host.plugins()).toEqual(["sdk-demo"])

    const sdkOnly = await injectSdk(host.ctx, { providerID: "p", modelID: "m" }, {
      sdk: { base: 1 },
    })
    // Registered sdk hook mutates/replaces event.sdk (OpenCode mutable-event shape)
    expect((sdkOnly.sdk as { tagged: boolean }).tagged).toBe(true)
  })

  test("loud domain stubs + define validation", () => {
    const ctx = createPluginContext()
    expect(() => ctx.catalog.register("x")).toThrow(/catalog/)
    expect(isPromisePlugin({ id: "x", setup() {} })).toBe(true)
    expect(isPromisePlugin({ setup() {} })).toBe(false)
    expect(isPromisePlugin({})).toBe(false)
    expect(() => define({} as never)).toThrow(/setup/)
    expect(() =>
      define({ id: "", async setup() {} }),
    ).toThrow(/non-empty string id/)
  })

  test("resolveProvider on ctx mirrors host path", async () => {
    const { ctx } = await runPromisePlugin({
      id: "resolve-ctx",
      async setup(pluginCtx) {
        await pluginCtx.aisdk.language(async (event) => {
          event.language = {
            specificationVersion: "v3",
            provider: event.model.providerID,
            modelId: event.model.api.id,
          }
        })
      },
    })
    const out = await resolveProvider(ctx, {
      providerID: "acme",
      modelID: "x",
    })
    expect((out.language as LanguageModelV3Like).modelId).toBe("x")
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

  test("mimo/kilo T3 aisdk language passes via OCP host kit", async () => {
    const results = await runMatrix({
      hosts: ["mimo", "kilo"],
      fixtureIds: ["v2.aisdk.language"],
    })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === "pass")).toBe(true)
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

describe("@opencode-compat/adapter wirePromiseV2", () => {
  test("wires host kit for mimo", async () => {
    const { wirePromiseV2 } = await import("../packages/adapter/src/index.ts")
    const host = wirePromiseV2({
      env: { OPENCODE_COMPAT_HOST: "mimo" },
      home: "/tmp",
    })
    await host.register({
      id: "adapter-wire",
      async setup(ctx) {
        await ctx.aisdk.language(async (event) => {
          event.language = {
            specificationVersion: "v3",
            provider: "wire",
            modelId: event.model.id,
          }
        })
      },
    })
    const out = await host.resolveProvider({
      providerID: "wire",
      modelID: "m",
    })
    expect((out.language as LanguageModelV3Like).provider).toBe("wire")
  })

  test("refuses zcode", async () => {
    const { wirePromiseV2 } = await import("../packages/adapter/src/index.ts")
    expect(() =>
      wirePromiseV2({
        env: { OPENCODE_COMPAT_HOST: "zcode" },
        home: "/tmp",
      }),
    ).toThrow(/not supported|T0/)
  })
})