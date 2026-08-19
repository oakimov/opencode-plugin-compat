/**
 * Default extension entry point, registered by both hosts' manifests
 * (`package.json#omp.extensions` / `#pi.extensions`). Registers whatever
 * OpenCode plugin(s) the user configured — see `config.ts`. No provider is
 * registered when no config file exists.
 */
import { loadConfig, registerProvidersFromConfig, resolveConfigPath } from "./config.js"
import { detectPiHost } from "./host/detect.js"
import type { PiHostId } from "./host/profile.js"
import { installPiPathBridge } from "./path-bridge.js"
import type { HostEditTool } from "./hashline-tool.js"
import { resetHashlineCoalesce } from "./hashline-coalesce.js"
import { resetHashlineOverlapClaims } from "./hashline-overlap.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

/**
 * Pi registers all built-in tools in its tool registry but starts with only
 * read/bash/edit/write active. OpenCode providers expect the read-only search
 * tools too (`glob`, `grep`, and `ls`), so activate their host equivalents once the
 * session runtime has been initialized. The host's configured tool allowlist
 * remains authoritative: a tool absent from getAllTools() is not enabled.
 */
export function activateOpenCodeSearchTools(pi: PiExtensionApi): void {
  if (!pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return

  const apply = async () => {
    const available = new Set(
      pi.getAllTools!().map(tool => typeof tool === "string" ? tool : tool.name),
    )
    const additionalBuiltinTools = ["find", "grep", "ls"].filter(name => available.has(name))
    if (additionalBuiltinTools.length === 0) return

    const active = pi.getActiveTools!()
    const next = [...new Set([...active, ...additionalBuiltinTools])]
    if (next.length === active.length && next.every((name, index) => name === active[index])) return
    await pi.setActiveTools!(next)
  }

  pi.on?.("session_start", apply)
}

function resolveHostIdForTools(detected?: PiHostId): PiHostId | undefined {
  if (detected) return detected
  const forced = process.env.PI_BRIDGE_HOST?.trim()
  if (forced === "omp" || forced === "pi") return forced
  return undefined
}

/**
 * Drop a trailing npm version suffix (`name@1.2.3`, `@scope/pkg@1.2.3`) without
 * regex — CodeQL flags `/@[^/]+$/` as polynomial ReDoS on hostile `@…` input.
 * Leaves bare scoped names (`@scope/pkg`) and path segments that contain `@`
 * before a `/` unchanged.
 */
export function stripTrailingNpmVersion(raw: string): string {
  const at = raw.lastIndexOf("@")
  if (at <= 0) return raw
  const after = raw.slice(at + 1)
  if (!after || after.includes("/")) return raw
  return raw.slice(0, at)
}

/**
 * Advertise Cursor bridge tools when the Cursor provider is among the configured
 * plugins (or when tests force registration). omp gets plan_enter/plan_exit;
 * both hosts get cursor_image_save.
 */
export async function maybeRegisterCursorHostTools(
  pi: PiExtensionApi,
  hostId: PiHostId,
  config: { providers?: Array<{ package?: string; providerName?: string }> } | null | undefined,
): Promise<string[]> {
  const mentionsCursor = (config?.providers ?? []).some(entry => {
    const raw = (entry.package ?? "").toLowerCase()
    // Accept npm version suffixes (`cursor-opencode-provider@1.2.3`) and path/
    // `file://` locations ending in the provider directory.
    const packageName = stripTrailingNpmVersion(raw)
    return packageName === "cursor-opencode-provider"
      || packageName.startsWith("cursor-opencode-provider/")
      || packageName.includes("/cursor-opencode-provider/")
      || packageName.endsWith("/cursor-opencode-provider")
  })
  // Staging lives in-process with the bridged provider — only advertise when
  // Cursor is configured (or tests force registration via env). The Cursor host
  // tool module stays a dynamic import so generic Pi loads never parse it.
  if (!mentionsCursor && process.env.PI_BRIDGE_CURSOR_HOST_TOOLS !== "1") return []
  const { activateCursorHostTools, registerCursorHostTools } = await import("./cursor-host-tools.js")
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
    if (resolvedHost === "omp") {
      const { activateHashlineTool, registerHashlineTool } = await import("./hashline-tool.js")
      const { openCodeEditToolActivator, registerOpenCodeEditTool } = await import("./edit-replace-tool.js")
      const { bindOmpPlanModeHost } = await import("./plan-mode-host.js")
      let nativeEdit: HostEditTool | undefined
      const resolveEdit = async (): Promise<HostEditTool | undefined> => {
        if (nativeEdit) return nativeEdit
        const host = await bindOmpPlanModeHost({ hostPi: pi.pi })
        const tool = host?.getSession()?.getToolByName?.("edit")
        if (tool && typeof tool.execute === "function") nativeEdit = tool as HostEditTool
        return nativeEdit
      }
      activateHashlineTool(pi, registerHashlineTool(pi, { resolveEdit, hostPi: pi.pi }))
      const activateEdit = openCodeEditToolActivator(pi, registerOpenCodeEditTool(pi, { hostPi: pi.pi }))
      const installReplaceEdit = async () => {
        // Overlap claims and the minted-tag registry are session-scoped: the
        // host's snapshot store lives on the session, so a brand-new session has
        // an empty store and tags from the previous one genuinely are "not from
        // this session".
        resetHashlineOverlapClaims()
        resetHashlineCoalesce()
        nativeEdit = undefined
        await resolveEdit()
        await activateEdit()
      }
      pi.on?.("session_start", installReplaceEdit)
    }
    if (resolvedHost) {
      await maybeRegisterCursorHostTools(pi, resolvedHost, config)
    }
    await registerProvidersFromConfig(pi, config)
  }
}
