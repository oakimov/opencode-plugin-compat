/** Optional package-selected Devin integration for the clone adapter. */
import { devinFinishUsage, devinFinishContext } from "@opencode-compat/opencode-loader/devin-usage"
import type { StreamPartLike } from "./language-model"

export function projectDevinFinish(part: StreamPartLike): StreamPartLike {
  const finish = part as Parameters<typeof devinFinishUsage>[0]
  const usage = devinFinishUsage(finish)
  const context = devinFinishContext(finish)
  if (!context) return usage ? { ...part, usage } : part
  return {
    ...part,
    usage: usage ?? finish.usage,
    providerMetadata: {
      ...finish.providerMetadata,
      // Clone SDK usage also prices assistant messages. Replacing aggregates
      // with occupancy would overcharge; their public part PATCH cannot repair
      // the assistant's cost. Keep context available as separate diagnostics.
      ocpContext: context,
    },
  }
}
