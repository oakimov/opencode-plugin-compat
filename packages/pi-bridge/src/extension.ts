/**
 * Default extension entry point, registered by both hosts' manifests
 * (`package.json#omp.extensions` / `#pi.extensions`). Registers whatever
 * OpenCode plugin(s) the user configured — see `config.ts`. No provider is
 * registered when no config file exists.
 */
import { loadConfig, registerProvidersFromConfig, resolveConfigPath } from "./config.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

export default async function piBridgeExtension(pi: PiExtensionApi): Promise<void> {
  const configPath = resolveConfigPath()
  if (!configPath) return
  const config = loadConfig(configPath)
  if (config) await registerProvidersFromConfig(pi, config)
}
