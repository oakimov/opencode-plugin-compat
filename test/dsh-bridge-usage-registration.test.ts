import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { registerDshPlugin } from "../packages/dsh-bridge/src/register.ts"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

for (const packageName of ["devin-opencode-provider", "acme-provider"]) {
  for (const catalog of ["config", "static"]) {
    test(`DSH ${packageName} ${catalog}: registration keeps model limits and selects optional usage explicitly`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ocp-dsh-registration-")); roots.push(root)
      const packageDir = path.join(root, packageName); mkdirSync(packageDir)
      writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, type: "module", main: "index.js" }))
      writeFileSync(path.join(packageDir, "index.js"), `
        export function createReview() { return { languageModel: () => ({ doStream: async () => ({ stream: new ReadableStream({ start(c) {
          c.enqueue({ type: "finish", finishReason: { unified: "stop" }, usage: { inputTokens: { total: 304, cacheRead: 86720, cacheWrite: 0 }, outputTokens: { total: 20 } },
            providerMetadata: { devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720, cacheWrite: 0 } } } }); c.close();
        } }) }) }) } }
        ${catalog === "config" ? `export default async () => ({ config: async config => { config.provider.review = { models: { mock: {
          name: "Mock", reasoning: true, limit: { context: 512000, output: 32000 }, modalities: { input: ["text", "image"] },
          variants: { low: { params: [{ id: "effort", value: "low" }] }, high: { params: [{ id: "effort", value: "high" }] } }
        } } } } })` : ""}
      `)
      let adapter: any
      const result = await registerDshPlugin({ llm: { registerAdapter(_ids, value) { adapter = value; return Object.assign(() => {}, { replace() {} }) } }, credentials: { resolve: async () => undefined } }, {
        package: packageDir, providerName: "review",
        ...(catalog === "static" ? { models: [{ id: "mock", name: "Mock", contextWindow: 512000, maxTokens: 32000, input: ["text", "image"] }] as never } : {}),
      })
      expect(result.modelCount).toBe(1)
      const resolved = await adapter.resolveModel("review", "mock")
      expect(resolved.context).toEqual({ contextWindow: 512000 })
      expect(resolved.defaultMaxTokens).toBe(32000)
      expect(resolved.inputModalities).toEqual(["text", "image"])
      if (catalog === "config") expect(resolved.reasoning.efforts.map((effort: any) => effort.id)).toEqual(["low", "high"])
      const chunks: any[] = []
      for await (const chunk of adapter.stream({ provider: "review", model: "mock", messages: [] })) chunks.push(chunk)
      const usage = chunks.find(chunk => chunk.type === "usage").usage
      expect(usage.totalTokens).toBe(324)
      if (packageName === "devin-opencode-provider") {
        expect(usage).toMatchObject({ inputTokens: 304, cacheReadTokens: 0 })
        expect(chunks.at(-1).replayState.response.ocpContext).toEqual({ promptTokens: 87024, contextTokens: 87044 })
      } else {
        expect(usage).toMatchObject({ inputTokens: 0, cacheReadTokens: 304 })
        expect(chunks.at(-1).replayState.response.ocpContext).toBeUndefined()
      }
    })
  }
}
