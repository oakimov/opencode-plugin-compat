/**
 * Option B — install-tree provider shims for host LanguageModel adoption.
 *
 * After Layer A reify, rewrite custom provider package entries in-place so
 * `create*` → `languageModel()` streams get MiMo/Kilo policy applied without
 * provider-specific source changes. Needed because classic plugins often set
 * `npm` to a direct `file://…/dist/index.js` URL (bypasses package exports).
 */
import {
  RUNTIME_FILENAME,
  SHIM_MARKER,
  SHIM_META_FILENAME,
  providerShimRuntimeSource,
  renderProviderShimSource,
  renderShimMeta,
  stripProviderShimSource,
  type ShimFactoryBinding,
  type ShimMeta,
} from "@opencode-compat/adapter"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

export type ProviderShimOptions = {
  /** Host plugin install root (e.g. ~/.cache/mimocode/packages). */
  dir: string
  /** Inspect only dir itself (for one configured absolute/file:// plugin). */
  rootOnly?: boolean
  /** Optional host id hint recorded in meta / used for messaging. */
  hostHint?: string
  dryRun?: boolean
}

export type ProviderShimTarget = {
  packageDir: string
  packageName?: string
  entry: string
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function declarationForLocal(
  source: string,
  localName: string,
): ShimFactoryBinding["declaration"] | undefined {
  const name = escapeRegExp(localName)
  const match = source.match(
    new RegExp(
      `(?:^|[;\\n])\\s*(?:export\\s+)?(?:async\\s+)?(function|const|let|var|class)\\s+${name}\\b`,
      "m",
    ),
  )
  return match?.[1] as ShimFactoryBinding["declaration"] | undefined
}

/** Find exported create* factories whose local binding can be instrumented. */
export function discoverFactoryBindings(source: string): ShimFactoryBinding[] {
  const stockSource = stripProviderShimSource(source)
  const found = new Map<string, ShimFactoryBinding>()

  for (const match of stockSource.matchAll(
    /export\s+(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    const declaration = match[1] as ShimFactoryBinding["declaration"]
    const name = match[2]!
    if (!name.startsWith("create")) continue
    found.set(name, { exportName: name, localName: name, declaration })
  }

  for (const match of stockSource.matchAll(
    /export\s*\{([^}]+)\}\s*(from\s*["'][^"']+["'])?\s*;?/g,
  )) {
    if (match[2]) continue
    for (const part of match[1]!.split(",")) {
      const token = part.trim()
      if (!token || token.startsWith("type ")) continue
      const alias = token.match(
        /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
      )
      const localName = alias?.[1] ?? token
      const exportName = alias?.[2] ?? token
      if (!exportName.startsWith("create")) continue
      if (!/^[A-Za-z_$][\w$]*$/.test(localName)) continue
      const declaration = declarationForLocal(stockSource, localName)
      if (!declaration) continue
      found.set(exportName, { exportName, localName, declaration })
    }
  }

  return [...found.values()]
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

function looksLikeProviderPackage(pkg: PackageJson, entrySource: string): boolean {
  if (shouldSkipPackage(pkg.name)) return false
  if (discoverFactoryBindings(entrySource).length === 0) return false
  // Prefer AI-provider shaped packages; still allow create* + languageModel mention.
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }
  if ("@ai-sdk/provider" in deps) return true
  if (entrySource.includes("languageModel")) return true
  if ((pkg.name ?? "").includes("provider")) return true
  return false
}

/** Discover provider package directories under a host install tree. */
export function discoverProviderPackageDirs(
  installRoot: string,
  options: { rootOnly?: boolean } = {},
): string[] {
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
    if (!existsSync(entryAbs)) return
    let source: string
    try {
      source = readFileSync(entryAbs, "utf8")
    } catch {
      return
    }
    // Legacy backup-based wrappers must still reach shimOnePackage so setup
    // can report the required stock reinstall/build instead of silently hiding.
    if (
      source.includes(SHIM_MARKER) &&
      stripProviderShimSource(source) === source
    ) {
      found.add(pkgDir)
      return
    }
    if (!looksLikeProviderPackage(pkg, source)) return
    found.add(pkgDir)
  }

  // Absolute-path / file:// setup passes the provider package root itself,
  // while host install-tree setup passes a directory containing packages.
  // When the root is itself a provider, stop there: its dependencies are not
  // independent host-installed provider targets.
  consider(root)
  if (options.rootOnly || found.has(root)) return [...found]

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

function legacyBackupPath(entryPath: string): string {
  if (entryPath.endsWith(".js")) {
    return `${entryPath.slice(0, -3)}.ocp-original.js`
  }
  if (entryPath.endsWith(".mjs")) {
    return `${entryPath.slice(0, -4)}.ocp-original.js`
  }
  return `${entryPath}.ocp-original.js`
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
      changed: false,
      skipped: "no package entry",
    }
  }

  const entryAbs = resolve(packageDir, entryRel)
  const dryRun = options.dryRun ?? false
  if (!existsSync(entryAbs)) {
    return {
      packageDir,
      packageName,
      entry: entryRel,
      changed: false,
      skipped: "entry file missing",
    }
  }

  const currentSource = readFileSync(entryAbs, "utf8")
  const stockSource = stripProviderShimSource(currentSource)
  if (currentSource.includes(SHIM_MARKER) && stockSource === currentSource) {
    return {
      packageDir,
      packageName,
      entry: entryRel,
      changed: false,
      skipped: "legacy backup shim present; reinstall or rebuild stock entry",
    }
  }

  const factories = discoverFactoryBindings(stockSource)
  if (factories.length === 0) {
    return {
      packageDir,
      packageName,
      entry: entryRel,
      changed: false,
      skipped: "no instrumentable create* exports",
    }
  }

  const meta: ShimMeta = {
    entry: entryRel,
    factories,
    hostHint: options.hostHint,
    strategy: "instrumented-entry",
  }

  const entryDir = dirname(entryAbs)
  const runtimePath = join(entryDir, RUNTIME_FILENAME)
  const metaPath = join(entryDir, SHIM_META_FILENAME)
  const legacyMetaPath = join(packageDir, SHIM_META_FILENAME)
  const backupPath = legacyBackupPath(entryAbs)
  const shimSource = renderProviderShimSource(meta, stockSource)
  const runtimeSource = providerShimRuntimeSource()
  const metaSource = renderShimMeta(meta)

  const prevShim = existsSync(entryAbs) ? readFileSync(entryAbs, "utf8") : ""
  const prevRuntime = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : ""
  const prevMeta = existsSync(metaPath) ? readFileSync(metaPath, "utf8") : ""

  const changed =
    prevShim !== shimSource ||
    prevRuntime !== runtimeSource ||
    prevMeta !== metaSource ||
    existsSync(backupPath)

  // Always overwrite generated artifacts. The package manager/build output is
  // the only stock source of truth; legacy backups are deleted, never reused.
  writeText(runtimePath, runtimeSource, dryRun)
  writeText(entryAbs, shimSource, dryRun)
  writeText(metaPath, metaSource, dryRun)
  if (!dryRun && existsSync(backupPath)) unlinkSync(backupPath)
  if (
    !dryRun &&
    legacyMetaPath !== metaPath &&
    existsSync(legacyMetaPath)
  ) {
    unlinkSync(legacyMetaPath)
  }

  return {
    packageDir,
    packageName,
    entry: entryRel,
    changed,
  }
}

/** Apply Option B shims under a host plugin install tree. */
export function setupProviderShims(
  options: ProviderShimOptions,
): ProviderShimResult {
  const dir = resolve(options.dir)
  const dirs = discoverProviderPackageDirs(dir, {
    rootOnly: options.rootOnly,
  })
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
          : `  ~ ${t.packageName ?? t.packageDir}: ${t.entry} → instrumented shim`,
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
