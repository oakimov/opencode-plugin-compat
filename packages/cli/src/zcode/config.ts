/**
 * Versioned, strict configuration for the external ZCode bridge.
 *
 * The file is operator-owned: OCP reads it, validates every field and never
 * rewrites it. Secrets are referenced (`{ env }` / `{ file }`), never inlined.
 * Every rejection names the JSON path that caused it, so a typo in one binding
 * is attributable before any route starts.
 */
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { resolveXdgDirs } from "@opencode-compat/profile"

export const ZCODE_BRIDGE_CONFIG_VERSION = 1 as const

export type PluginContract = "classic" | "promise-1.18" | "server-2"
export const PLUGIN_CONTRACTS: readonly PluginContract[] = ["classic", "promise-1.18", "server-2"]

export type CredentialRef = { env: string } | { file: string }

export type ModelAlias = {
  /** The model ID entered in ZCode's Personal model row. */
  alias: string
  /** The upstream model ID passed to `createXxx().languageModel(id)`. */
  upstream: string
}

export type PluginSpec = {
  id: string
  /** npm package name, resolved only inside the OCP install root. */
  package: string
  /** Exact installed version; startup fails on mismatch. */
  version: string
  /** Optional package `exports` subpath (default: the package root). */
  entry?: string
  contract: PluginContract
  factoryExport?: string
  pluginExport?: string
  /** Provider id used for `auth`/`config` hook selection and option keys. */
  providerId?: string
  /** AI-SDK factory options template (`$apiKey` is substituted). */
  options?: Record<string, unknown>
  models: ModelAlias[]
}

export type BindingSpec = {
  id: string
  /** Absolute workspace this binding authorizes. */
  workspace: string
  credentials: { model: CredentialRef; mcp?: CredentialRef }
  plugins: PluginSpec[]
}

export type BridgeLimits = {
  maxBodyBytes: number
  maxConcurrentRequests: number
  /** Upper bound on retained per-session correlation entries. */
  maxSessions: number
}

export type ZcodeBridgeConfig = {
  version: typeof ZCODE_BRIDGE_CONFIG_VERSION
  listen: { host: string; port: number }
  limits: BridgeLimits
  bindings: BindingSpec[]
}

export const DEFAULT_LIMITS: BridgeLimits = {
  maxBodyBytes: 32 * 1024 * 1024,
  maxConcurrentRequests: 16,
  maxSessions: 256,
}

export const DEFAULT_PORT = 18731
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PACKAGE_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

export class ZcodeConfigError extends Error {
  constructor(readonly path: string, message: string) {
    super(`ocp zcode config ${path}: ${message}`)
    this.name = "ZcodeConfigError"
  }
}

export type ZcodePaths = {
  configFile: string
  /** OCP-owned npm install root for consumer plugins. */
  installRoot: string
  /** Private durable state (upstream auth, generated credentials). */
  stateDir: string
  /** Scratch / cache for the bridged plugins (path bridge). */
  cacheDir: string
}

export function zcodePaths(env: NodeJS.ProcessEnv = process.env): ZcodePaths {
  const dirs = resolveXdgDirs("opencode-compat", env)
  return {
    configFile: join(dirs.configDir, "zcode-bridge.json"),
    installRoot: join(dirs.dataDir, "zcode", "plugins"),
    stateDir: join(dirs.dataDir, "zcode", "state"),
    cacheDir: join(dirs.cacheDir, "zcode"),
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strictKeys(value: Json, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ZcodeConfigError(`${path}.${key}`, `unknown field (allowed: ${allowed.join(", ")})`)
  }
}

function requireObject(value: unknown, path: string): Json {
  if (!isObject(value)) throw new ZcodeConfigError(path, "must be an object")
  return value
}

function requireString(value: unknown, path: string, pattern?: RegExp, hint?: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ZcodeConfigError(path, "must be a nonempty string")
  if (pattern && !pattern.test(value)) throw new ZcodeConfigError(path, `invalid value ${JSON.stringify(value)}${hint ? ` (${hint})` : ""}`)
  return value
}

function optionalString(value: unknown, path: string, pattern?: RegExp): string | undefined {
  return value === undefined ? undefined : requireString(value, path, pattern)
}

function requirePositiveInt(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ZcodeConfigError(path, `must be an integer between 1 and ${max}`)
  }
  return value
}

