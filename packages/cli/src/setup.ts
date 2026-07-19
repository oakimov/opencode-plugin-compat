/**
 * Layer A setup — write `@opencode-ai/{plugin,sdk}` install-tree overrides
 * that resolve to `@opencode-compat/facade-*`.
 */
import {
  detect,
  facadeOverrides,
  type DetectOptions,
  type HostId,
} from "@opencode-compat/profile"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type SetupMode = "npm" | "file"

export type SetupOptions = {
  /** Target install tree (defaults to detected host `pluginInstallDir`). */
  dir?: string
  /** Force host id (sets OPENCODE_COMPAT_HOST for detect). */
  host?: HostId | string
  /** Override map version for npm: specs (default 0.1.0). */
  version?: string
  /** Prefer npm: specs or local file: paths. Auto when omitted. */
  mode?: SetupMode | "auto"
  /** Print actions without writing. */
  dryRun?: boolean
  /** Also patch immediate child package.json trees (installed plugins). */
  deep?: boolean
  /** Detect options (tests). */
  detectOptions?: DetectOptions
}

export type SetupTarget = {
  path: string
  created: boolean
  changed: boolean
}

export type SetupResult = {
  ok: boolean
  host: HostId
  source?: string
  dir: string
  mode: SetupMode
  overrides: Record<string, string>
  targets: SetupTarget[]
  message: string
}

type PackageJson = {
  name?: string
  private?: boolean
  overrides?: Record<string, string>
  [key: string]: unknown
}

function packagesRootFromHere(): string {
  // packages/cli/src → packages/
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..")
}

function resolveFileOverrides(): Record<string, string> | undefined {
  const root = packagesRootFromHere()
  const plugin = join(root, "facade-plugin")
  const sdk = join(root, "facade-sdk")
  if (!existsSync(join(plugin, "package.json"))) return undefined
  if (!existsSync(join(sdk, "package.json"))) return undefined
  return {
    "@opencode-ai/plugin": `file:${plugin}`,
    "@opencode-ai/sdk": `file:${sdk}`,
  }
}

function resolveMode(
  requested: SetupOptions["mode"],
  version: string,
): { mode: SetupMode; overrides: Record<string, string> } {
  if (requested === "npm") {
    return { mode: "npm", overrides: facadeOverrides(version) }
  }
  if (requested === "file") {
    const file = resolveFileOverrides()
    if (!file) {
      throw new Error(
        "setup --mode file: could not locate sibling facade-plugin / facade-sdk packages",
      )
    }
    return { mode: "file", overrides: file }
  }
  // auto: prefer local file: when running from a checkout / packed sibling layout
  const file = resolveFileOverrides()
  if (file) return { mode: "file", overrides: file }
  return { mode: "npm", overrides: facadeOverrides(version) }
}

