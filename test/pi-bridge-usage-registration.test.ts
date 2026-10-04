import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { registerOpenCodePlugin } from "../packages/pi-bridge/src/register.ts"
import { resetPiHostDetection } from "../packages/pi-bridge/src/host/detect.ts"
import { installPiRuntimeModule, resetPiRuntime } from "../packages/pi-bridge/src/host/runtime.ts"
import type { PiAssistantMessage, PiAssistantMessageEvent } from "../packages/pi-bridge/src/pi-provider-types.ts"

const originalHost = process.env.PI_BRIDGE_HOST
const roots: string[] = []

afterEach(() => {
  if (originalHost === undefined) delete process.env.PI_BRIDGE_HOST
  else process.env.PI_BRIDGE_HOST = originalHost
  resetPiHostDetection()
  resetPiRuntime()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createStream() {
  let settle!: (message: PiAssistantMessage) => void
  const result = new Promise<PiAssistantMessage>(resolve => { settle = resolve })
  return {
    push(event: PiAssistantMessageEvent) {
      if (event.type === "done") settle(event.message)
      if (event.type === "error") settle(event.error)
    },
    end() {},
    fail(error: unknown) { throw error },
    result: () => result,
    async *[Symbol.asyncIterator]() {},
  }
}

for (const host of ["pi", "omp"] as const) {
  for (const packageName of ["cursor-opencode-provider", "devin-opencode-provider", "acme-provider"]) {
    test(`${host} registration selects usage semantics only for ${packageName}`, async () => {
      process.env.PI_BRIDGE_HOST = host
      resetPiHostDetection()
      installPiRuntimeModule(host, { createAssistantMessageEventStream: createStream })
      const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-registration-"))
      roots.push(root)
      const packageDir = path.join(root, packageName)
      mkdirSync(packageDir)
      writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, type: "module", main: "index.js" }))
      writeFileSync(path.join(packageDir, "index.js"), `
        export function createReviewProvider() {
          return { languageModel: () => ({ doStream: async () => ({
            stream: new ReadableStream({ start(controller) {
              controller.enqueue({
                type: "finish", finishReason: { unified: "stop" },
                usage: ${JSON.stringify(packageName === "devin-opencode-provider"
                  ? { inputTokens: { total: 304, cacheRead: 86720, cacheWrite: 0 }, outputTokens: { total: 20 } }
                  : { inputTokens: { total: 99, noCache: 99, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1 } })},
                providerMetadata: { cursor: {
                  inputTokensRaw: 800, outputTokensRaw: 200,
                  cacheReadRaw: 600, cacheWriteRaw: 0, reasoningTokensRaw: 0,
                  context: { usedTokens: 100 },
                }, devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720, cacheWrite: 0 } } },
              });
              controller.close();
            } }),
          }) }) };
        }
      `)
      let config!: Record<string, unknown>
      await registerOpenCodePlugin({ registerProvider(_name, value) { config = value } }, {
        package: packageDir,
        providerName: "review-provider",
        models: [{
          id: "review-model", name: "Review model", reasoning: false, input: ["text"],
          contextWindow: 256_000, maxTokens: 8_192,
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
        }],
      })
      const streamSimple = config.streamSimple as (...args: unknown[]) => ReturnType<typeof createStream>
      const message = await streamSimple({
        id: "review-model", provider: "review-provider", api: "review-bridge",
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
      }, { messages: [] }).result()
      expect(message.stopReason).toBe("stop")
      if (packageName === "cursor-opencode-provider") {
        expect(message.usage.contextTokens).toBe(100)
        expect(message.usage.totalTokens).toBe(host === "pi" ? 100 : 1_000)
        expect(message.usage.cost.total).toBeCloseTo(0.0009, 10)
      } else if (packageName === "devin-opencode-provider") {
        expect(message.usage.contextTokens).toBe(87044)
        expect(message.usage.totalTokens).toBe(host === "pi" ? 87044 : 324)
        expect(message.usage.input).toBe(304)
        expect(message.usage.cacheRead).toBe(0)
        expect(message.usage.cost.total).toBeCloseTo(0.000344, 10)
      } else {
        expect(message.usage.contextTokens).toBeUndefined()
        expect(message.usage.orchestration).toBeUndefined()
        expect(message.usage.totalTokens).toBe(100)
        expect(message.usage.cost.total).toBeCloseTo(0.000101, 10)
      }
    })
  }
}
