/**
 * Default extension entry point, registered by both hosts' manifests
 * (`package.json#omp.extensions` / `#pi.extensions`). Registers whatever
 * OpenCode plugin(s) the user configured — see `config.ts`. No provider is
 * registered when no config file exists.
 */
import { loadConfig, registerProvidersFromConfig, resolveConfigPath } from "./config.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

/**
 * Pi registers all built-in tools in its tool registry but starts with only
 * read/bash/edit/write active. OpenCode providers expect the read-only search
 * tools too (`glob`, `grep`, and `ls`), so activate their host equivalents once the
 * session runtime has been initialized. The host's configured tool allowlist
 * remains authoritative: a tool absent from getAllTools() is not enabled.
 */
export function activateOpenCodeSearchTools(pi: PiExtensionApi): void {
  if (!pi.on || !pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return

  pi.on("session_start", async () => {
    const available = new Set(
      pi.getAllTools!().map(tool => typeof tool === "string" ? tool : tool.name),
    )
    const additionalBuiltinTools = ["find", "grep", "ls"].filter(name => available.has(name))
    if (additionalBuiltinTools.length === 0) return

    const active = pi.getActiveTools!()
    const next = [...new Set([...active, ...additionalBuiltinTools])]
    if (next.length === active.length && next.every((name, index) => name === active[index])) return
    await pi.setActiveTools!(next)
  })
}

export default async function piBridgeExtension(pi: PiExtensionApi): Promise<void> {
  const configPath = resolveConfigPath()
  if (!configPath) return
  const config = loadConfig(configPath)
  if (config) {
    activateOpenCodeSearchTools(pi)
    await registerProvidersFromConfig(pi, config)
  }
}
