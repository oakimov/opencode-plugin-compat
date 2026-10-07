/** Pi's manifest-selected entrypoint avoids ambiguous dev-checkout package probes. */
import * as hostAi from "@earendil-works/pi-ai"
import * as hostCodingAgent from "@earendil-works/pi-coding-agent"
import * as hostTui from "@earendil-works/pi-tui"
import piBridgeExtension from "./extension.js"
import { installPiRuntimeModule } from "./host/runtime.js"
import { installPiHostAgentDir } from "./path-bridge.js"
import { installPiPlanRenderModules } from "./pi-plan-render.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

process.env.PI_BRIDGE_HOST ??= "pi"

export default async function piFamilyBridgeExtension(pi: PiExtensionApi): Promise<void> {
  // Static specifiers so pi's jiti virtualModules bind the in-process host
  // packages when it loads this entry. A computed import() from runtime.js
  // misses that table.
  installPiRuntimeModule("pi", hostAi as Record<string, unknown>)
  const codingAgent = hostCodingAgent as Record<string, unknown>
  if (typeof codingAgent.getAgentDir === "function") {
    installPiHostAgentDir("pi", codingAgent.getAgentDir as () => string)
  }
  installPiPlanRenderModules(hostTui as Record<string, unknown>, codingAgent)
  await piBridgeExtension(pi)
}
