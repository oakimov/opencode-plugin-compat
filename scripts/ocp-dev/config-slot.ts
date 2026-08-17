import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { deletePath, getNode, parseJsonc, setPath, toValue } from "./jsonc.ts"
import { fileMode, ocpVersion, readText, writeAtomic } from "./paths.ts"

export type CloneManifest = {
  host: string
  mode: "local" | "npm"
  ocpVersion: string | null
  updated: string
  stockProvider: string
  wrapperDir: string | null
  createdConfig: boolean
  config: {
    path: string
    pluginAdded: string
    providerNpmBefore: string | null
    stockPluginEntriesBefore: string[]
  }
}

function pluginsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value === "string" && value) return [value]
  return []
}

function isStockPluginEntry(entry: string, stockRoot: string): boolean {
  let path = entry
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return false
    }
  }
  if (!path.startsWith("/")) return false
  const resolved = resolve(path)
  return resolved === stockRoot || resolved.startsWith(`${stockRoot}/`)
}

export function applyCloneSlot(input: {
  configPath: string
  manifestPath: string
  host: string
  mode: "local" | "npm"
  pluginEntry: string
  providerNpm: string
  stock: string
  wrapper: string
}): CloneManifest {
  const createdConfig = !existsSync(input.configPath)
  const previous = existsSync(input.manifestPath)
    ? (JSON.parse(readText(input.manifestPath) ?? "null") as CloneManifest | null)
    : null
  let text = readText(input.configPath) ?? ""
  const mode = fileMode(input.configPath)
  if (!text.trim()) text = "{}\n"

  const root = parseJsonc(text)
  if (root.type !== "object") throw new Error(`${input.configPath} is not a JSON object`)
  const data = toValue(root) as Record<string, unknown>
  const stockRoot = resolve(input.stock)
  const priorEntry = previous?.config.pluginAdded
  const before = pluginsOf(data.plugin)
  const stockNow = before.filter(
    (entry) => isStockPluginEntry(entry, stockRoot) && entry !== priorEntry && entry !== input.pluginEntry,
  )
  const stockPluginEntriesBefore = previous?.config.stockPluginEntriesBefore ?? stockNow
  const next = before.filter(
    (entry) => entry !== priorEntry && entry !== input.pluginEntry && !isStockPluginEntry(entry, stockRoot),
  )
  next.push(input.pluginEntry)

  const existingNpm = (data.provider as { cursor?: { npm?: unknown } } | undefined)?.cursor?.npm
  const providerNpmBefore = previous
    ? previous.config.providerNpmBefore
    : (typeof existingNpm === "string" ? existingNpm : null)

  text = setPath(text, ["plugin"], next)
  if (input.providerNpm) text = setPath(text, ["provider", "cursor", "npm"], input.providerNpm)

  mkdirSync(dirname(input.configPath), { recursive: true })
  writeAtomic(input.configPath, text.endsWith("\n") ? text : `${text}\n`, mode ?? (createdConfig ? 0o644 : undefined))

  const manifest: CloneManifest = {
    host: input.host,
    mode: input.mode,
    ocpVersion: ocpVersion(),
    updated: new Date().toISOString(),
    stockProvider: input.stock,
    wrapperDir: input.wrapper || null,
    createdConfig,
    config: {
      path: input.configPath,
      pluginAdded: input.pluginEntry,
      providerNpmBefore,
      stockPluginEntriesBefore,
    },
  }
  writeAtomic(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function revertCloneSlot(manifest: CloneManifest): void {
  const configPath = manifest.config.path
  if (!existsSync(configPath)) return
  let text = readText(configPath)
  if (text === undefined) return
  const mode = fileMode(configPath)
  const root = parseJsonc(text)
  if (root.type !== "object") throw new Error(`${configPath} is not a JSON object`)

  const before = pluginsOf((toValue(root) as { plugin?: unknown }).plugin)
  const after = before.filter((entry) => entry !== manifest.config.pluginAdded)
  for (const entry of manifest.config.stockPluginEntriesBefore) {
    if (typeof entry === "string" && entry && !after.includes(entry)) after.push(entry)
  }
  if (after.length > 0) text = setPath(text, ["plugin"], after)
  else text = deletePath(text, ["plugin"])

  if (manifest.config.providerNpmBefore !== null) {
    text = setPath(text, ["provider", "cursor", "npm"], manifest.config.providerNpmBefore)
  } else {
    text = deletePath(text, ["provider", "cursor", "npm"])
    const cursor = getNode(parseJsonc(text), ["provider", "cursor"])
    if (cursor?.type === "object" && cursor.properties.length === 0) text = deletePath(text, ["provider", "cursor"])
    const provider = getNode(parseJsonc(text), ["provider"])
    if (provider?.type === "object" && provider.properties.length === 0) text = deletePath(text, ["provider"])
  }

  const parsed = parseJsonc(text)
  const empty = parsed.type === "object" && parsed.properties.length === 0
  if (manifest.createdConfig && empty) {
    unlinkSync(configPath)
    return
  }
  writeAtomic(configPath, text.endsWith("\n") ? text : `${text}\n`, mode)
}
