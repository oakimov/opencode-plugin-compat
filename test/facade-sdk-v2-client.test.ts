import { describe, expect, test } from "bun:test"
import { OpencodeClient } from "../packages/facade-sdk/src/v2/client.ts"

describe("@opencode-compat/facade-sdk v2/client", () => {
  test("on kilo, model.list polyfills from models.dev instead of transport.get", async () => {
    let transportCalls = 0
    const transport = {
      get: async () => {
        transportCalls += 1
        // Would deadlock under real Plugin.init — must not be called on kilo.
        return await new Promise(() => {})
      },
    }

    const client = new OpencodeClient({ client: transport })
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
