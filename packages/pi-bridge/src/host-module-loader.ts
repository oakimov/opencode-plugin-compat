import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { PiExtensionApi } from "./pi-provider-types.js"

const MODULE_STORE = Symbol.for("opencode.compat.pi-bridge.module-store")

type ModuleStore = Map<string, Record<string, unknown>>

function moduleStore(): ModuleStore {
  const globals = globalThis as typeof globalThis & { [MODULE_STORE]?: ModuleStore }
  return globals[MODULE_STORE] ??= new Map()
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const slash = specifier.indexOf("/")
    if (slash < 0) return specifier
    const versionAt = specifier.indexOf("@", slash)
    return versionAt < 0 ? specifier : specifier.slice(0, versionAt)
  }
  const versionAt = specifier.lastIndexOf("@")
  return versionAt > 0 ? specifier.slice(0, versionAt) : specifier
}

function packageEntry(root: string): string {
  const manifestPath = join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    main?: string
    module?: string
    exports?: string | { "."?: string | { import?: string; default?: string } }
  }
  const rootExport = typeof manifest.exports === "object" ? manifest.exports["."] : manifest.exports
  const exported = typeof rootExport === "string" ? rootExport : rootExport?.import ?? rootExport?.default
  const entry = exported ?? manifest.module ?? manifest.main ?? "dist/index.js"
  const resolved = resolve(root, entry)
  if (!existsSync(resolved)) throw new Error(`pi-bridge: package entry does not exist: ${resolved}`)
  return resolved
}

function pluginNodeModuleDirs(pi: PiExtensionApi): string[] {
  const dirs: string[] = []
  const pluginsDir = pi.pi?.getPluginsDir?.()
  if (pluginsDir) dirs.push(join(pluginsDir, "node_modules"))
  const home = homedir()
  const omp = join(home, ".omp", "plugins", "node_modules")
  const piNpm = join(home, ".pi", "agent", "npm", "node_modules")
  const host = process.env.PI_BRIDGE_HOST?.trim()
  if (host === "pi") dirs.push(piNpm, omp)
  else dirs.push(omp, piNpm)
  return [...new Set(dirs.filter(dir => existsSync(dir)))]
}

function resolveModuleEntry(pi: PiExtensionApi, specifier: string, cwd: string): string {
  const candidates: string[] = []
  if (specifier.startsWith("file:")) candidates.push(fileURLToPath(specifier))
  else if (isAbsolute(specifier)) candidates.push(specifier)
  else if (specifier.startsWith("./") || specifier.startsWith("../")) candidates.push(resolve(cwd, specifier))
  else {
    const name = packageName(specifier)
    for (const dir of pluginNodeModuleDirs(pi)) candidates.push(join(dir, name))
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    return statSync(candidate).isDirectory() ? packageEntry(candidate) : candidate
  }
  throw new Error(`pi-bridge: provider package is not installed: ${specifier}`)
}

function relativeImport(fromDir: string, target: string): string {
  const specifier = relative(fromDir, target).split(sep).join("/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

async function loadStaticSpecifierThroughHost(
  pi: PiExtensionApi,
  literalSpecifier: string | ((trampolineDir: string) => string),
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  const loadExtensions = pi.pi?.loadExtensions
  if (!loadExtensions) return undefined

  // OMP realpaths extension entries before graph collection. Compute the
  // relative edge from that same canonical directory (macOS maps /var to
  // /private/var), otherwise the generated import points one level too high.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocp-pi-provider-")))
  const trampoline = join(dir, "load.mjs")
  const importSpecifier = typeof literalSpecifier === "function" ? literalSpecifier(dir) : literalSpecifier
  const requestId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const store = moduleStore()
  writeFileSync(
    trampoline,
    `import * as moduleExports from ${JSON.stringify(importSpecifier)};\n` +
      `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(MODULE_STORE)!)})].set(${JSON.stringify(requestId)}, moduleExports);\n` +
      "export default function () {}\n",
  )

  try {
    const result = await loadExtensions([trampoline], cwd)
    const error = result.errors?.[0]
    if (error) throw new Error(`pi-bridge: host module load failed: ${error.error}`)
    const loaded = store.get(requestId)
    if (!loaded) throw new Error("pi-bridge: host loaded provider without returning its module exports")
    return loaded
  } finally {
    store.delete(requestId)
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Load a provider through the host's public extension loader. The generated
 * module contains a literal relative import, putting the provider and all of
 * its transitive dependencies inside OMP's statically collected Bun graph.
 */
export function loadModuleThroughHost(
  pi: PiExtensionApi,
  specifier: string,
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  // Pi has no OMP-style loadExtensions. Fall through to a normal import —
  // pi's jiti virtualModules already bind host packages.
  if (!pi.pi?.loadExtensions) return Promise.resolve(undefined)
  let entry: string
  try {
    entry = resolveModuleEntry(pi, specifier, cwd)
  } catch {
    return Promise.resolve(undefined)
  }
  return loadStaticSpecifierThroughHost(pi, dir => relativeImport(dir, entry), cwd)
}

/** Load an injected host package while keeping the optional import lazy. */
export function loadHostRuntimeModuleThroughHost(
  pi: PiExtensionApi,
  packageSpecifier: string,
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  return loadStaticSpecifierThroughHost(pi, packageSpecifier, cwd)
}