function parseCredentialRef(value: unknown, path: string): CredentialRef {
  const ref = requireObject(value, path)
  strictKeys(ref, path, ["env", "file"])
  const hasEnv = ref.env !== undefined
  const hasFile = ref.file !== undefined
  if (hasEnv === hasFile) throw new ZcodeConfigError(path, "must set exactly one of \"env\" or \"file\"")
  if (hasEnv) return { env: requireString(ref.env, `${path}.env`, ENV_PATTERN, "environment variable name") }
  const file = requireString(ref.file, `${path}.file`)
  if (!isAbsolute(file)) throw new ZcodeConfigError(`${path}.file`, "must be an absolute path")
  return { file }
}

function credentialKey(ref: CredentialRef): string {
  return "env" in ref ? `env:${ref.env}` : `file:${ref.file}`
}

function parseModels(value: unknown, path: string): ModelAlias[] {
  if (!Array.isArray(value) || value.length === 0) throw new ZcodeConfigError(path, "must be a nonempty array")
  return value.map((raw, index) => {
    const itemPath = `${path}[${index}]`
    const item = requireObject(raw, itemPath)
    strictKeys(item, itemPath, ["alias", "upstream"])
    return {
      alias: requireString(item.alias, `${itemPath}.alias`, ALIAS_PATTERN, "letters, digits and ._:/@-"),
      upstream: requireString(item.upstream, `${itemPath}.upstream`),
    }
  })
}

function parsePlugin(value: unknown, path: string): PluginSpec {
  const plugin = requireObject(value, path)
  strictKeys(plugin, path, [
    "id", "package", "version", "entry", "contract", "factoryExport", "pluginExport", "providerId", "options", "models",
  ])
  const contract = requireString(plugin.contract, `${path}.contract`)
  if (!PLUGIN_CONTRACTS.includes(contract as PluginContract)) {
    throw new ZcodeConfigError(`${path}.contract`, `must be one of ${PLUGIN_CONTRACTS.join(", ")}`)
  }
  const entry = optionalString(plugin.entry, `${path}.entry`)
  if (entry !== undefined && !entry.startsWith("./")) throw new ZcodeConfigError(`${path}.entry`, "must be a package exports subpath starting with \"./\"")
  if (plugin.options !== undefined && !isObject(plugin.options)) throw new ZcodeConfigError(`${path}.options`, "must be an object")
  const spec: PluginSpec = {
    id: requireString(plugin.id, `${path}.id`, ID_PATTERN, "lowercase letters, digits and ._-"),
    package: requireString(plugin.package, `${path}.package`, PACKAGE_PATTERN, "an npm package name without a version"),
    version: requireString(plugin.version, `${path}.version`, EXACT_VERSION_PATTERN, "an exact version such as 1.2.3"),
    contract: contract as PluginContract,
    models: parseModels(plugin.models, `${path}.models`),
  }
  if (entry !== undefined) spec.entry = entry
  const factoryExport = optionalString(plugin.factoryExport, `${path}.factoryExport`)
  if (factoryExport !== undefined) spec.factoryExport = factoryExport
  const pluginExport = optionalString(plugin.pluginExport, `${path}.pluginExport`)
  if (pluginExport !== undefined) spec.pluginExport = pluginExport
  const providerId = optionalString(plugin.providerId, `${path}.providerId`)
  if (providerId !== undefined) spec.providerId = providerId
  if (plugin.options !== undefined) spec.options = plugin.options as Record<string, unknown>
  return spec
}

function parseBinding(value: unknown, path: string): BindingSpec {
  const binding = requireObject(value, path)
  strictKeys(binding, path, ["id", "workspace", "credentials", "plugins"])
  const workspace = requireString(binding.workspace, `${path}.workspace`)
  if (!isAbsolute(workspace)) throw new ZcodeConfigError(`${path}.workspace`, "must be an absolute path")
  const credentials = requireObject(binding.credentials, `${path}.credentials`)
  strictKeys(credentials, `${path}.credentials`, ["model", "mcp"])
  const model = parseCredentialRef(credentials.model, `${path}.credentials.model`)
  const mcp = credentials.mcp === undefined ? undefined : parseCredentialRef(credentials.mcp, `${path}.credentials.mcp`)
  if (mcp && credentialKey(mcp) === credentialKey(model)) {
    throw new ZcodeConfigError(`${path}.credentials.mcp`, "must differ from credentials.model (routes use separate scoped credentials)")
  }
  if (!Array.isArray(binding.plugins) || binding.plugins.length === 0) throw new ZcodeConfigError(`${path}.plugins`, "must be a nonempty array")
  const plugins = binding.plugins.map((raw, index) => parsePlugin(raw, `${path}.plugins[${index}]`))

  const pluginIds = new Set<string>()
  const aliases = new Map<string, string>()
  plugins.forEach((plugin, pluginIndex) => {
    if (pluginIds.has(plugin.id)) throw new ZcodeConfigError(`${path}.plugins[${pluginIndex}].id`, `duplicate plugin id "${plugin.id}"`)
    pluginIds.add(plugin.id)
    plugin.models.forEach((model, modelIndex) => {
      const owner = aliases.get(model.alias)
      if (owner !== undefined) {
        throw new ZcodeConfigError(
          `${path}.plugins[${pluginIndex}].models[${modelIndex}].alias`,
          `duplicate model alias "${model.alias}" (already used by plugin "${owner}")`,
        )
      }
      aliases.set(model.alias, plugin.id)
    })
  })

  return { id: requireString(binding.id, `${path}.id`, ID_PATTERN, "lowercase letters, digits and ._-"), workspace, credentials: mcp ? { model, mcp } : { model }, plugins }
}

