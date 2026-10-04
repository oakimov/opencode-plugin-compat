/** Cursor's terminal Run counters are separate from its context occupancy. */
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { usageCount, type UsageContext } from "@opencode-compat/opencode-loader"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function cursorFinishContext(part: LanguageModelV3StreamPart & { type: "finish" }): UsageContext | undefined {
  if (part.finishReason.unified === "error") return undefined
  const cursor = asRecord(asRecord(part.providerMetadata)?.cursor)
  const contextTokens = usageCount(asRecord(cursor?.context)?.usedTokens)
  if (contextTokens === undefined) return undefined
  const promptTokens = Math.min(contextTokens, usageCount(part.usage.inputTokens.total) ?? contextTokens)
  return { contextTokens, promptTokens }
}

export function cursorFinishUsage(
  part: LanguageModelV3StreamPart & { type: "finish" },
): LanguageModelV3Usage | null | undefined {
  const cursor = asRecord(asRecord(part.providerMetadata)?.cursor)
  if (cursor?.occupancyOnly === true) return null

  const rawKeys = ["inputTokensRaw", "outputTokensRaw", "cacheReadRaw", "cacheWriteRaw", "reasoningTokensRaw"]
  if (!rawKeys.some((key) => typeof cursor?.[key] === "number")) return undefined

  const count = (key: string): number => {
    const value = cursor?.[key]
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }
  const input = count("inputTokensRaw")
  const output = count("outputTokensRaw")
  const cacheRead = Math.min(input, count("cacheReadRaw"))
  const cacheWrite = Math.min(input - cacheRead, count("cacheWriteRaw"))
  const reasoning = Math.min(output, count("reasoningTokensRaw"))
  return {
    inputTokens: {
      total: input,
      noCache: input - cacheRead - cacheWrite,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output - reasoning,
      reasoning,
    },
  }
}
