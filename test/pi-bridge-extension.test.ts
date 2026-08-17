import { describe, expect, test } from "bun:test"
import { activateOpenCodeSearchTools } from "../packages/pi-bridge/src/extension.ts"
import type { PiExtensionApi } from "../packages/pi-bridge/src/pi-provider-types.ts"

describe("Pi bridge search-tool activation", () => {
  test("activates all available optional built-ins after session startup", async () => {
    let handler: (() => void | Promise<void>) | undefined
    let active = ["read", "bash", "edit", "write"]
    const pi: PiExtensionApi = {
      registerProvider: () => {},
      on: (_event, callback) => { handler = callback as () => void | Promise<void> },
      getActiveTools: () => active,
      getAllTools: () => ["read", "bash", "edit", "write", "find", "grep", "ls"],
      setActiveTools: async names => { active = names },
    }

    activateOpenCodeSearchTools(pi)
    await handler?.()

    expect(active).toEqual(["read", "bash", "edit", "write", "find", "grep", "ls"])
  })

  test("does not override a host tool allowlist", async () => {
    let handler: (() => void | Promise<void>) | undefined
    let active = ["read", "bash", "edit", "write"]
    let setCalls = 0
    const pi: PiExtensionApi = {
      registerProvider: () => {},
      on: (_event, callback) => { handler = callback as () => void | Promise<void> },
      getActiveTools: () => active,
      getAllTools: () => ["read", "bash", "edit", "write"],
      setActiveTools: async names => { setCalls++; active = names },
    }

    activateOpenCodeSearchTools(pi)
    await handler?.()

    expect(active).toEqual(["read", "bash", "edit", "write"])
    expect(setCalls).toBe(0)
  })

  test("does not call tool actions during extension load", () => {
    const pi: PiExtensionApi = {
      registerProvider: () => {},
      on: () => {},
      getActiveTools: () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.")
      },
      getAllTools: () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.")
      },
      setActiveTools: async () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.")
      },
    }
    expect(() => activateOpenCodeSearchTools(pi)).not.toThrow()
  })
})
