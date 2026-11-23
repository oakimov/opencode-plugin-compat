/**
 * Every published `@opencode-compat/*` export must load as plain Node ESM.
 * Bun resolves extensionless relative imports (`from "./version"`) that
 * Node's ESM loader rejects with ERR_MODULE_NOT_FOUND, so a Bun-only test run
 * cannot catch a dist that breaks Node consumers and Node-based hosts.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

type Entry = { name: string; file: string }

/** Each package's ESM export targets, from its own package.json. */
function publishedEntries(): Entry[] {
  const entries: Entry[] = []
  for (const dir of fs.readdirSync(path.join(root, "packages")).sort()) {
    const manifestPath = path.join(root, "packages", dir, "package.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      name: string
      main?: string
      exports?: string | Record<string, string | { import?: string; default?: string }>
    }
    const exportsField = manifest.exports ?? { ".": manifest.main ?? "" }
    const map = typeof exportsField === "string" ? { ".": exportsField } : exportsField
    for (const [subpath, target] of Object.entries(map)) {
      const file = typeof target === "string" ? target : target.import ?? target.default
      if (!file || !/\.m?js$/.test(file)) continue
      entries.push({
        name: subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
        file: path.resolve(root, "packages", dir, file),
      })
    }
  }
  return entries
}

const NODE_IMPORTER = `
const files = JSON.parse(process.argv[1])
const failures = []
for (const [name, file] of files) {
  try { await import(new URL("file://" + file).href) }
  catch (error) { failures.push(name + ": " + String(error && error.message).split("\\n")[0]) }
}
process.stdout.write(JSON.stringify(failures))
process.exit(0)
`

describe("published dist loads under Node ESM", () => {
  const entries = publishedEntries()

  beforeAll(() => {
    if (entries.every(entry => fs.existsSync(entry.file))) return
    const built = spawnSync("bunx", ["tsc", "-b"], { cwd: root, encoding: "utf8" })
    expect(built.status, built.stderr || built.stdout).toBe(0)
  })

  test("finds every package entry", () => {
    expect(entries.map(entry => entry.name)).toContain("@opencode-compat/profile")
    expect(entries.length).toBeGreaterThanOrEqual(11)
    for (const entry of entries) expect(fs.existsSync(entry.file), entry.file).toBe(true)
  })

  test("imports every export with node", () => {
    const node = Bun.which("node")
    expect(node, "node is required to check Node ESM loading").toBeTruthy()
    const result = spawnSync(
      node!,
      ["--input-type=module", "-e", NODE_IMPORTER, JSON.stringify(entries.map(entry => [entry.name, entry.file]))],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout) as string[]).toEqual([])
  })
})
