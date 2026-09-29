import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
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
  function provider(root: string, imageSave = "./dist/image-save.js", saved = "saved") {
    mkdirSync(path.join(root, "dist"), { recursive: true })
    mkdirSync(path.dirname(path.join(root, imageSave)), { recursive: true })
    writeFileSync(path.join(root, "package.json"), JSON.stringify({
      type: "module",
      exports: { ".": { import: "./dist/index.js" }, "./image-save": { import: imageSave } },
    }))
    writeFileSync(path.join(root, "dist", "index.js"), "export const fixture = true\n")
    writeFileSync(path.join(root, imageSave), `export const executeCursorImageSave = async () => ({output: ${JSON.stringify(saved)}})\n`)
  }

  test("follows the provider's own image-save export from the loaded root entry", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-dsh-image-"))
    try {
      provider(root, "./lib/save.js")
      const save = await loadCursorImageSave(path.join(root, "dist", "index.js"))
      expect(await save!({}, {} as never)).toEqual({ output: "saved" })
      expect(await loadCursorImageSave(pathToFileURL(path.join(root, "dist", "index.js")).href)).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("never falls through to another installation or a guessed layout", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ocp-dsh-image-"))
    try {
      // The loader cannot import a directory, so neither may the subpath.
      provider(root)
      expect(await loadCursorImageSave(root)).toBeUndefined()
      // A root whose package omits the export gets nothing, even with a
      // conventionally named sibling file and an outer package that has one.
      const inner = path.join(root, "node_modules", "inner")
      mkdirSync(path.join(inner, "dist"), { recursive: true })
      writeFileSync(path.join(inner, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./dist/index.js" } }))
      writeFileSync(path.join(inner, "dist", "index.js"), "export const fixture = true\n")
      writeFileSync(path.join(inner, "dist", "image-save.js"), "export const executeCursorImageSave = async () => ({})\n")
      expect(await loadCursorImageSave(path.join(inner, "dist", "index.js"))).toBeUndefined()
      expect(await loadCursorImageSave(path.join(root, "missing.js"))).toBeUndefined()
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
