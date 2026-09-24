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

/** The exact root entry chosen for a configured provider installation. */
export function resolveProviderRootEntry(
  pi: PiExtensionApi,
  providerSpecifier: string,
  cwd = process.cwd(),
): string | undefined {
  try {
    return realpathSync(resolveModuleEntry(pi, providerSpecifier, cwd))
  } catch {
    return undefined
  }
}

function relativeImport(fromDir: string, target: string): string {
  const specifier = relative(fromDir, target).split(sep).join("/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

async function loadStaticSpecifiersThroughHost(
  pi: PiExtensionApi,
  literalSpecifiers: Record<string, string | ((trampolineDir: string) => string)>,
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  const loadExtensions = pi.pi?.loadExtensions
  if (!loadExtensions) return undefined

  // OMP realpaths extension entries before graph collection. Compute the
  // relative edge from that same canonical directory (macOS maps /var to
  // /private/var), otherwise the generated import points one level too high.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocp-pi-provider-")))
  const trampoline = join(dir, "load.mjs")
  const imports = Object.entries(literalSpecifiers).map(([name, specifier], index) => {
    const value = typeof specifier === "function" ? specifier(dir) : specifier
    return { name, binding: `module${index}`, value }
  })
  const requestId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const store = moduleStore()
  writeFileSync(
    trampoline,
    imports.map(item => `import * as ${item.binding} from ${JSON.stringify(item.value)};\n`).join("") +
      `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(MODULE_STORE)!)})].set(${JSON.stringify(requestId)}, {${imports.map(item => `${JSON.stringify(item.name)}: ${item.binding}`).join(", ")}});\n` +
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

async function loadStaticSpecifierThroughHost(
  pi: PiExtensionApi,
  literalSpecifier: string | ((trampolineDir: string) => string),
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  const modules = await loadStaticSpecifiersThroughHost(pi, { root: literalSpecifier }, cwd)
  return modules?.root as Record<string, unknown> | undefined
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

/** Resolve a sibling export from the exact provider installation used for its root entry. */
export function resolveProviderSubpathEntry(
  pi: PiExtensionApi,
  providerSpecifier: string,
  subpath: string,
  cwd = process.cwd(),
): string | undefined {
  const entry = resolveProviderRootEntry(pi, providerSpecifier, cwd)
  if (!entry) return undefined
  let directory = resolve(entry, "..")
  while (true) {
    const manifestPath = join(directory, "package.json")
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        exports?: Record<string, string | { import?: string; default?: string }>
      }
      const exported = manifest.exports?.[subpath]
      const target = typeof exported === "string" ? exported : exported?.import ?? exported?.default
      if (!target?.startsWith("./")) return undefined
      const resolved = resolve(directory, target)
      return relative(directory, resolved).startsWith("..") || !existsSync(resolved)
        ? undefined
        : resolved
    }
    const parent = resolve(directory, "..")
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Import root and sibling export in one host graph so shared module state stays shared. */
export async function loadProviderWithSubpathThroughHost(
  pi: PiExtensionApi,
  providerSpecifier: string,
  subpath: string,
  cwd = process.cwd(),
): Promise<{ root: Record<string, unknown>; subpath: Record<string, unknown> } | undefined> {
  if (!pi.pi?.loadExtensions) return undefined
  const subpathEntry = resolveProviderSubpathEntry(pi, providerSpecifier, subpath, cwd)
  if (!subpathEntry) return undefined
  const rootEntry = resolveProviderRootEntry(pi, providerSpecifier, cwd)
  if (!rootEntry) return undefined
  const modules = await loadStaticSpecifiersThroughHost(pi, {
    root: dir => relativeImport(dir, rootEntry),
    subpath: dir => relativeImport(dir, subpathEntry),
  }, cwd)
  if (!modules?.root || !modules.subpath) return undefined
  return {
    root: modules.root as Record<string, unknown>,
    subpath: modules.subpath as Record<string, unknown>,
  }
}

/** Load an injected host package while keeping the optional import lazy. */
export function loadHostRuntimeModuleThroughHost(
  pi: PiExtensionApi,
  packageSpecifier: string,
  cwd = process.cwd(),
): Promise<Record<string, unknown> | undefined> {
  return loadStaticSpecifierThroughHost(pi, packageSpecifier, cwd)
}
