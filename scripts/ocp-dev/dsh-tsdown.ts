import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

export type DshBuildFace = "host" | "client"

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function addPackage(harness: string, dir: string, rels: string[]): void {
  if (!existsSync(join(dir, "package.json"))) return
  const rel = relative(harness, dir)
  rels.push(rel === "" ? "." : rel)
}

/**
 * tsdown workspace globs (vendor/*, packages/<group>/<pkg>, apps/cli, ...)
 * include leftover directories that no longer have package.json. Those inherit
 * the root entry glob, resolve the root package name by walking up, and abort
 * the documented `pnpm run build`. Restrict tsdown to real packages.
 */
export function dshWorkspacePackageCwdFilter(harness: string, face: DshBuildFace): RegExp {
  const rels: string[] = []
  const vendor = join(harness, "vendor")
  if (isDir(vendor)) {
    for (const name of readdirSync(vendor)) addPackage(harness, join(vendor, name), rels)
  }
  const packages = join(harness, "packages")
  if (isDir(packages)) {
    for (const group of readdirSync(packages)) {
      const groupDir = join(packages, group)
      if (!isDir(groupDir)) continue
      for (const name of readdirSync(groupDir)) addPackage(harness, join(groupDir, name), rels)
    }
  }
  const apps = face === "host" ? ["cli", "desktop", "desktop-host"] : ["cli"]
  for (const app of apps) addPackage(harness, join(harness, "apps", app), rels)
  if (rels.length === 0) {
    throw new Error(`dsh tsdown: no workspace packages with package.json under ${harness}`)
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^(?:${rels.map(escape).join("|")})$`)
}

export async function runDshTsdown(harness: string, face: DshBuildFace): Promise<void> {
  const filter = dshWorkspacePackageCwdFilter(harness, face)
  const tsdownEntry = join(harness, "node_modules", "tsdown", "dist", "index.mjs")
  if (!existsSync(tsdownEntry)) throw new Error(`dsh tsdown: tsdown not installed at ${tsdownEntry}`)
  const { build } = await import(pathToFileURL(tsdownEntry).href) as {
    build: (opts: { cwd: string; env: { DSH_BUILD_FACE: DshBuildFace }; filter: RegExp }) => Promise<unknown>
  }
  // tsdown's --filter compares path.relative(process.cwd(), packageDir).
  const previous = process.cwd()
  process.chdir(harness)
  try {
    await build({ cwd: harness, env: { DSH_BUILD_FACE: face }, filter })
  } finally {
    process.chdir(previous)
  }
}

if (import.meta.main) {
  const harness = process.argv[2]
  const face = process.argv[3]
  if (!harness || (face !== "host" && face !== "client")) {
    console.error("usage: dsh-tsdown.ts <harness> <host|client>")
    process.exit(1)
  }
  await runDshTsdown(harness, face)
}
