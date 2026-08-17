import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deletePath, getNode, parseJsonc, pushPath, setPath, toValue } from "./jsonc.ts"
import { fileMode, readText, writeAtomic } from "./paths.ts"

function installedPackageName(specifier: string, pluginName: string): string | undefined {
  if (specifier === pluginName) return pluginName
  let candidate: string
  try {
    candidate = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier
  } catch {
    return undefined
  }
  if (!candidate.startsWith("/")) return undefined
  candidate = resolve(candidate)
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const name = (JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string }).name
      if (name) return name
    } catch {
      // keep walking up
    }
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return undefined
}

function matchingIndexes(providers: unknown[], pluginName: string): number[] {
  const matching: number[] = []
  providers.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return
    const record = entry as { package?: unknown; packageSpecifier?: unknown }
    const current = typeof record.package === "string" ? record.package
      : typeof record.packageSpecifier === "string" ? record.packageSpecifier
      : undefined
    if (typeof current === "string" && installedPackageName(current, pluginName) === pluginName) {
      matching.push(index)
    }
  })
  return matching
}

export function upsertPiProvider(configPath: string, packageSpecifier: string, pluginName: string): void {
  const created = !existsSync(configPath)
  let text = readText(configPath) ?? ""
  const mode = fileMode(configPath) ?? (created ? 0o600 : undefined)
  if (!text.trim()) text = "{}\n"
  const root = parseJsonc(text)
  if (root.type !== "object") throw new Error(`${configPath} is not a JSON object`)
  const providersNode = getNode(root, ["providers"])
  if (providersNode && providersNode.type !== "array") {
    throw new Error(`${configPath} has a non-array "providers" field`)
  }
  const providers = (providersNode ? toValue(providersNode) : []) as unknown[]
  const matching = matchingIndexes(providers, pluginName)
  if (matching.length === 0) {
    text = pushPath(text, ["providers"], { package: packageSpecifier })
  } else {
    const first = matching[0]!
    text = setPath(text, ["providers", first, "package"], packageSpecifier)
    text = deletePath(text, ["providers", first, "packageSpecifier"])
    for (let i = matching.length - 1; i >= 1; i -= 1) {
      text = deletePath(text, ["providers", matching[i]!])
    }
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeAtomic(configPath, text.endsWith("\n") ? text : `${text}\n`, mode)
}

export function removePiProvider(configPath: string, pluginName: string): void {
  if (!existsSync(configPath)) return
  let text = readText(configPath)
  if (text === undefined) return
  const mode = fileMode(configPath)
  const root = parseJsonc(text)
  if (root.type !== "object") return
  const providersNode = getNode(root, ["providers"])
  if (!providersNode || providersNode.type !== "array") return
  const providers = toValue(providersNode) as unknown[]
  const matching = matchingIndexes(providers, pluginName)
  for (let i = matching.length - 1; i >= 0; i -= 1) {
    text = deletePath(text, ["providers", matching[i]!])
  }
  writeAtomic(configPath, text.endsWith("\n") ? text : `${text}\n`, mode)
}
