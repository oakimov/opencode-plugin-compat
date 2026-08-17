import { describe, expect, test } from "bun:test"
import { activateHashlineTool, HASHLINE_TOOL, registerHashlineTool } from "../packages/pi-bridge/src/hashline-tool.ts"
import type { PiExtensionApi, PiRegisterToolDefinition } from "../packages/pi-bridge/src/pi-provider-types.ts"

function fakePi(): PiExtensionApi & {
  registered: PiRegisterToolDefinition[]
  sessionHandlers: Array<() => void | Promise<void>>
  active: string[]
} {
  let active = ["read", "bash", "edit"]
  const registered: PiRegisterToolDefinition[] = []
  const sessionHandlers: Array<() => void | Promise<void>> = []
  return {
    registered,
    sessionHandlers,
    get active() {
      return active
    },
    registerProvider: () => {},
    registerTool: tool => {
      registered.push(tool)
    },
    on: (event, handler) => {
      if (event === "session_start") sessionHandlers.push(handler as () => void | Promise<void>)
    },
    getActiveTools: () => active,
    getAllTools: () => [...active, ...registered.map(tool => tool.name)],
    setActiveTools: async names => {
      active = [...names]
    },
  }
}

describe("omp hashline tool", () => {
  test("registers hashline and delegates execute to the host edit tool", async () => {
    const calls: unknown[] = []
    const pi = fakePi()
    expect(registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async (toolCallId, params, onUpdate, ctx, signal) => {
          calls.push({ toolCallId, params, onUpdate, ctx, signal })
          return { content: [{ type: "text", text: "ok" }] }
        },
      }),
    })).toEqual([HASHLINE_TOOL])
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)
    expect(tool?.approval).toBe("write")
    const signal = new AbortController().signal
    await expect(tool?.execute("c1", { input: "[a.ts]\n1: x" }, signal, "upd", { cwd: "/tmp" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })
    expect(calls).toEqual([{
      toolCallId: "c1",
      params: { input: "[a.ts]\n1: x" },
      onUpdate: "upd",
      ctx: { cwd: "/tmp" },
      signal,
    }])
  })

  test("rejects an empty patch and missing host edit", async () => {
    const pi = fakePi()
    registerHashlineTool(pi, { resolveEdit: async () => undefined })
    const tool = pi.registered[0]!
    await expect(tool.execute("c1", { input: "   " }, undefined, undefined, {})).rejects.toThrow("non-empty")
    await expect(tool.execute("c1", { input: "[a.ts]\n1: x" }, undefined, undefined, {})).rejects.toThrow("unavailable")
  })

  test("activates hashline on session_start", async () => {
    const pi = fakePi()
    activateHashlineTool(pi, registerHashlineTool(pi, { resolveEdit: async () => undefined }))
    await pi.sessionHandlers[0]!()
    expect(pi.active).toContain(HASHLINE_TOOL)
  })
})
