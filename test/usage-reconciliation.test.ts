import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  usageIntegrationForHost,
  installUsageReconciliation,
  recordFinishUsage,
  resetUsageReconciliationForTests,
} from "../packages/adapter/src/usage-reconciliation"

const EVENT_BRIDGE = Symbol.for("opencode.host.event-bridge")
const roots: string[] = []

afterEach(() => {
  resetUsageReconciliationForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-reconciliation-"))
  roots.push(root)
  installUsageReconciliation("kilo", { XDG_CACHE_HOME: root, HOME: root })
  const bridge = (globalThis as Record<symbol, unknown>)[EVENT_BRIDGE] as {
    handle(input: unknown): Promise<void>
  }
  return { root, bridge }
}

describe("Kilo usage reconciliation", () => {
  test("publishes provisional step usage and settles every component to the exact turn totals", async () => {
    const { bridge } = setup()
    const parts = new Map<string, Record<string, any>>()
    const calls: Record<string, any>[] = []
    const client = { _client: { patch: async (input: Record<string, any>) => {
      calls.push(input.body)
      parts.set(input.body.id, input.body)
    } } }
    const observation = { textChars: 240, reasoningChars: 80, toolChars: 80, elapsedMs: 2_000, hasTools: true }
    const emit = async (id: string, reason: string, context: number, raw?: Record<string, number>) => {
      recordFinishUsage("ses_1", {
        type: "finish",
        finishReason: { unified: reason },
        usage: {
          inputTokens: { total: context, noCache: context, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        providerMetadata: {
          provider_x: {
            usageVersion: 3,
            ...(!raw ? { occupancyOnly: true } : raw),
            context: { stale: false, usedTokens: context },
          },
        },
      }, observation)
      const part = {
        id, sessionID: "ses_1", messageID: `msg_${id}`,
        type: "step-finish", reason, time: { elapsed: 2_000 },
        tokens: { total: context + 1, input: context, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      await bridge.handle({
        event: { type: "message.part.updated", properties: { part } },
        client, directory: "/workspace", serverUrl: new URL("http://127.0.0.1:4096"),
      })
    }

    await emit("step_1", "tool-calls", 1_000)
    expect(parts.get("step_1")?.tokens.total).toBeGreaterThan(0)
    expect(parts.get("step_1")?.metrics.generation).toBeGreaterThan(1)
    expect(parts.get("step_1")?.time.elapsed).toBe(1)
    await emit("step_2", "tool-calls", 1_300)
    expect(parts.get("step_2")?.tokens.cache.read).toBeGreaterThan(0)
    await emit("terminal", "stop", 1_600, {
      inputTokensRaw: 4_000, outputTokensRaw: 450,
      cacheReadRaw: 2_500, cacheWriteRaw: 100, reasoningTokensRaw: 150,
    })

    const totals = [...parts.values()].reduce((sum, part) => {
      for (const key of ["input", "output", "reasoning"]) sum[key] += part.tokens[key]
      for (const key of ["read", "write"]) sum[key] += part.tokens.cache[key]
      return sum
    }, { input: 0, output: 0, reasoning: 0, read: 0, write: 0 })
    expect(totals).toEqual({ input: 1_400, output: 300, reasoning: 150, read: 2_500, write: 100 })
    expect(calls.some((part) => part.id === "terminal" && part.metrics?.generation > 1)).toBe(true)
    expect(calls.find((part) => part.id === "terminal" && part.metrics)?.time.elapsed).toBe(1)
    expect(parts.get("terminal")?.metrics).toBeUndefined()
    expect(parts.get("terminal")?.time.elapsed).toBe(2_000)
  })

  test("activates by host while providers opt in through metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-selector-"))
    roots.push(root)
    const env = { XDG_CACHE_HOME: root, HOME: root }
    expect(usageIntegrationForHost("kilo", env)).toBeDefined()
    expect(usageIntegrationForHost("mimo", env)).toBeUndefined()
    expect(usageIntegrationForHost("opencode", env)).toBeUndefined()
    expect(usageIntegrationForHost("kilo", env)?.isOccupancyFinish({
      providerMetadata: { devin: { usageCounters: { inputTokens: 10 } } },
    })).toBe(false)
    expect(usageIntegrationForHost("kilo", env)?.isOccupancyFinish({
      providerMetadata: { any_provider: { usageVersion: 3, occupancyOnly: true } },
    })).toBe(true)
  })

  test("passes ordinary provider usage through without reconciliation records", () => {
    const { root } = setup()
    recordFinishUsage("ses_1", {
      type: "finish",
      finishReason: { unified: "stop" },
      usage: {
        inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      providerMetadata: {
        devin: { usageVersion: 3, usageCounters: { inputTokens: 80, outputTokens: 20 } },
      },
    })
    expect(readdirSync(path.join(root, "kilo", "ocp", "usage-reconciliation"))).toEqual([])
  })

  test("keeps assistant occupancy while replacing only the persisted step aggregate", async () => {
    const { root, bridge } = setup()
    recordFinishUsage("ses_1", {
      type: "finish",
      finishReason: { unified: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
        outputTokens: { total: 10, text: 8, reasoning: 2 },
      },
      providerMetadata: {
        cursor: {
          usageVersion: 3,
          inputTokensRaw: 1_000,
          outputTokensRaw: 100,
          cacheReadRaw: 800,
          cacheWriteRaw: 50,
          reasoningTokensRaw: 40,
        },
      },
    })

    const calls: Record<string, unknown>[] = []
    const part = {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      metrics: { generation: 5, source: "computed" },
      tokens: {
        total: 110,
        input: 60,
        output: 8,
        reasoning: 2,
        cache: { read: 40, write: 0 },
      },
    }
    await bridge.handle({
      event: { type: "message.part.updated", properties: { part } },
      client: { _client: { patch: async (input: Record<string, unknown>) => void calls.push(input) } },
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4096"),
    })

    expect(part.tokens).toEqual({
      total: 110,
      input: 60,
      output: 8,
      reasoning: 2,
      cache: { read: 40, write: 0 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      id: "prt_1",
      tokens: {
        total: 1_100,
        input: 150,
        output: 60,
        reasoning: 40,
        cache: { read: 800, write: 50 },
      },
    })
    expect((calls[0]?.body as Record<string, unknown>).metrics).toBeUndefined()
    expect(readdirSync(path.join(root, "kilo", "ocp", "usage-reconciliation"))).toEqual([])
  })

  test("keeps intermediate occupancy on the assistant but clears its step accounting", async () => {
    const { root, bridge } = setup()
    recordFinishUsage("ses_1", {
      type: "finish",
      finishReason: { unified: "tool-calls" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      providerMetadata: {
        cursor: {
          usageVersion: 3,
          occupancyOnly: true,
          inputTokensRaw: 1_000,
          outputTokensRaw: 100,
          cacheReadRaw: 0,
          cacheWriteRaw: 0,
          reasoningTokensRaw: 0,
        },
      },
    })
    const calls: Record<string, unknown>[] = []
    await bridge.handle({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "step-finish",
            reason: "tool-calls",
            tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      client: { _client: { patch: async (input: Record<string, unknown>) => void calls.push(input) } },
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4096"),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      id: "prt_1",
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const directory = path.join(root, "kilo", "ocp", "usage-reconciliation")
    expect(readdirSync(directory)).toEqual([])
  })

  test("does not confuse equal occupancy snapshots at tool and terminal finishes", async () => {
    const { bridge } = setup()
    const usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    }
    recordFinishUsage("ses_1", {
      type: "finish",
      finishReason: { unified: "tool-calls" },
      usage,
      providerMetadata: { any_provider: { usageVersion: 3, occupancyOnly: true } },
    })
    recordFinishUsage("ses_1", {
      type: "finish",
      finishReason: { unified: "stop" },
      usage,
      providerMetadata: {
        cursor: {
          usageVersion: 3,
          inputTokensRaw: 300,
          outputTokensRaw: 20,
          cacheReadRaw: 200,
          cacheWriteRaw: 0,
          reasoningTokensRaw: 5,
        },
      },
    })

    const calls: Record<string, unknown>[] = []
    const client = { _client: { patch: async (input: Record<string, unknown>) => void calls.push(input) } }
    const part = (id: string, reason: string) => ({
      id,
      sessionID: "ses_1",
      messageID: `msg_${id}`,
      type: "step-finish",
      reason,
      tokens: { total: 101, input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    for (const step of [part("terminal", "stop"), part("intermediate", "tool-calls")]) {
      await bridge.handle({
        event: { type: "message.part.updated", properties: { part: step } },
        client,
        directory: "/workspace",
        serverUrl: new URL("http://127.0.0.1:4096"),
      })
    }
    expect(calls).toHaveLength(2)
    expect((calls[0]?.body as Record<string, unknown>).tokens).toMatchObject({ total: 320, output: 15 })
    expect((calls[1]?.body as Record<string, unknown>).tokens).toMatchObject({ total: 0, output: 0 })
  })

  test("matches an unscoped terminal record when the host strips affinity headers", async () => {
    const { bridge } = setup()
    recordFinishUsage(undefined, {
      type: "finish",
      usage: {
        inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      providerMetadata: {
        cursor: {
          usageVersion: 3,
          inputTokensRaw: 500,
          outputTokensRaw: 25,
          cacheReadRaw: 300,
          cacheWriteRaw: 0,
          reasoningTokensRaw: 5,
        },
      },
    })
    const calls: Record<string, unknown>[] = []
    await bridge.handle({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_unscoped",
            sessionID: "ses_runtime",
            messageID: "msg_runtime",
            type: "step-finish",
            tokens: { total: 81, input: 80, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      client: { _client: { patch: async (input: Record<string, unknown>) => void calls.push(input) } },
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4096"),
    })

    expect(calls[0]?.body).toMatchObject({
      tokens: {
        total: 525,
        input: 200,
        output: 20,
        reasoning: 5,
        cache: { read: 300, write: 0 },
      },
    })
  })
})
