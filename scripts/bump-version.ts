#!/usr/bin/env bun
/**
 * Bump the release-train version across all @opencode-compat packages.
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.1.2
 *
 * Updates:
 *   1. packages/<name>/package.json version
 *   2. Exact @opencode-compat/* train pins in dependencies (not workspace:*)
 *   3. export const VERSION in src/index.ts (profile: src/version.ts + OCP_VERSION)
 *   4. bun.lock workspaces["packages/<name>"].version
 *
 * Bun's `pm pack` rewrites workspace:* from the **lockfile**, not package.json.
 * Plain `bun install` does **not** refresh those workspace version fields when
 * only package.json changed — so this script rewrites them explicitly, then
 * runs `bun install` to keep the lock consistent.
 *
 * pi-bridge / dsh-bridge must keep **exact** @opencode-compat/* pins (never
 * workspace:*): foreign `file:` installers (DSH profile pnpm, pi/omp) cannot
 * see this Bun workspace. This script refuses workspace protocol on those
 * packages and rewrites their exact pins with the train.
 *
 * Does not bump migrate-zcode EMITTER_VERSION (marketplace emitter, separate).
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assertForeignFileInstallExactPins, FOREIGN_FILE_INSTALL_PACKAGES, PACKAGES } from "./publish.ts"

const ROOT = resolve(import.meta.dir, "..")
const next = process.argv[2]
const FOREIGN_FILE_INSTALL = new Set<string>(FOREIGN_FILE_INSTALL_PACKAGES)

if (!next || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("Usage: bun scripts/bump-version.ts <semver>")
  console.error("Example: bun scripts/bump-version.ts 0.1.2")
  process.exit(1)
}

/** Refuse before any writes so a bad pin cannot leave a half-bumped tree. */
function preflightForeignFileInstallNoWorkspace(): void {
  const errors: string[] = []
  for (const dir of FOREIGN_FILE_INSTALL_PACKAGES) {
    const pkgPath = join(ROOT, "packages", dir, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const) {
      const deps = pkg[field]
      if (!deps) continue
      for (const [name, range] of Object.entries(deps)) {
        if (!name.startsWith("@opencode-compat/")) continue
        if (range === "workspace:*" || range.startsWith("workspace:")) {
          errors.push(`${pkg.name} ${field}.${name}=${range}`)
        }
      }
    }
  }
  if (errors.length === 0) return
  console.error("Foreign file-install pin gate failed (refusing to bump — no files written):")
  for (const line of errors) console.error(`  - ${line}`)
  console.error(
    `Keep pi-bridge / dsh-bridge on exact @opencode-compat/* train pins — never workspace:*.`,
  )
  console.error(`Fix: restore exact pins, then re-run bun scripts/bump-version.ts ${next}`)
  process.exit(1)
}

preflightForeignFileInstallNoWorkspace()

for (const dir of PACKAGES) {
  const pkgPath = join(ROOT, "packages", dir, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string
    version: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const prev = pkg.version
  pkg.version = next
  // Exact train pins (not workspace:*) must move with the bump so pack/typecheck
  // do not keep resolving a prior published sibling.
  //
  // pi-bridge / dsh-bridge are installed into foreign package managers via
  // `file:` (DSH profile pnpm, pi/omp installers). Those hosts cannot resolve
  // Bun `workspace:*`, so those packages must keep exact pins — never convert
  // them to workspace:*. See docs/guides/npm-publish.md (§ foreign file:).
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const) {
    const deps = pkg[field]
    if (!deps) continue
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@opencode-compat/")) continue
      if (range === "workspace:*" || range.startsWith("workspace:")) {
        if (FOREIGN_FILE_INSTALL.has(dir)) {
          console.error(
            `${pkg.name}: refusing workspace protocol on ${field}.${name}=${range}. ` +
              `Foreign file: installs need an exact train pin; bump-version will rewrite it.`,
          )
          process.exit(1)
        }
        continue
      }
      if (/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(range)) {
        deps[name] = next
        console.log(`  ${pkg.name} ${field}.${name}: ${range} → ${next}`)
      }
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name}: ${prev} → ${next}`)

  const indexPath = join(ROOT, "packages", dir, "src", "index.ts")
  if (dir === "profile") {
    const versionPath = join(ROOT, "packages", dir, "src", "version.ts")
    writeFileSync(
      versionPath,
      [
        `/** Package / OCP train version — kept in sync by \`bun scripts/bump-version.ts\`. */`,
        `export const VERSION = "${next}" as const`,
        `export const OCP_VERSION = "${next}" as const`,
        ``,
      ].join("\n"),
    )
  } else {
    let src = readFileSync(indexPath, "utf8")
    src = src.replace(
      /export const VERSION = "[^"]+" as const/,
      `export const VERSION = "${next}" as const`,
    )
    writeFileSync(indexPath, src)
  }
}

const lockPath = join(ROOT, "bun.lock")
let lockText = readFileSync(lockPath, "utf8")
for (const dir of PACKAGES) {
  const key = `packages/${dir}`
  // `/` is not special in `new RegExp(...)`; no escaping needed (and avoids
  // incomplete-sanitization false positives from escaping only `/`).
  const re = new RegExp(
    `("${key}":\\s*\\{[\\s\\S]*?"version":\\s*")([^"]+)(")`,
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

// Fail closed: pi-bridge / dsh-bridge must still be on exact train pins after the bump
// (assertForeignFileInstallExactPins prints foreign-file-pins-ok on success).
try {
  assertForeignFileInstallExactPins(next)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

console.log(`\nTrain version is now ${next} (package.json + bun.lock).`)
console.log("Next: bun run pack:check && commit (include bun.lock), then tag v" + next)