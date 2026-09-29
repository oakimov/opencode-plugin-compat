import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadModuleThroughHost, loadProviderWithSubpathThroughHost } from "../packages/pi-bridge/src/host-module-loader.ts"
import type { PiExtensionApi } from "../packages/pi-bridge/src/pi-provider-types.ts"

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocp-provider-graph-")))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    type: "module",
    exports: { ".": "./index.js", "./commit": "./commit.js" },
  }))
  fs.writeFileSync(path.join(dir, "state.js"), "export const pending = new Map();\n")
  fs.writeFileSync(path.join(dir, "index.js"), "export { pending } from './state.js';\n")
  fs.writeFileSync(path.join(dir, "commit.js"), "export { pending } from './state.js';\n")
  let loads = 0
  const host = (): PiExtensionApi => ({
    registerProvider() {},
    pi: {
      async loadExtensions(paths) {
        // Like the host, give each extension graph its own evaluated modules.
        const output = path.join(dir, `graph-${++loads}.mjs`)
        const built = await Bun.build({ entrypoints: paths, target: "bun", format: "esm" })
        if (!built.success) throw new Error("Fixture graph did not build")
        fs.writeFileSync(output, await built.outputs[0]!.text())
        await import(pathToFileURL(output).href)
        return { errors: [] }
      },
    },
  })
  return { dir, host, loads: () => loads, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test("child provider binding retains the parent's pending state across host graphs", async () => {
  const f = fixture()
  try {
    const parent = await loadModuleThroughHost(f.host(), f.dir)
    const pending = parent!.pending as Map<string, string>
    pending.set("parent-call", "waiting")
    const alias = path.join(f.dir, "alias")
    fs.symlinkSync(f.dir, alias)
    const child = await loadModuleThroughHost(f.host(), pathToFileURL(alias).href, os.tmpdir())
    expect(child).toBe(parent)
    expect((child!.pending as Map<string, string>).get("parent-call")).toBe("waiting")
    expect(f.loads()).toBe(1)
  } finally {
    f.cleanup()
  }
})

test("concurrent root and subpath loads share one graph across agent APIs", async () => {
  const f = fixture()
  try {
    const [parent, child] = await Promise.all([
      loadProviderWithSubpathThroughHost(f.host(), f.dir, "./commit"),
      loadProviderWithSubpathThroughHost(f.host(), f.dir, "./commit"),
    ])
    expect(parent!.root).toBe(child!.root)
    const pending = parent!.root.pending as Map<string, string>
    pending.set("image", "bytes")
    expect((child!.subpath.pending as Map<string, string>).get("image")).toBe("bytes")
    expect(f.loads()).toBe(1)
  } finally {
    f.cleanup()
  }
})

test("a failed host graph load can be retried", async () => {
  const f = fixture()
  try {
    const broken: PiExtensionApi = {
      registerProvider() {},
      pi: { loadExtensions: async () => ({ errors: [{ error: "temporary load failure" }] }) },
    }
    await expect(loadModuleThroughHost(broken, f.dir)).rejects.toThrow("temporary load failure")
    const recovered = await loadModuleThroughHost(f.host(), f.dir)
    expect(recovered!.pending).toBeInstanceOf(Map)
    expect(f.loads()).toBe(1)
  } finally {
    f.cleanup()
  }
})