/** Validate a parsed JSON document. Throws {@link ZcodeConfigError}. */
export function parseZcodeBridgeConfig(raw: unknown): ZcodeBridgeConfig {
  const root = requireObject(raw, "$")
  strictKeys(root, "$", ["$schema", "version", "listen", "limits", "bindings"])
  if (root.version !== ZCODE_BRIDGE_CONFIG_VERSION) {
    throw new ZcodeConfigError("$.version", `must be ${ZCODE_BRIDGE_CONFIG_VERSION} (got ${JSON.stringify(root.version)})`)
  }

  const listenRaw = root.listen === undefined ? {} : requireObject(root.listen, "$.listen")
  strictKeys(listenRaw, "$.listen", ["host", "port"])
  const host = listenRaw.host === undefined ? "127.0.0.1" : requireString(listenRaw.host, "$.listen.host")
  if (!LOOPBACK_HOSTS.has(host)) throw new ZcodeConfigError("$.listen.host", "must be a loopback address (127.0.0.1, ::1 or localhost)")
  const port = listenRaw.port === undefined ? DEFAULT_PORT : requirePositiveInt(listenRaw.port, "$.listen.port", 65_535)

  const limitsRaw = root.limits === undefined ? {} : requireObject(root.limits, "$.limits")
  strictKeys(limitsRaw, "$.limits", ["maxBodyBytes", "maxConcurrentRequests", "maxSessions"])
  const limits: BridgeLimits = {
    maxBodyBytes: limitsRaw.maxBodyBytes === undefined ? DEFAULT_LIMITS.maxBodyBytes : requirePositiveInt(limitsRaw.maxBodyBytes, "$.limits.maxBodyBytes", 512 * 1024 * 1024),
    maxConcurrentRequests: limitsRaw.maxConcurrentRequests === undefined ? DEFAULT_LIMITS.maxConcurrentRequests : requirePositiveInt(limitsRaw.maxConcurrentRequests, "$.limits.maxConcurrentRequests", 1024),
    maxSessions: limitsRaw.maxSessions === undefined ? DEFAULT_LIMITS.maxSessions : requirePositiveInt(limitsRaw.maxSessions, "$.limits.maxSessions", 100_000),
  }

  if (!Array.isArray(root.bindings) || root.bindings.length === 0) throw new ZcodeConfigError("$.bindings", "must be a nonempty array")
  const bindings = root.bindings.map((raw, index) => parseBinding(raw, `$.bindings[${index}]`))

  const bindingIds = new Set<string>()
  const credentialOwners = new Map<string, string>()
  bindings.forEach((binding, index) => {
    if (bindingIds.has(binding.id)) throw new ZcodeConfigError(`$.bindings[${index}].id`, `duplicate binding id "${binding.id}"`)
    bindingIds.add(binding.id)
    for (const [route, ref] of Object.entries(binding.credentials)) {
      if (!ref) continue
      const key = credentialKey(ref)
      const owner = credentialOwners.get(key)
      if (owner !== undefined) {
        throw new ZcodeConfigError(`$.bindings[${index}].credentials.${route}`, `credential reference is already used by ${owner}`)
      }
      credentialOwners.set(key, `binding "${binding.id}" (${route})`)
    }
  })

  return { version: ZCODE_BRIDGE_CONFIG_VERSION, listen: { host, port }, limits, bindings }
}

export function loadZcodeBridgeConfig(file: string): ZcodeBridgeConfig {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    throw new ZcodeConfigError("$", `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ZcodeConfigError("$", `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseZcodeBridgeConfig(parsed)
}
