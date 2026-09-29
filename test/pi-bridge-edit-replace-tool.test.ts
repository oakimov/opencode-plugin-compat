import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  test("normalizes OpenCode StrReplace args", () => {
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

  test("replaces through the active host write tool without changing edit mode", async () => {
    const pi = fakePi()
    const invoked: unknown[] = []
    const dir = mkdtempSync(join(tmpdir(), "ocp-edit-"))
    const target = join(dir, "a.ts")
    writeFileSync(target, "before\nkeep\n")
    expect(registerOpenCodeEditTool(pi, {
      resolveWrite: async () => ({
        execute: async (_id, params) => {
          invoked.push(params)
          const { path, content } = params as { path: string; content: string }
          writeFileSync(path, content)
          return { content: [{ type: "text", text: "ok" }] }
        },
      }),
    })).toEqual([OPENCODE_EDIT_TOOL])
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)
    expect(tool?.loadMode).toBe("essential")
    expect(tool?.description).toContain("StrReplace")
    expect(tool?.description).not.toMatch(/hashline patch$/i)
    const result = await tool?.execute(
      "c1",
      { filePath: target, oldString: "before", newString: "after" },
      undefined,
      undefined,
      {
        invokeTool: async () => { throw new Error("native hashline edit must not run") },
      },
    )
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] })
    expect(invoked).toEqual([{ path: target, content: "after\nkeep\n" }])
    expect(readFileSync(target, "utf8")).toBe("after\nkeep\n")
    rmSync(dir, { recursive: true, force: true })
  })

  test("passes hashline input straight to the native same-name edit without switching mode", async () => {
    const pi = fakePi()
    registerOpenCodeEditTool(pi)
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
  })

  test("rejects ambiguous replacements and never invokes write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-edit-"))
    const target = join(dir, "a.ts")
    writeFileSync(target, "same\nsame\n")
    const pi = fakePi()
    let writes = 0
    registerOpenCodeEditTool(pi, { resolveWrite: async () => ({ execute: async () => { writes++; return {} } }) })
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)!
    await expect(tool.execute("c1", { path: target, old_string: "same", new_string: "new" }, undefined, undefined, {}))
      .rejects.toThrow("matches more than once")
    expect(writes).toBe(0)
    expect(readFileSync(target, "utf8")).toBe("same\nsame\n")
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolves relative edit paths against the live host workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-edit-cwd-"))
    const target = join(dir, "a.ts")
    writeFileSync(target, "before\n")
    const pi = fakePi()
    registerOpenCodeEditTool(pi, {
      resolveWrite: async () => ({ execute: async (_id, params) => {
        const { path, content } = params as { path: string; content: string }
        expect(path).toBe(target)
        writeFileSync(path, content)
        return { content: [{ type: "text", text: "ok" }] }
      } }),
    })
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)!
    await tool.execute("c1", { path: "a.ts", old_string: "before", new_string: "after" }, undefined, undefined, { cwd: dir })
    expect(readFileSync(target, "utf8")).toBe("after\n")
    rmSync(dir, { recursive: true, force: true })
  })

  test("replaceAll edits every match and refuses mutation without an active write tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-edit-"))
    const target = join(dir, "a.ts")
    writeFileSync(target, "same\nsame\n")
    const pi = fakePi()
    let enabled = false
    registerOpenCodeEditTool(pi, { resolveWrite: async () => enabled ? ({
      execute: async (_id, params) => {
        const { path, content } = params as { path: string; content: string }
        writeFileSync(path, content)
        return { content: [{ type: "text", text: "ok" }] }
      },
    }) : undefined })
    const tool = pi.registered.find(entry => entry.name === OPENCODE_EDIT_TOOL)!
    await expect(tool.execute("c1", {
      path: target, old_string: "same", new_string: "new", replace_all: true,
    }, undefined, undefined, {})).rejects.toThrow("active write tool")
    expect(readFileSync(target, "utf8")).toBe("same\nsame\n")
    enabled = true
    await tool.execute("c2", {
      path: target, old_string: "same", new_string: "new", replace_all: true,
    }, undefined, undefined, {})
    expect(readFileSync(target, "utf8")).toBe("new\nnew\n")
    rmSync(dir, { recursive: true, force: true })
  })

  test("keeps edit active after session_start", async () => {
    const pi = fakePi()
    activateOpenCodeEditTool(pi, registerOpenCodeEditTool(pi))
    await pi.sessionHandlers[0]!()
    expect(pi.active).toContain(OPENCODE_EDIT_TOOL)
  })
})