function readPackageJson(path: string): PackageJson | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid package.json at ${path}: ${message}`)
  }
}

function mergeOverrides(
  pkg: PackageJson,
  overrides: Record<string, string>,
): { pkg: PackageJson; changed: boolean } {
  const next: PackageJson = { ...pkg }
  const prev = { ...(pkg.overrides ?? {}) }
  let changed = false
  for (const [key, value] of Object.entries(overrides)) {
    if (prev[key] !== value) {
      prev[key] = value
      changed = true
    }
  }
  next.overrides = prev
  if (!next.name) {
    next.name = "opencode-compat-overrides"
    changed = true
  }
  if (next.private !== true) {
    next.private = true
    changed = true
  }
  return { pkg: next, changed }
}

function writePackageJson(path: string, pkg: PackageJson, dryRun: boolean): void {
  if (dryRun) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
}

function listChildPackageJson(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
    const pkgPath = join(dir, ent.name, "package.json")
    if (existsSync(pkgPath)) out.push(pkgPath)
  }
  return out
}

/** Apply Layer A overrides into one or more package.json files under an install tree. */
export function setup(options: SetupOptions = {}): SetupResult {
  const version = options.version ?? "0.1.0"
  const dryRun = options.dryRun ?? false
  const deep = options.deep ?? true

  const env = options.host
    ? {
        ...(options.detectOptions?.env ?? process.env),
        OPENCODE_COMPAT_HOST: options.host,
      }
    : options.detectOptions?.env

  const detected = detect({
    ...options.detectOptions,
    env,
  })

  const { mode, overrides } = resolveMode(options.mode, version)

  const dir =
    options.dir?.trim() ||
    detected.profile.paths.pluginInstallDir ||
    undefined

  if (!dir) {
    return {
      ok: false,
      host: detected.id,
      source: detected.source,
      dir: "",
      mode,
      overrides,
      targets: [],
      message:
        detected.message ??
        `setup: could not resolve plugin install dir for host=${detected.id}; pass --dir`,
    }
  }

  if (!detected.supported && !options.dir?.trim()) {
    return {
      ok: false,
      host: detected.id,
      source: detected.source,
      dir,
      mode,
      overrides,
      targets: [],
      message:
        detected.message ??
        `setup: host=${detected.id} is unsupported; pass --dir to write overrides anyway`,
    }
  }

  const resolvedDir = resolve(dir)
  const targets: SetupTarget[] = []

  const rootPkgPath = join(resolvedDir, "package.json")
  const existingRoot = readPackageJson(rootPkgPath)
  const createdRoot = !existingRoot
  const rootBase: PackageJson = existingRoot ?? {
    name: "opencode-compat-overrides",
    private: true,
  }
  const mergedRoot = mergeOverrides(rootBase, overrides)
  if (mergedRoot.changed || createdRoot) {
    writePackageJson(rootPkgPath, mergedRoot.pkg, dryRun)
    targets.push({
      path: rootPkgPath,
      created: createdRoot,
      changed: true,
    })
  } else {
    targets.push({ path: rootPkgPath, created: false, changed: false })
  }

  if (deep) {
    for (const childPath of listChildPackageJson(resolvedDir)) {
      const child = readPackageJson(childPath)
      if (!child) continue
      const merged = mergeOverrides(child, overrides)
      if (!merged.changed) {
        targets.push({ path: childPath, created: false, changed: false })
        continue
      }
      writePackageJson(childPath, merged.pkg, dryRun)
      targets.push({ path: childPath, created: false, changed: true })
    }
  }

  const changed = targets.filter((t) => t.changed).length
  const action = dryRun ? "dry-run" : "wrote"
  const message = [
    `setup ${action}: host=${detected.id} mode=${mode} dir=${resolvedDir}`,
    `overrides: ${Object.keys(overrides).join(", ")}`,
    `targets: ${changed} changed / ${targets.length} scanned`,
    "Note: listing OCP in host plugin config alone does not intercept @opencode-ai/* imports.",
  ].join("\n")

  return {
    ok: true,
    host: detected.id,
    source: detected.source,
    dir: resolvedDir,
    mode,
    overrides,
    targets,
    message,
  }
}

export function parseSetupArgs(rest: string[]): {
  dir?: string
  host?: string
  version?: string
  mode?: SetupMode | "auto"
  dryRun: boolean
  deep: boolean
  help: boolean
} {
  const opts: {
    dir?: string
    host?: string
    version?: string
    mode?: SetupMode | "auto"
    dryRun: boolean
    deep: boolean
    help: boolean
  } = {
    dryRun: false,
    deep: true,
    help: false,
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg === "--dir") opts.dir = rest[++i]
    else if (arg?.startsWith("--dir=")) opts.dir = arg.slice("--dir=".length)
    else if (arg === "--host") opts.host = rest[++i]
    else if (arg?.startsWith("--host=")) opts.host = arg.slice("--host=".length)
    else if (arg === "--version") opts.version = rest[++i]
    else if (arg?.startsWith("--version=")) {
      opts.version = arg.slice("--version=".length)
    } else if (arg === "--mode") {
      const value = rest[++i]
      if (value === "npm" || value === "file" || value === "auto") opts.mode = value
    } else if (arg?.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length)
      if (value === "npm" || value === "file" || value === "auto") opts.mode = value
    } else if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--deep") opts.deep = true
    else if (arg === "--no-deep") opts.deep = false
  }
  return opts
}
