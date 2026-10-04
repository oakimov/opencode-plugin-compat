import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { adaptLanguageModel, policyForHostId } from "../packages/adapter/src/language-model.ts"
import { providerUsageIntegrationForHost, usageEventPlugin } from "../packages/adapter/src/provider-usage.ts"
import { resetUsageReconciliationForTests } from "../packages/adapter/src/usage-reconciliation.ts"
import { renderProviderShimSource, stripProviderShimSource } from "../packages/adapter/src/shim-source.ts"

const roots: string[] = []
afterEach(() => { resetUsageReconciliationForTests(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const finish = {
  type: "finish", finishReason: { unified: "stop" },
  usage: { inputTokens: { total: 304, cacheRead: 86720, cacheWrite: 0 }, outputTokens: { total: 20, text: 20 } },
  providerMetadata: { devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720, cacheWrite: 0 } } },
}

for (const host of ["kilo", "mimo"]) {
  for (const mode of ["stream", "generate"]) {
    test(`${host} ${mode}: explicitly selected Devin keeps billed aggregates and a separate context diagnostic`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ocp-clone-usage-")); roots.push(root)
      const usage = providerUsageIntegrationForHost(host, { XDG_CACHE_HOME: root, HOME: root }, "devin-opencode-provider")
      const model = adaptLanguageModel({
        async doStream() { return { stream: new ReadableStream({ start(c) { c.enqueue(finish); c.close() } }) } },
        async doGenerate() { return { ...finish, type: undefined, content: [{ type: "text", text: "ok" }] } },
      }, policyForHostId(host), undefined, undefined, usage)
      const options = { headers: { "x-opencode-session-id": "session" } }
      let reported: any
      if (mode === "stream") { for await (const part of (await model.doStream(options as never)).stream) reported = part }
      else reported = await model.doGenerate(options as never)
      expect(reported.usage.inputTokens.total + reported.usage.outputTokens.total).toBe(324)
      expect(reported.usage.inputTokens.noCache).toBe(304)
      expect(reported.usage.inputTokens.cacheRead).toBe(0)
      expect(reported.providerMetadata.ocpContext).toEqual({ promptTokens: 87024, contextTokens: 87044 })
      expect(reported.providerMetadata.devin).toEqual(finish.providerMetadata.devin)
      // A generic provider opting into the neutral contract also gets the
      // public event hook, without implementing a structural bridge itself.
      usage!.recordFinishUsage("session", {
        ...finish, usage: { inputTokens: { total: 87024 }, outputTokens: { total: 20 } },
        providerMetadata: { acme: { usageVersion: 3, inputTokensRaw: 304, outputTokensRaw: 20,
          cacheReadRaw: 0, cacheWriteRaw: 0, reasoningTokensRaw: 0 } },
      })
      const updates: any[] = []
      const input = { client: { _client: { patch: async (request: any) => { updates.push(request.body) } } }, directory: "/workspace", serverUrl: new URL("http://127.0.0.1:4096") }
      const hooks: any = await usageEventPlugin(host)(input)
      const part = { id: "part", messageID: "message", sessionID: "session", type: "step-finish", reason: "stop", tokens: { total: 87044, input: 87024, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }
      const properties = { part }
      // Kilo hands each plugin hook its own envelope around one payload; a
      // provider that forwards events itself delivers the same payload again.
      await hooks.event({ event: { id: "evt", type: "message.part.updated", properties } })
      await hooks.event({ event: { id: "evt", type: "message.part.updated", properties } })
      const bridge = (globalThis as any)[Symbol.for("opencode.host.event-bridge")]
      await bridge.handle({ ...input, event: { type: "message.part.updated", properties } })
      expect(updates).toHaveLength(1)
      expect(updates[0].tokens).toEqual({ total: 324, input: 304, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(part.tokens.total).toBe(87044)
    })
  }
  test(`${host}: generic aggregate-only and contradictory counts remain disjoint without provider activation`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-generic-usage-")); roots.push(root)
    const integration = providerUsageIntegrationForHost(host, { XDG_CACHE_HOME: root, HOME: root }, "acme-provider")
    expect(integration?.projectFinish).toBeUndefined()
    const model = adaptLanguageModel({ async doGenerate() { return { content: [], ...finish } } }, policyForHostId(host), undefined, undefined, integration)
    const result = await model.doGenerate()
    expect(result.usage.inputTokens).toEqual({ total: 304, noCache: 0, cacheRead: 304, cacheWrite: 0 })
    expect(result.providerMetadata).toEqual(finish.providerMetadata)
    const aggregate = adaptLanguageModel({ async doGenerate() { return { content: [], usage: { inputTokens: { total: 100 }, outputTokens: { total: 20 } } } } }, policyForHostId(host))
    expect((await aggregate.doGenerate()).usage.inputTokens.noCache).toBe(100)
  })
}

test("event-only plugin is inert outside clone hosts or without the public transport", async () => {
  expect(await usageEventPlugin("opencode")({ client: {}, directory: "/w", serverUrl: new URL("http://127.0.0.1") })).toEqual({})
  expect(await usageEventPlugin("kilo")({ directory: "/w" })).toEqual({})
})

test("generated plugin-event instrumentation is reversible and keeps provider export identities", async () => {
  const meta = { entry: "index.js", packageName: "acme-provider", factories: [{ exportName: "createAcme", localName: "createAcme", declaration: "function" as const }], strategy: "instrumented-entry" as const }
  const stocks = [
    "export function createAcme() {}\nconst Plugin = async () => ({})\nexport { Plugin };\nexport default Plugin;\n",
    "export function createAcme() {}\nexport const Plugin = async () => ({})\nexport default Plugin\n",
    "export function createAcme() {}\nconst Plugin = async () => ({})\nexport { Plugin as default, Plugin };\n",
    "export function createAcme() {}\nexport default createAcme;\n",
    "export function createAcme() {}\n",
  ]
  for (const stock of stocks) {
    const generated = renderProviderShimSource(meta, stock)
    expect(stripProviderShimSource(generated)).toBe(stock)
    expect(generated).toContain('providerUsageIntegrationForHost(__host, process.env, "acme-provider")')
    expect(generated.includes("export const __ocpUsageEvents")).toBe(/Plugin/.test(stock))
    // Stock exports are untouched, so a host that calls every distinct
    // function export instantiates the provider plugin exactly once.
    expect(generated).toContain(stock.slice(stock.indexOf("\n") + 1))
  }
})

test("a payload delivered by several plugin hooks cannot claim the next step's record", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-dedupe-")); roots.push(root)
  const usage = providerUsageIntegrationForHost("kilo", { XDG_CACHE_HOME: root, HOME: root }, "cursor-opencode-provider")!
  const occupancy = {
    type: "finish", finishReason: { unified: "tool-calls" },
    usage: { inputTokens: { total: 5000 }, outputTokens: { total: 1 } },
    providerMetadata: { cursor: { usageVersion: 3, occupancyOnly: true, context: { stale: false, usedTokens: 5000 } } },
  }
  const step = { textChars: 400, reasoningChars: 0, toolChars: 40, elapsedMs: 1_000, hasTools: true }
  // Two tool steps with the same checkpoint produce identical expected usage.
  usage.recordFinishUsage("session", occupancy, step)
  await Bun.sleep(2)
  usage.recordFinishUsage("session", occupancy, step)
  const patched: string[] = []
  const input = { client: { _client: { patch: async (request: any) => { patched.push(request.path.partID) } } }, directory: "/workspace", serverUrl: new URL("http://127.0.0.1:4096") }
  const cursorHooks: any = await usageEventPlugin("kilo")(input)
  const devinHooks: any = await usageEventPlugin("kilo")(input)
  const stepFinish = (id: string) => ({ part: { id, messageID: "message", sessionID: "session", type: "step-finish", reason: "tool-calls",
    tokens: { total: 5001, input: 5000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
  const first = stepFinish("first")
  await Promise.all([
    cursorHooks.event({ event: { id: "e1", type: "message.part.updated", properties: first } }),
    devinHooks.event({ event: { id: "e1", type: "message.part.updated", properties: first } }),
  ])
  await cursorHooks.event({ event: { id: "e2", type: "message.part.updated", properties: stepFinish("second") } })
  expect(patched).toEqual(["first", "second"])
})

test("generation results are projected without leaving unclaimable reconciliation records", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-generate-")); roots.push(root)
  const usage = providerUsageIntegrationForHost("kilo", { XDG_CACHE_HOME: root, HOME: root }, "cursor-opencode-provider")
  const model = adaptLanguageModel({ async doGenerate() { return {
    content: [{ type: "text", text: "title" }], finishReason: { unified: "stop" },
    usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
    providerMetadata: { cursor: { usageVersion: 3, inputTokensRaw: 300, outputTokensRaw: 20, cacheReadRaw: 200, cacheWriteRaw: 0, reasoningTokensRaw: 0 } },
  } } }, policyForHostId("kilo"), undefined, undefined, usage)
  const result = await model.doGenerate({ headers: { "x-opencode-session-id": "session" } } as never)
  expect(result.usage.inputTokens.total).toBe(100)
  const { readdirSync } = await import("node:fs")
  expect(readdirSync(path.join(root, "kilo", "ocp", "usage-reconciliation")).filter(name => name.endsWith(".json"))).toEqual([])
})
