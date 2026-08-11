/**
 * Config-file-driven registration. The shipped extension entry has no built-in
 * provider: which OpenCode plugin(s) to bridge is user configuration, mirroring
 * OCP's principle that host/plugin specifics are data, never code baked into
 * the compat layer.
 *
 * A provider entry is normally just `{"package": "<npm-name>"}` — everything
 * else is discovered from the plugin's own OpenCode hooks (see `register.ts`).
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { registerOpenCodePlugin, type OpenCodePluginSpec } from "./register.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

export type PiBridgeConfig = {
  providers: OpenCodePluginSpec[]
}

/**
 * Search order: `$PI_BRIDGE_CONFIG`, then each host's agent dir. Both hosts are
 * probed by path (rather than requiring host detection here) so a single config
 * file works regardless of which one is running.
 */
export function configSearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.PI_BRIDGE_CONFIG) return [env.PI_BRIDGE_CONFIG]
  const home = env.HOME || env.USERPROFILE || homedir()
  const agentDirs = [
    env.PI_CODING_AGENT_DIR,
    path.join(home, ".omp", "agent"),
    path.join(home, ".pi", "agent"),
    path.join(home, ".pi"),
  ].filter((dir): dir is string => Boolean(dir))
  return agentDirs.map(dir => path.join(dir, "pi-bridge.json"))
}

/** First existing config path, or undefined. */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return configSearchPaths(env).find(candidate => existsSync(candidate))
}

function isProviderSpec(value: unknown): value is OpenCodePluginSpec {
  if (typeof value !== "object" || value === null) return false
  const spec = value as Record<string, unknown>
  // `packageSpecifier` accepted as an alias so earlier configs keep working.
  return typeof spec.package === "string" || typeof spec.packageSpecifier === "string"
}

function normalizeSpec(value: OpenCodePluginSpec & { packageSpecifier?: string }): OpenCodePluginSpec {
  if (!value.package && value.packageSpecifier) {
    const { packageSpecifier, ...rest } = value
    return { ...rest, package: packageSpecifier }
  }
  return value
}

/** Read and validate the config file. Returns `undefined` when it doesn't exist. */
export function loadConfig(configPath: string): PiBridgeConfig | undefined {
  if (!existsSync(configPath)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
  const providers = (parsed as { providers?: unknown }).providers
  if (!Array.isArray(providers) || !providers.every(isProviderSpec)) {
    throw new Error(`pi-bridge config at ${configPath}: "providers" must be an array of {"package": "<name>", ...}`)
  }
  return { providers: providers.map(normalizeSpec) }
}

/**
 * Register every configured provider, isolating failures per entry — a host's
 * extension loader treats a thrown extension factory as a total load failure,
 * so one bad entry must not take down the others.
 */
export async function registerProvidersFromConfig(pi: PiExtensionApi, config: PiBridgeConfig): Promise<void> {
  for (const spec of config.providers) {
    try {
      await registerOpenCodePlugin(pi, spec)
    } catch (err) {
      const label = spec.providerName ?? spec.package
      console.error(`pi-bridge: failed to register provider "${label}" — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
