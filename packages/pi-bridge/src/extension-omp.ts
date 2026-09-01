/** OMP's manifest-selected entrypoint avoids ambiguous dev-checkout package probes. */
import piBridgeExtension from "./extension.js"
import { loadHostRuntimeModuleThroughHost } from "./host-module-loader.js"
import { installPiRuntimeModule } from "./host/runtime.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

process.env.PI_BRIDGE_HOST ??= "omp"

export default async function ompPiBridgeExtension(pi: PiExtensionApi): Promise<void> {
  const hostAi = await loadHostRuntimeModuleThroughHost(pi, "@oh-my-pi/pi-ai")
  if (hostAi) installPiRuntimeModule("omp", hostAi)
  await piBridgeExtension(pi)
}
