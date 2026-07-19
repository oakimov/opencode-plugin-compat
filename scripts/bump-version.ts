#!/usr/bin/env bun
/**
 * Bump the release-train version across all @opencode-compat packages.
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.1.1
 *
 * Updates every packages/<name>/package.json version field and the
 * export const VERSION = "..." string in each package src/index.ts.
 * Also keeps profile OCP_VERSION equal to the train version.
 *
 * Does not bump migrate-zcode EMITTER_VERSION (marketplace emitter, separate).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { PACKAGES } from "./publish.ts"

const ROOT = resolve(import.meta.dir, "..")
const next = process.argv[2]

if (!next || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("Usage: bun scripts/bump-version.ts <semver>")
  console.error("Example: bun scripts/bump-version.ts 0.1.1")
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

console.log(`\nTrain version is now ${next}.`)
console.log("Next: bun run pack:check && commit, then tag v" + next)
