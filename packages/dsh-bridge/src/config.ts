/**
 * Cordis `cordis.patch.yml` driven registration — DSH yml way.
 * No `dsh-bridge.json` file search (unlike `packages/pi-bridge/src/config.ts`).
 * Config is the `config` field of the Cordis patch entry:
 *   `config: { providers: OpenCodePluginSpec[] }`
 */
export type OpenCodePluginSpec = {
  package: string
  factoryExport?: string
  pluginExport?: string
  providerName?: string
  api?: string
  baseUrl?: string
  apiKey?: string
  createOptions?: Record<string, unknown>
  disableOAuth?: boolean
  preferAuthMethod?: "oauth" | "api"
  models?: unknown[]
  directory?: string
  splitDimensions?: readonly string[]
}

export type DshBridgeConfig = {
  providers: OpenCodePluginSpec[]
}

/** Drop a trailing npm version suffix without changing scoped names or paths. */
export function stripTrailingNpmVersion(raw: string): string {
  const at = raw.lastIndexOf("@")
  if (at <= 0) return raw
  const after = raw.slice(at + 1)
  if (!after || after.includes("/")) return raw
  return raw.slice(0, at)
}

/** Provider-specific Cursor behavior is enabled only by the package identity. */
export function isCursorProviderPackage(raw: string): boolean {
  const packageName = stripTrailingNpmVersion(raw.toLowerCase())
  return packageName === "cursor-opencode-provider"
    || packageName.startsWith("cursor-opencode-provider/")
    || packageName.includes("/cursor-opencode-provider/")
    || packageName.endsWith("/cursor-opencode-provider")
}

export function validateConfig(raw: unknown): DshBridgeConfig {
  const providers = (raw as { providers?: unknown })?.providers
  if (!Array.isArray(providers)) {
    throw new Error(`dsh-bridge config: "providers" must be an array`)
  }
  for (const p of providers) {
    if (typeof p !== "object" || p === null || !("package" in (p as Record<string, unknown>))) {
      throw new Error(`dsh-bridge config: each provider needs {"package": "<name>"}`)
    }
    const pkg = (p as Record<string, unknown>).package
    if (typeof pkg !== "string" || pkg.length === 0) {
      throw new Error(`dsh-bridge config: provider "package" must be non-empty string`)
    }
  }
  return { providers: providers as OpenCodePluginSpec[] }
}
