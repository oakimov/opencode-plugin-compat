import { describe, expect, test } from "bun:test"
import {
  activateOpenCodeEditTool,
  OPENCODE_EDIT_TOOL,
  registerOpenCodeEditTool,
  toReplaceArgs,
} from "../packages/pi-bridge/src/edit-replace-tool.ts"
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

describe("omp OpenCode edit overlay", () => {
  test("remaps OpenCode StrReplace args onto omp replace mode", () => {
    expect(toReplaceArgs({
      filePath: "a.ts",
      oldString: "before",
      newString: "after",
      replaceAll: true,
    })).toEqual({
      path: "a.ts",
      old_string: "before",
      new_string: "after",
      replace_all: true,
    })
    expect(toReplaceArgs({
      path: "/tmp/a.ts",
      old_string: "before",
      new_string: "after",
    })).toEqual({
      path: "/tmp/a.ts",
      old_string: "before",
      new_string: "after",
    })
  })

  test("registers edit and executes through invokeTool under replace mode", async () => {
    const pi = fakePi()
    const modes: string[] = []
    const invoked: unknown[] = []
    expect(registerOpenCodeEditTool(pi, {
      hostPi: {
        settings: {
          get: () => "hashline",
          override: (path, value) => {
            modes.push(`set:${path}=${String(value)}`)
          },
          clearOverride: path => {
            modes.push(`clear:${path}`)
          },
        },
      },
    })).toEqual([OPENCODE_EDIT_TOOL])
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)
    expect(tool?.loadMode).toBe("essential")
    expect(tool?.description).toContain("StrReplace")
    expect(tool?.description).not.toMatch(/hashline patch$/i)
    const result = await tool?.execute(
      "c1",
      { filePath: "a.ts", oldString: "a", newString: "b" },
      undefined,
      undefined,
      {
        invokeTool: async (params: Record<string, unknown>) => {
          invoked.push(params)
          return { content: [{ type: "text", text: "ok" }] }
        },
      },
    )
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] })
    expect(invoked).toEqual([{ path: "a.ts", old_string: "a", new_string: "b" }])
    expect(modes).toEqual(["set:edit.mode=replace", "set:edit.mode=hashline"])
  })

  test("passes hashline input straight to the native same-name edit without switching mode", async () => {
    const pi = fakePi()
    const modes: string[] = []
    registerOpenCodeEditTool(pi, {
      hostPi: {
        settings: {
          override: () => { modes.push("set") },
          clearOverride: () => { modes.push("clear") },
        },
      },
    })
    const invoked: unknown[] = []
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)!
    const result = await tool.execute(
      "c1",
      { input: "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n" },
      undefined,
      undefined,
      { invokeTool: async (params: Record<string, unknown>) => {
        invoked.push(params)
        return { content: [{ type: "text", text: "ok" }] }
      } },
    )
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] })
    expect(invoked).toEqual([{ input: "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n" }])
    expect(modes).toEqual([])
  })

  test("keeps edit active after session_start", async () => {
    const pi = fakePi()
    activateOpenCodeEditTool(pi, registerOpenCodeEditTool(pi, {
      executeReplace: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }))
    await pi.sessionHandlers[0]!()
    expect(pi.active).toContain(OPENCODE_EDIT_TOOL)
  })
})
