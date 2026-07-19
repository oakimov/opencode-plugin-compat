/**
 * Option B — install-tree provider shims for host LanguageModel adoption.
 *
 * After Layer A reify, rewrite custom provider package entries in-place so
 * `create*` → `languageModel()` streams get MiMo/Kilo policy applied without
 * editing upstream plugin sources. Needed because classic plugins often set
 * `npm` to a direct `file://…/dist/index.js` URL (bypasses package exports).
 */
import {
  ORIGINAL_SUFFIX,
  RUNTIME_FILENAME,
  SHIM_MARKER,
  SHIM_META_FILENAME,
  originalBackupPath,
  providerShimRuntimeSource,
  relativeImportPath,
  renderProviderShimSource,
  renderShimMeta,
  type ShimMeta,
} from "@opencode-compat/adapter"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

export type ProviderShimOptions = {
  /** Host plugin install root (e.g. ~/.cache/mimocode/packages). */
  dir: string
  /** Optional host id hint recorded in meta / used for messaging. */
  hostHint?: string
  dryRun?: boolean
}

export type ProviderShimTarget = {
  packageDir: string
  packageName?: string
  entry: string
  original: string
  changed: boolean
  skipped?: string
}

export type ProviderShimResult = {
  ok: boolean
  targets: ProviderShimTarget[]
  message: string
}

const SKIP_NAME_PREFIXES = [
  "@opencode-compat/",
  "@opencode-ai/",
  "@mimo-ai/",
  "@kilocode/",
  "@ai-sdk/",
]

const SKIP_NAMES = new Set([
  "opencode-compat-overrides",
  "typescript",
  "bun-types",
])

type PackageJson = {
  name?: string
  main?: string
  module?: string
  exports?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

function readJson(path: string): PackageJson | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson
  } catch {
    return undefined
  }
}

function exportConditionPath(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of ["import", "module", "default", "require", "node"]) {
    const hit = exportConditionPath(record[key])
    if (hit) return hit
  }
  return undefined
}

/** Resolve package root entry relative path (POSIX, leading `./`). */
export function resolvePackageEntryRel(pkg: PackageJson): string | undefined {
  const exportsField = pkg.exports
  if (typeof exportsField === "string") return normalizeRel(exportsField)
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const root = (exportsField as Record<string, unknown>)["."]
    const fromDot = exportConditionPath(root)
    if (fromDot) return normalizeRel(fromDot)
  }
  if (typeof pkg.module === "string" && pkg.module) return normalizeRel(pkg.module)
  if (typeof pkg.main === "string" && pkg.main) return normalizeRel(pkg.main)
  return undefined
}

function normalizeRel(value: string): string {
  const cleaned = value.replace(/\\/g, "/")
  if (cleaned.startsWith("./")) return cleaned
  if (cleaned.startsWith("/")) return `.${cleaned}`
  return `./${cleaned}`
}

function listScopedPackages(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return []
  const out: string[] = []
  for (const ent of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
    if (ent.name === ".bin") continue
    const full = join(nodeModules, ent.name)
    if (ent.name.startsWith("@")) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        out.push(join(full, scoped.name))
      }
      continue
    }
    out.push(full)
  }
  return out
}

function shouldSkipPackage(name: string | undefined): boolean {
  if (!name) return false
  if (SKIP_NAMES.has(name)) return true
  return SKIP_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Static scan for `export … create*` / named exports (sync; no module eval). */
export function discoverExportNames(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    names.add(match[1]!)
  }
  for (const match of source.matchAll(
    /export\s+(?:const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    names.add(match[1]!)
  }
  for (const match of source.matchAll(/export\s+\{([^}]+)\}/g)) {
    const body = match[1]!
    for (const part of body.split(",")) {
      const token = part.trim()
      if (!token) continue
      const asMatch = token.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (asMatch) {
        names.add(asMatch[2]!)
        continue
      }
      const ident = token.match(/^([A-Za-z_$][\w$]*)$/)
      if (ident) names.add(ident[1]!)
    }
  }
  return [...names]
}

function hasCreateExport(names: string[]): boolean {
  return names.some((name) => name.startsWith("create"))
}

function looksLikeProviderPackage(pkg: PackageJson, entrySource: string): boolean {
  if (shouldSkipPackage(pkg.name)) return false
  const names = discoverExportNames(entrySource)
  if (!hasCreateExport(names)) return false
  // Prefer AI-provider shaped packages; still allow create* + languageModel mention.
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }
  if ("@ai-sdk/provider" in deps) return true
  if (entrySource.includes("languageModel")) return true
  if ((pkg.name ?? "").includes("provider")) return true
  return hasCreateExport(names)
}

/** Discover provider package directories under a host install tree. */
export function discoverProviderPackageDirs(installRoot: string): string[] {
  const root = resolve(installRoot)
  if (!existsSync(root)) return []
  const found = new Set<string>()

  const consider = (pkgDir: string) => {
    const pkgPath = join(pkgDir, "package.json")
    const pkg = readJson(pkgPath)
    if (!pkg) return
    if (shouldSkipPackage(pkg.name)) return
    const entryRel = resolvePackageEntryRel(pkg)
    if (!entryRel) return
    const entryAbs = resolve(pkgDir, entryRel)
    // When already shimmed, read the backup for discovery.
    const backupAbs = originalBackupPath(entryAbs)
    const sourcePath = existsSync(backupAbs)
      ? backupAbs
      : existsSync(entryAbs)
        ? entryAbs
        : undefined
    if (!sourcePath) return
    let source: string
    try {
      source = readFileSync(sourcePath, "utf8")
    } catch {
      return
    }
    // If reading the live entry and it is our shim, require backup.
    if (source.includes(SHIM_MARKER) && !existsSync(backupAbs)) return
    const probeSource = existsSync(backupAbs)
      ? readFileSync(backupAbs, "utf8")
      : source.includes(SHIM_MARKER)
        ? ""
        : source
    if (!probeSource || !looksLikeProviderPackage(pkg, probeSource)) return
    found.add(pkgDir)
  }

  // Isolated host layout: packages/<name>@<ver>/node_modules/<pkg>
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue
    const child = join(root, ent.name)
    consider(child)
    for (const mod of listScopedPackages(join(child, "node_modules"))) {
      consider(mod)
    }
  }
  // Also scan root node_modules when present
  for (const mod of listScopedPackages(join(root, "node_modules"))) {
    consider(mod)
  }

  return [...found].sort()
}

