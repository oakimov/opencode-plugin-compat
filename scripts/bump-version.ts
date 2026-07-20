#!/usr/bin/env bun
/**
 * Bump the release-train version across all @opencode-compat packages.
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.1.2
 *
 * Updates:
 *   1. packages/<name>/package.json version
 *   2. export const VERSION (and profile OCP_VERSION) in src/index.ts
 *   3. bun.lock workspaces["packages/<name>"].version
 *
 * Bun's `pm pack` rewrites workspace:* from the **lockfile**, not package.json.
 * Plain `bun install` does **not** refresh those workspace version fields when
 * only package.json changed — so this script rewrites them explicitly, then
 * runs `bun install` to keep the lock consistent.
 *
 * Does not bump migrate-zcode EMITTER_VERSION (marketplace emitter, separate).
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { PACKAGES } from "./publish.ts"

const ROOT = resolve(import.meta.dir, "..")
const next = process.argv[2]

if (!next || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("Usage: bun scripts/bump-version.ts <semver>")
  console.error("Example: bun scripts/bump-version.ts 0.1.2")
  process.exit(1)
}

for (const dir of PACKAGES) {
  const pkgPath = join(ROOT, "packages", dir, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string
    version: string
  }
  const prev = pkg.version
  pkg.version = next
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name}: ${prev} → ${next}`)

  const indexPath = join(ROOT, "packages", dir, "src", "index.ts")
  let src = readFileSync(indexPath, "utf8")
  src = src.replace(
    /export const VERSION = "[^"]+" as const/,
    `export const VERSION = "${next}" as const`,
  )
  if (dir === "profile") {
    src = src.replace(
      /export const OCP_VERSION = "[^"]+" as const/,
      `export const OCP_VERSION = "${next}" as const`,
    )
  }
  writeFileSync(indexPath, src)
}

const lockPath = join(ROOT, "bun.lock")
let lockText = readFileSync(lockPath, "utf8")
for (const dir of PACKAGES) {
  const key = `packages/${dir}`
  const re = new RegExp(
    `("${key.replace(/\//g, "\\/")}":\\s*\\{[\\s\\S]*?"version":\\s*")([^"]+)(")`,
  )
  if (!re.test(lockText)) {
    console.error(`bun.lock: missing workspaces entry for ${key}`)
    process.exit(1)
  }
  lockText = lockText.replace(re, `$1${next}$3`)
}
writeFileSync(lockPath, lockText)
console.log(`\nbun.lock workspace versions → ${next}`)

console.log(`→ bun install (validate lock)`)
const install = spawnSync("bun", ["install"], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
})
if (install.status !== 0) {
  console.error("bun install failed after lock rewrite — inspect bun.lock")
  process.exit(install.status ?? 1)
}

console.log(`\nTrain version is now ${next} (package.json + bun.lock).`)
console.log("Next: bun run pack:check && commit (include bun.lock), then tag v" + next)
