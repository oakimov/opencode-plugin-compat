import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  cursorUsageIntegrationForPackage,
  installUsageReconciliation,
  recordTerminalUsage,
  resetUsageReconciliationForTests,
} from "../packages/adapter/src/cursor-usage-reconciliation"

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
  test("activates only for the Cursor provider package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-usage-selector-"))
    roots.push(root)
    const env = { XDG_CACHE_HOME: root, HOME: root }
    expect(cursorUsageIntegrationForPackage("acme-provider", "kilo", env)).toBeUndefined()
    expect(cursorUsageIntegrationForPackage("devin-opencode-provider", "kilo", env)).toBeUndefined()
    expect(cursorUsageIntegrationForPackage("cursor-opencode-provider", "kilo", env)).toBeDefined()
  })

  test("keeps assistant occupancy while replacing only the persisted step aggregate", async () => {
    const { root, bridge } = setup()
    recordTerminalUsage("ses_1", {
      type: "finish",
      usage: {
        inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
        outputTokens: { total: 10, text: 8, reasoning: 2 },
      },
      providerMetadata: {
        cursor: {
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

  test("does not persist intermediate occupancy-only snapshots", async () => {
    const { root, bridge } = setup()
    recordTerminalUsage("ses_1", {
      type: "finish",
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      providerMetadata: {
        cursor: {
          occupancyOnly: true,
          inputTokensRaw: 1_000,
          outputTokensRaw: 100,
          cacheReadRaw: 0,
          cacheWriteRaw: 0,
          reasoningTokensRaw: 0,
        },
      },
    })
    const calls: unknown[] = []
    await bridge.handle({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "step-finish",
            tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      client: { _client: { patch: async (input: unknown) => void calls.push(input) } },
      directory: "/workspace",
      serverUrl: new URL("http://127.0.0.1:4096"),
    })

    expect(calls).toEqual([])
    const directory = path.join(root, "kilo", "ocp", "usage-reconciliation")
    expect(readdirSync(directory)).toEqual([])
  })

  test("matches an unscoped terminal record when the host strips affinity headers", async () => {
    const { bridge } = setup()
    recordTerminalUsage(undefined, {
      type: "finish",
      usage: {
        inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      providerMetadata: {
        cursor: {
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
