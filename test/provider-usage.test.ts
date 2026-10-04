import { describe, expect, test } from "bun:test"
import { normalizeUsage, providerPackageMatches } from "../packages/opencode-loader/src/usage.ts"
import { devinFinishContext, devinFinishUsage } from "../packages/opencode-loader/src/devin-usage.ts"
import { runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"
import { collectV3ToDsh } from "../packages/dsh-bridge/src/translate/stream.ts"

const cases = [
  { name: "aggregate only", usage: { inputTokens: { total: 100 }, outputTokens: { total: 20 } }, expected: { input: 100, output: 20, total: 120 } },
  { name: "aggregate with both caches, missing uncached input", usage: { inputTokens: { total: 100, cacheRead: 40, cacheWrite: 10 }, outputTokens: { total: 20, reasoning: 8 } }, expected: { input: 50, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 8, total: 120 } },
  { name: "complete disjoint components", usage: { inputTokens: { noCache: 50, cacheRead: 40, cacheWrite: 10 }, outputTokens: { text: 12, reasoning: 8 } }, expected: { input: 50, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 8, total: 120 } },
  { name: "unknown totals stay unknown", usage: { inputTokens: { noCache: 50 }, outputTokens: { text: 12 } }, expected: { input: 50, output: 12 } },
  { name: "cache sum cannot exceed an authoritative aggregate", usage: { inputTokens: { total: 100, cacheRead: 90, cacheWrite: 20 }, outputTokens: { total: 20, reasoning: 30 } }, expected: { input: 0, cacheRead: 90, cacheWrite: 10, output: 20, reasoning: 20, total: 120 } },
  { name: "invalid counts are unknown", usage: { inputTokens: { total: NaN, noCache: -1, cacheRead: Infinity }, outputTokens: { total: -1 } }, expected: { input: 0, output: 0 } },
]
const model = { id: "mock", api: "mock", provider: "mock", cost: { input: 1, cacheRead: 0.5, cacheWrite: 2, output: 3 } } as never

for (const entry of cases) {
  test(`${entry.name}: Pi and DSH preserve the same disjoint counts`, async () => {
    const normalized = normalizeUsage(entry.usage)
    expect(normalized).toEqual(entry.expected)
    const finish = { type: "finish", usage: entry.usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } }
    let message: any
    const stream = { push(event: any) { if (event.type === "done") message = event.message } }
    await runV3StreamToPi({ model, piStream: stream as never, v3Stream: (async function* () { yield finish })() as never })
    expect(message.usage.input).toBe(normalized.input)
    expect(message.usage.output).toBe(normalized.output)
    expect(message.usage.cacheRead).toBe(normalized.cacheRead ?? 0)
    expect(message.usage.cacheWrite).toBe(normalized.cacheWrite ?? 0)
    expect(message.usage.totalTokens).toBe(normalized.total ?? normalized.input + normalized.output + (normalized.cacheRead ?? 0) + (normalized.cacheWrite ?? 0))
    expect(message.usage.cost.total).toBeCloseTo((normalized.input + normalized.output * 3 + (normalized.cacheRead ?? 0) * 0.5 + (normalized.cacheWrite ?? 0) * 2) / 1e6, 10)
    const chunks = await collectV3ToDsh(new ReadableStream({ start(c) { c.enqueue(finish); c.close() } }) as never)
    expect(chunks.find(chunk => chunk.type === "usage")?.usage).toEqual({
      inputTokens: normalized.input, outputTokens: normalized.output,
      ...(normalized.cacheRead === undefined ? {} : { cacheReadTokens: normalized.cacheRead }),
      ...(normalized.cacheWrite === undefined ? {} : { cacheWriteTokens: normalized.cacheWrite }),
      ...(normalized.reasoning === undefined ? {} : { reasoningTokens: normalized.reasoning }),
      ...(normalized.total === undefined ? {} : { totalTokens: normalized.total }),
    })
  })
}

describe("optional Devin accounting", () => {
  const part = {
    type: "finish", finishReason: { unified: "stop" },
    usage: { inputTokens: { total: 304, cacheRead: 86720, cacheWrite: 0 }, outputTokens: { total: 20, text: 20 } },
    providerMetadata: { devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720, cacheWrite: 0 } } },
  } as never
  test("keeps the aggregate billed total and reconstructs the separate cached-context snapshot", async () => {
    expect(devinFinishUsage(part)?.inputTokens).toEqual({ total: 304, noCache: 304, cacheRead: 0, cacheWrite: 0 })
    expect(devinFinishContext(part)).toEqual({ promptTokens: 87024, contextTokens: 87044 })
    const chunks = await collectV3ToDsh(new ReadableStream({ start(c) { c.enqueue(part); c.close() } }), undefined, { finishUsage: devinFinishUsage, finishContext: devinFinishContext })
    expect(chunks.find(chunk => chunk.type === "usage")?.usage).toEqual({ inputTokens: 304, outputTokens: 20, totalTokens: 324, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(chunks.at(-1)).toMatchObject({ replayState: { response: { providerMetadata: (part as any).providerMetadata, ocpContext: { promptTokens: 87024, contextTokens: 87044 } } } })
  })
  test("normal partitions and unrelated metadata pass through", () => {
    const normal = { ...part as any, providerMetadata: { devin: { usageCounters: { inputTokens: 100, outputTokens: 20, cacheRead: 40, cacheWrite: 10 } } } }
    expect(devinFinishUsage(normal)).toBeUndefined()
    expect(devinFinishContext(normal)).toBeUndefined()
    expect(devinFinishUsage({ ...normal, providerMetadata: { acme: (part as any).providerMetadata.devin } })).toBeUndefined()
  })
  test("a cached-context snapshot does not erase billed cache writes", () => {
    const withWrite = { ...part as any, providerMetadata: { devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720, cacheWrite: 40 } } } }
    expect(devinFinishUsage(withWrite)?.inputTokens).toEqual({ total: 304, noCache: 264, cacheRead: 0, cacheWrite: 40 })
    expect(devinFinishContext(withWrite)).toEqual({ promptTokens: 87024, contextTokens: 87044 })
    const absentWrite = { ...part as any, providerMetadata: { devin: { usageCounters: { inputTokens: 304, outputTokens: 20, cacheRead: 86720 } } } }
    expect(devinFinishUsage(absentWrite)?.inputTokens.total).toBe(304)
  })
  test("explicit package matching excludes similarly named generic packages", () => {
    for (const name of ["devin-opencode-provider", "devin-opencode-provider@0.1.7", "file:///workspace/devin-opencode-provider/dist/index.js"]) expect(providerPackageMatches(name, "devin-opencode-provider")).toBe(true)
    for (const name of ["not-devin-opencode-provider", "devin-opencode-provider-extra", "/workspace/acme/index.js"]) expect(providerPackageMatches(name, "devin-opencode-provider")).toBe(false)
  })
})
