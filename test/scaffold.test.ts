import { describe, expect, test } from "bun:test"

describe("monorepo scaffold", () => {
  test("profile package identity exports", async () => {
    const mod = await import("../packages/profile/src/index.ts")
    expect(mod.PKG).toBe("@opencode-compat/profile")
    expect(mod.VERSION).toBe("0.1.0")
  })

  test("facade v2/effect loud-fails", async () => {
    const mod = await import("../packages/facade-plugin/src/v2/effect.ts")
    expect(() => mod.define({})).toThrow(/Effect v2 not supported/)
  })

  test("cli doctor stub reports not implemented", async () => {
    const { doctor } = await import("../packages/cli/src/index.ts")
    const result = doctor()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("not implemented")
  })
})
