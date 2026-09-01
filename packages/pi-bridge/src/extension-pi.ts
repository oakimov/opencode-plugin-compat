/** Pi's manifest-selected entrypoint avoids ambiguous dev-checkout package probes. */
import * as hostAi from "@earendil-works/pi-ai"
import piBridgeExtension from "./extension.js"
import { installPiRuntimeModule } from "./host/runtime.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

process.env.PI_BRIDGE_HOST ??= "pi"

export default async function piFamilyBridgeExtension(pi: PiExtensionApi): Promise<void> {
  // Static specifier so pi's jiti virtualModules bind in-process `@earendil-works/pi-ai`
  // when it loads this entry. A computed import() from runtime.js misses that table.
  installPiRuntimeModule("pi", hostAi as Record<string, unknown>)
  await piBridgeExtension(pi)
}
