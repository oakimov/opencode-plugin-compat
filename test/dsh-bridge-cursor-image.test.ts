import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadCursorImageSave, registerCursorImageTool } from "../packages/dsh-bridge/src/cursor-image-tool.ts"

function fixture(mode: string, outcome = "allowed-once") {
  let definition: any
  const requests: any[] = []
  const calls: any[] = []
  const agent = { session: { header: { cwd: "/workspace" } } }
  const ctx = {
    tools: { get: () => undefined, register: (tool: unknown) => { definition = tool } },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: "/workspace" }) },
    approval: { request: async (input: unknown) => { requests.push(input); return outcome } },
  }
  const save = async (args: { image_id?: unknown }, context: any) => {
    calls.push(args)
    await context.ask({ permission: "external_directory", metadata: { filepath: "/project/assets/image.png" } })
    await context.ask({ permission: "edit", metadata: { filepath: "/project/assets/image.png" } })
    return { output: "Saved image" }
  }
  registerCursorImageTool(ctx, save)
  return { definition, requests, calls, agent }
}

describe("Cursor image save on DSH", () => {
  test("loads the image subpath beside an absolute provider entry", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-dsh-image-"))
    try {
      const dist = path.join(root, "dist")
      mkdirSync(dist)
      writeFileSync(path.join(dist, "index.js"), "export const fixture = true\n")
      writeFileSync(path.join(dist, "image-save.js"), "export const executeCursorImageSave = async () => ({output: 'saved'})\n")
      expect(typeof await loadCursorImageSave(path.join(dist, "index.js"))).toBe("function")
      expect(typeof await loadCursorImageSave(root)).toBe("function")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("uses one host approval for an external image under workspace-write", async () => {
    const { definition, requests, calls, agent } = fixture("workspace-write")
    const signal = new AbortController().signal
    expect(await definition.execute({ image_id: "opaque" }, { agent, callId: "c1", signal }))
      .toEqual({ message: "Saved image" })
    expect(calls).toEqual([{ image_id: "opaque" }])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ agent, toolName: "cursor_image_save", callId: "c1", signal })
    expect(definition.output.render({}, { message: "Saved image" })).toEqual([{ type: "text", text: "Saved image" }])
  })

  test("honors denial and read-only policy; full access does not ask", async () => {
    const denied = fixture("workspace-write", "rejected")
    await expect(denied.definition.execute({ image_id: "opaque" }, {
      agent: denied.agent, callId: "c1", signal: new AbortController().signal,
    })).rejects.toThrow("approval rejected")
    expect(denied.requests).toHaveLength(1)

    const readonly = fixture("read-only")
    await readonly.definition.execute({ image_id: "opaque" }, {
      agent: readonly.agent, callId: "c2", signal: new AbortController().signal,
    })
    expect(readonly.requests).toHaveLength(1)

    const full = fixture("danger-full-access")
    await full.definition.execute({ image_id: "opaque" }, {
      agent: full.agent, callId: "c3", signal: new AbortController().signal,
    })
    expect(full.requests).toHaveLength(0)
  })

  test("requires a live caller and does not consume an image on cancellation", async () => {
    const { definition, calls, agent } = fixture("workspace-write")
    await expect(definition.execute({ image_id: "opaque" }, {
      callId: "c1", signal: new AbortController().signal,
    })).rejects.toThrow("calling agent")
    await expect(definition.execute({ image_id: "opaque" }, {
      agent, callId: "c2", signal: AbortSignal.abort(),
    })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
