/**
 * Layer A setup — write `@opencode-ai/{plugin,sdk}` install-tree overrides
 * that resolve to `@opencode-compat/facade-*`, then Option B provider shims.
 */
import {
  detect,
  facadeOverrides,
  type DetectOptions,
  type HostId,
} from "@opencode-compat/profile"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  setupProviderShims,
  type ProviderShimResult,
} from "./provider-shim"

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
  /**
   * After writing overrides, reify install trees that already have
   * `node_modules` (or always when `"force"`) so facade overrides link.
   * Default: `"auto"`.
   */
  reify?: boolean | "auto" | "force"
  /**
   * After reify, write Option B in-place provider entry shims
   * (`create*` → host-dynamic languageModel adoption). Default: true.
   */
  providerShim?: boolean
  /** Detect options (tests). */
  detectOptions?: DetectOptions
}

export type SetupTarget = {
  path: string
  created: boolean
  changed: boolean
  reified?: boolean
  reifyError?: string
}

export type SetupResult = {
  ok: boolean
  host: HostId
  source?: string
  dir: string
  mode: SetupMode
  overrides: Record<string, string>
  targets: SetupTarget[]
  providerShim?: ProviderShimResult
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

function shouldReify(
  pkgDir: string,
  target: SetupTarget,
  reify: boolean | "auto" | "force",
): boolean {
  if (reify === false) return false
  if (!target.changed) return false
  if (reify === "force" || reify === true) return true
  // auto: only when the tree was already installed (common after `mimo plugin` / `kilo plugin`)
  return existsSync(join(pkgDir, "node_modules"))
}

function reifyInstallTree(pkgDir: string, dryRun: boolean): { ok: boolean; error?: string } {
  if (dryRun) return { ok: true }
  const result = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-fund", "--no-audit"],
    {
      cwd: pkgDir,
      encoding: "utf8",
      env: process.env,
    },
  )
  if (result.status === 0) return { ok: true }
  const detail = [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim()
  return {
    ok: false,
    error: detail || `npm install exited ${result.status ?? "unknown"}`,
  }
}

/** Apply Layer A overrides into one or more package.json files under an install tree. */
export function setup(options: SetupOptions = {}): SetupResult {
  const version = options.version ?? "0.1.0"
  const dryRun = options.dryRun ?? false
  const deep = options.deep ?? true
  const reify = options.reify ?? "auto"
  const providerShim = options.providerShim ?? true

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

  // MiMo/Kilo install each npm plugin in an isolated child dir
  // (`name@version/`). Parent overrides alone do not apply — reify children
  // after patching so `@opencode-ai/*` links to facades.
  for (const target of targets) {
    const pkgDir = dirname(target.path)
    if (!shouldReify(pkgDir, target, reify)) continue
    // Skip empty root marker trees with no dependencies to install.
    const pkg = readPackageJson(target.path)
    const hasDeps =
      pkg &&
      Object.keys({
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
        ...(pkg.optionalDependencies as Record<string, string> | undefined),
        ...(pkg.peerDependencies as Record<string, string> | undefined),
      }).length > 0
    if (!hasDeps && !existsSync(join(pkgDir, "node_modules"))) continue

    const outcome = reifyInstallTree(pkgDir, dryRun)
    target.reified = outcome.ok
    if (!outcome.ok) target.reifyError = outcome.error
  }

  // Option B must run *after* reify — npm install restores stock package
  // files from the tarball and would wipe in-place entry shims.
  let providerShimResult: ProviderShimResult | undefined
  if (providerShim) {
    providerShimResult = setupProviderShims({
      dir: resolvedDir,
      hostHint: detected.id,
      dryRun,
    })
  }

  const changed = targets.filter((t) => t.changed).length
  const reified = targets.filter((t) => t.reified).length
  const reifyFailed = targets.filter((t) => t.reifyError)
  const action = dryRun ? "dry-run" : "wrote"
  const message = [
    `setup ${action}: host=${detected.id} mode=${mode} dir=${resolvedDir}`,
    `overrides: ${Object.keys(overrides).join(", ")}`,
    `targets: ${changed} changed / ${targets.length} scanned` +
      (reified || reifyFailed.length
        ? `; reified ${reified}` +
          (reifyFailed.length ? `, ${reifyFailed.length} reify failed` : "")
        : ""),
    providerShimResult ? providerShimResult.message : "provider-shim: skipped (--no-provider-shim)",
    "Note: listing OCP in host plugin config alone does not intercept @opencode-ai/* imports.",
    "Note: on MiMo/Kilo, re-run `ocp setup` after installing plugins (isolated per-plugin trees).",
    "Note: provider shims are install-tree only (in-place entry); re-apply after plugin upgrade/reify.",
    ...reifyFailed.map((t) => `reify failed: ${dirname(t.path)} — ${t.reifyError}`),
  ].join("\n")

  return {
    ok: reifyFailed.length === 0 && (providerShimResult?.ok ?? true),
    host: detected.id,
    source: detected.source,
    dir: resolvedDir,
    mode,
    overrides,
    targets,
    providerShim: providerShimResult,
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
  reify: boolean | "auto" | "force"
  providerShim: boolean
  help: boolean
} {
  const opts: {
    dir?: string
    host?: string
    version?: string
    mode?: SetupMode | "auto"
    dryRun: boolean
    deep: boolean
    reify: boolean | "auto" | "force"
    providerShim: boolean
    help: boolean
  } = {
    dryRun: false,
    deep: true,
    reify: "auto",
    providerShim: true,
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
    else if (arg === "--reify") opts.reify = "force"
    else if (arg === "--no-reify") opts.reify = false
    else if (arg?.startsWith("--reify=")) {
      const value = arg.slice("--reify=".length)
      if (value === "auto" || value === "force") opts.reify = value
      else if (value === "false" || value === "0" || value === "no") opts.reify = false
      else if (value === "true" || value === "1" || value === "yes") opts.reify = "force"
    } else if (arg === "--provider-shim") opts.providerShim = true
    else if (arg === "--no-provider-shim") opts.providerShim = false
  }
  return opts
}