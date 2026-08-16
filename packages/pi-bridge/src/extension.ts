/**
 * Default extension entry point, registered by both hosts' manifests
 * (`package.json#omp.extensions` / `#pi.extensions`). Registers whatever
 * OpenCode plugin(s) the user configured — see `config.ts`. No provider is
 * registered when no config file exists.
 */
import { loadConfig, registerProvidersFromConfig, resolveConfigPath } from "./config.js"
import { activateCursorHostTools, registerCursorHostTools } from "./cursor-host-tools.js"
import { detectPiHost } from "./host/detect.js"
import type { PiHostId } from "./host/profile.js"
import { installPiPathBridge } from "./path-bridge.js"
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

function resolveHostIdForTools(detected?: PiHostId): PiHostId | undefined {
  if (detected) return detected
  const forced = process.env.PI_BRIDGE_HOST?.trim()
  if (forced === "omp" || forced === "pi") return forced
  return undefined
}

/**
 * Advertise Cursor bridge tools when the Cursor provider is among the configured
 * plugins (or when tests force registration). omp gets plan_enter/plan_exit;
 * both hosts get cursor_image_save.
 */
export function maybeRegisterCursorHostTools(
  pi: PiExtensionApi,
  hostId: PiHostId,
  config: { providers?: Array<{ package?: string; providerName?: string }> } | null | undefined,
): string[] {
  const mentionsCursor = (config?.providers ?? []).some(entry => {
    const needle = `${entry.package ?? ""} ${entry.providerName ?? ""}`.toLowerCase()
    return needle.includes("cursor-opencode-provider") || needle.includes("cursor")
  })
  // Staging lives in-process with the bridged provider — only advertise when
  // Cursor is configured (or tests force registration via env).
  if (!mentionsCursor && process.env.PI_BRIDGE_CURSOR_HOST_TOOLS !== "1") return []
  const names = registerCursorHostTools(pi, { hostId, hostPi: pi.pi })
  activateCursorHostTools(pi, names)
  return names
}

export default async function piBridgeExtension(pi: PiExtensionApi): Promise<void> {
  // Path bridge must land even when no provider config exists yet — CreatePlan /
  // skill discovery still need `.omp` / `.pi` rather than a invented `.opencode`.
  // Prefer env override when detection cannot probe a host package (tests / odd loads).
  let hostId: PiHostId | undefined
  try {
    const { profile } = await detectPiHost()
    hostId = profile.id
    installPiPathBridge(profile.id)
  } catch (err) {
    const forced = process.env.PI_BRIDGE_HOST?.trim()
    if (forced === "omp" || forced === "pi") {
      hostId = forced
      installPiPathBridge(forced)
    } else {
      console.error(
        `pi-bridge: path bridge not installed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const configPath = resolveConfigPath()
  if (!configPath) return
  const config = loadConfig(configPath)
  if (config) {
    activateOpenCodeSearchTools(pi)
    const resolvedHost = resolveHostIdForTools(hostId)
    if (resolvedHost) {
      maybeRegisterCursorHostTools(pi, resolvedHost, config)
    }
    await registerProvidersFromConfig(pi, config)
  }
}
