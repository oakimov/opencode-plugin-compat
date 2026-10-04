/** Select optional integrations by package identity, outside the generic adapter. */
import { providerPackageMatches } from "@opencode-compat/opencode-loader"
import { projectDevinFinish } from "./devin-usage"
import { usageIntegrationForHost } from "./usage-reconciliation"
import type { ProviderUsageIntegration } from "./language-model"

export function providerUsageIntegrationForHost(host: string,
  env: Record<string, string | undefined> = process.env, packageName?: string): ProviderUsageIntegration | undefined {
  const integration = usageIntegrationForHost(host, env)
  if (!integration || !packageName || !providerPackageMatches(packageName, "devin-opencode-provider")) return integration
  return { ...integration, projectFinish: projectDevinFinish }
}

/**
 * Event-only classic plugin: public plugin hooks supply the transport needed by
 * reconciliation, without wrapping (and re-identifying) the provider's plugin.
 * The bridge drops repeated deliveries, so providers that forward events
 * themselves are not reconciled twice.
 */
export function usageEventPlugin(host: string) {
  return async function ocpUsageEvents(input?: { client?: unknown; directory?: string; serverUrl?: URL }) {
    if ((host !== "kilo" && host !== "mimo") || !input?.client || !input.directory || !input.serverUrl) return {}
    const { client, directory, serverUrl } = input
    return {
      async event({ event }: { event: unknown }) {
        const bridge = (globalThis as Record<symbol, unknown>)[Symbol.for("opencode.host.event-bridge")] as {
          handle?: (input: unknown) => unknown
        } | undefined
        try {
          await bridge?.handle?.({ client, directory, serverUrl, event })
        } catch {
          // Hosts fire plugin events without awaiting them; accounting is additive.
        }
      },
    }
  }
}
