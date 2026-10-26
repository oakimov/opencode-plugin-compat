import { describe, expect, test } from "bun:test"
import { loadModelsDevCatalog, OpencodeClient } from "../packages/facade-sdk/src/v2/client.ts"

describe("@opencode-compat/facade-sdk v2/client", () => {
  test("catalog caches remain separate per fetch implementation and retry failures", async () => {
    let calls = 0
    const a: typeof fetch = Object.assign(async () => {
      calls++
      if (calls === 1) return new Response("unavailable", { status: 503 })
      return Response.json({ acme: { models: { a: { id: "a" } } } })
    }, { preconnect() {} })
    const b: typeof fetch = Object.assign(async () => Response.json({ acme: { models: { b: { id: "b" } } } }), { preconnect() {} })
    await expect(loadModelsDevCatalog(a)).rejects.toThrow("HTTP 503")
    const [first, second] = await Promise.all([loadModelsDevCatalog(a), loadModelsDevCatalog(b)])
    expect(first.map(model => model.id)).toEqual(["a"])
    expect(second.map(model => model.id)).toEqual(["b"])
    expect(await loadModelsDevCatalog(a)).toBe(first)
    expect(calls).toBe(2)
  })

  test("on kilo, model.list polyfills from models.dev instead of transport.get", async () => {
    let transportCalls = 0
    const transport = {
      get: async () => {
        transportCalls += 1
        // Would deadlock under real Plugin.init — must not be called on kilo.
        return await new Promise(() => {})
      },
    }

    const fetcher: typeof fetch = Object.assign(async () => Response.json({
      acme: { models: { small: { id: "small", name: "Small", tool_call: true } } },
    }), { preconnect() {} })
    const client = new OpencodeClient({ client: transport, fetch: fetcher })
    const prev = process.env.OPENCODE_COMPAT_HOST
    process.env.OPENCODE_COMPAT_HOST = "kilo"
    try {
      const result = await client.v2.model.list(
        { location: { directory: "/tmp/proj" } },
        { throwOnError: true },
      )
      expect(transportCalls).toBe(0)
      expect(Array.isArray(result.data?.data)).toBe(true)
      expect((result.data?.data?.length ?? 0) > 0).toBe(true)
      expect(result.data?.location?.directory).toBe("/tmp/proj")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COMPAT_HOST
      else process.env.OPENCODE_COMPAT_HOST = prev
    }
  })
})