function writeText(path: string, contents: string, dryRun: boolean): void {
  if (dryRun) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, "utf8")
}

function shimOnePackage(
  packageDir: string,
  options: { hostHint?: string; dryRun?: boolean },
): ProviderShimTarget {
  const pkg = readJson(join(packageDir, "package.json"))
  const packageName = pkg?.name
  if (!pkg) {
    return {
      packageDir,
      entry: "",
      original: "",
      changed: false,
      skipped: "missing package.json",
    }
  }
  const entryRel = resolvePackageEntryRel(pkg)
  if (!entryRel) {
    return {
      packageDir,
      packageName,
      entry: "",
      original: "",
      changed: false,
      skipped: "no package entry",
    }
  }

  const entryAbs = resolve(packageDir, entryRel)
  const backupAbs = originalBackupPath(entryAbs)
  const dryRun = options.dryRun ?? false

  let exportSourcePath = entryAbs
  let changed = false

  if (existsSync(backupAbs)) {
    exportSourcePath = backupAbs
    // Refresh shim/runtime even when backup already exists.
  } else if (existsSync(entryAbs)) {
    const current = readFileSync(entryAbs, "utf8")
    if (current.includes(SHIM_MARKER)) {
      return {
        packageDir,
        packageName,
        entry: entryRel,
        original: normalizeRel(relative(packageDir, backupAbs) || basename(backupAbs)),
        changed: false,
        skipped: "shim present without backup; refuse to clobber",
      }
    }
    if (!dryRun) renameSync(entryAbs, backupAbs)
    changed = true
    exportSourcePath = backupAbs
  } else {
    return {
      packageDir,
      packageName,
      entry: entryRel,
      original: "",
      changed: false,
      skipped: "entry file missing",
    }
  }

  const originalSource = readFileSync(
    dryRun && !existsSync(backupAbs) ? entryAbs : exportSourcePath,
    "utf8",
  )
  const exportNames = discoverExportNames(originalSource).filter(
    (name) => name !== "default",
  )
  if (!hasCreateExport(exportNames)) {
    return {
      packageDir,
      packageName,
      entry: entryRel,
      original: normalizeRel(relative(packageDir, backupAbs)),
      changed: false,
      skipped: "no create* exports",
    }
  }

  const originalRelFromEntry = relativeImportPath(
    entryRel,
    normalizeRel(relative(packageDir, backupAbs) || `${entryRel.replace(/\.js$/, "")}${ORIGINAL_SUFFIX}`),
  )

  const meta: ShimMeta = {
    original: originalRelFromEntry,
    entry: entryRel,
    exportNames,
    hostHint: options.hostHint,
    strategy: "inplace-entry",
  }

  const runtimePath = join(dirname(entryAbs), RUNTIME_FILENAME)
  const metaPath = join(packageDir, SHIM_META_FILENAME)
  const shimSource = renderProviderShimSource(meta)
  const runtimeSource = providerShimRuntimeSource()
  const metaSource = renderShimMeta(meta)

  const prevShim = existsSync(entryAbs) ? readFileSync(entryAbs, "utf8") : ""
  const prevRuntime = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : ""
  const prevMeta = existsSync(metaPath) ? readFileSync(metaPath, "utf8") : ""

  if (
    prevShim !== shimSource ||
    prevRuntime !== runtimeSource ||
    prevMeta !== metaSource ||
    changed
  ) {
    changed = true
  }

  writeText(runtimePath, runtimeSource, dryRun)
  writeText(entryAbs, shimSource, dryRun)
  writeText(metaPath, metaSource, dryRun)

  return {
    packageDir,
    packageName,
    entry: entryRel,
    original: meta.original,
    changed,
  }
}

/** Apply Option B shims under a host plugin install tree. */
export function setupProviderShims(
  options: ProviderShimOptions,
): ProviderShimResult {
  const dir = resolve(options.dir)
  const dirs = discoverProviderPackageDirs(dir)
  const targets = dirs.map((packageDir) =>
    shimOnePackage(packageDir, {
      hostHint: options.hostHint,
      dryRun: options.dryRun,
    }),
  )
  const changed = targets.filter((t) => t.changed).length
  const skipped = targets.filter((t) => t.skipped)
  const action = options.dryRun ? "dry-run" : "wrote"
  const message = [
    `provider-shim ${action}: scanned ${targets.length} provider package(s), ${changed} changed`,
    ...targets
      .filter((t) => t.changed || t.skipped)
      .map((t) =>
        t.skipped
          ? `  - ${t.packageName ?? t.packageDir}: skipped (${t.skipped})`
          : `  ~ ${t.packageName ?? t.packageDir}: ${t.entry} → shim (${t.original})`,
      ),
    ...(skipped.length === 0
      ? []
      : [`note: ${skipped.length} candidate(s) skipped`]),
  ].join("\n")

  return {
    ok: true,
    targets,
    message,
  }
}
