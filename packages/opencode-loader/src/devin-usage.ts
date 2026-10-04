/** Optional Devin integration: cached-context snapshots are not billed input partitions. */
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { usageCount, type UsageContext } from "./usage.js"

type Finish = LanguageModelV3StreamPart & { type: "finish" }

function counters(part: Finish): Record<string, unknown> | undefined {
  const metadata = part.providerMetadata?.devin
  if (!metadata || typeof metadata !== "object") return undefined
  const value = metadata.usageCounters ?? metadata.rawCounters
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

export function devinFinishUsage(part: Finish): LanguageModelV3Usage | undefined {
  const raw = counters(part)
  const input = usageCount(raw?.inputTokens)
  const read = usageCount(raw?.cacheRead)
  if (input === undefined || read === undefined || read <= input) return undefined
  const write = Math.min(input, usageCount(raw?.cacheWrite) ?? usageCount(part.usage.inputTokens.cacheWrite) ?? 0)
  return {
    ...part.usage,
    inputTokens: { total: input, noCache: input - write, cacheRead: 0, cacheWrite: write },
  }
}

/** Matches Devin's own diagnostic context reconstruction; output is a separate bucket. */
export function devinFinishContext(part: Finish): UsageContext | undefined {
  if (part.finishReason.unified === "error") return undefined
  const raw = counters(part)
  const input = usageCount(raw?.inputTokens)
  const read = usageCount(raw?.cacheRead)
  const output = usageCount(raw?.outputTokens)
  if (input === undefined || read === undefined || output === undefined || read <= input) return undefined
  const promptTokens = usageCount(input + read)
  const contextTokens = promptTokens === undefined ? undefined : usageCount(promptTokens + output)
  return contextTokens === undefined || promptTokens === undefined ? undefined : { promptTokens, contextTokens }
}
