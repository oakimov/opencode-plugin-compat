import { describe, expect, test } from "bun:test"
import { buildDynamicModels, type AiSdkProviderSpec } from "../packages/pi-bridge/src/bridge.ts"
import type { PiModelConfig } from "../packages/pi-bridge/src/opencode/models.ts"
import { piProfile } from "../packages/pi-bridge/src/host/profile.ts"

const MODEL: PiModelConfig = {
  id: "grok-4.6",
  name: "Grok 4.6",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
}

function piRefresh(spec: Partial<AiSdkProviderSpec>) {
  const dynamic = buildDynamicModels(
    { name: "cursor", models: [MODEL], fetchModels: async () => [MODEL], ...spec } as AiSdkProviderSpec,
    piProfile(),
  )
  if (typeof dynamic.refreshModels !== "function") throw new Error("Pi refreshModels callback was not registered")
  return dynamic.refreshModels as (context: Record<string, unknown>) => Promise<readonly PiModelConfig[]>
}

describe("Pi dynamic model refresh", () => {
  test("cache-only startup returns stored models and successful refreshes persist them", async () => {
    const publications: Array<Record<string, unknown>> = []
    const refresh = piRefresh({ fetchModels: async () => [MODEL] })

    const fresh = await refresh({
      credential: { access: "cursor-access-token" },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication: Record<string, unknown>) => {
        publications.push(publication)
        return true
      },
    })

    expect(fresh).toEqual([MODEL])
    expect(publications).toHaveLength(1)
    expect(publications[0]!.persist).toMatchObject({ models: [MODEL] })

    const restored = await refresh({
      stored: { models: fresh },
      allowNetwork: false,
      signal: new AbortController().signal,
    })
    expect(restored).toEqual([MODEL])
  })

  test("network failure retains the stored catalog and does not persist an empty replacement", async () => {
    const publications: Array<Record<string, unknown>> = []
    const refresh = piRefresh({ fetchModels: async () => { throw new Error("offline") } })

    const retained = await refresh({
      stored: { models: [MODEL] },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication: Record<string, unknown>) => {
        publications.push(publication)
        return true
      },
    })

    expect(retained).toEqual([MODEL])
    expect(publications).toHaveLength(0)
  })

  test("a successful fetch returning [] does not wipe or persist over a stored catalog", async () => {
    const publications: Array<Record<string, unknown>> = []
    const refresh = piRefresh({ fetchModels: async () => [] })

    const retained = await refresh({
      stored: { models: [MODEL] },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication: Record<string, unknown>) => {
        publications.push(publication)
        return true
      },
    })

    // Pi's provider-composer applies any returned array via `if (refreshed)`,
    // and `[]` is truthy — so retaining is not enough; nothing may be
    // persisted either, or the next cache-only startup would restore empty.
    expect(retained).toEqual([MODEL])
    expect(publications).toHaveLength(0)
  })

  test("a successful fetch returning [] with no prior cache still returns/persists []", async () => {
    const publications: Array<Record<string, unknown>> = []
    const refresh = piRefresh({ models: [], fetchModels: async () => [] })

    const result = await refresh({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication: Record<string, unknown>) => {
        publications.push(publication)
        return true
      },
    })

    expect(result).toEqual([])
    expect(publications).toHaveLength(1)
    expect(publications[0]!.persist).toMatchObject({ models: [] })
  })

  test("a persist failure still returns the freshly fetched list for this session", async () => {
    const refresh = piRefresh({ fetchModels: async () => [MODEL] })

    const fresh = await refresh({
      stored: { models: [] },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async () => {
        throw new Error("disk full")
      },
    })

    expect(fresh).toEqual([MODEL])
  })

  test("an aborted signal after a successful fetch retains the stored catalog and skips persist", async () => {
    const publications: Array<Record<string, unknown>> = []
    const refresh = piRefresh({ fetchModels: async () => [MODEL] })
    const controller = new AbortController()
    controller.abort()

    const result = await refresh({
      stored: { models: [] },
      allowNetwork: true,
      signal: controller.signal,
      publish: async (publication: Record<string, unknown>) => {
        publications.push(publication)
        return true
      },
    })

    expect(result).toEqual([])
    expect(publications).toHaveLength(0)
  })
})
