/** Cursor's terminal Run counters are separate from its context occupancy. */
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { PiUsage } from "../pi-provider-types.js"
import type { PiHostId } from "../host/profile.js"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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

/** Cursor's checkpoint occupancy must size Pi context; TurnEnded bills the run. */
export function cursorFinishContextTokens(
  part: LanguageModelV3StreamPart & { type: "finish" },
): number | undefined {
  const cursor = asRecord(asRecord(part.providerMetadata)?.cursor)
  const context = asRecord(cursor?.context)
  const used = context?.usedTokens
  return typeof used === "number" && Number.isFinite(used) && used >= 0
    ? Math.trunc(used)
    : undefined
}

/**
 * Pi's overflow classifier sums usage.input/cacheRead/cacheWrite even after a
 * successful turn. Cursor's terminal raw counters cover every step in a held
 * Run, so that sum can exceed the model window while the live checkpoint is
 * small. Keep billable cost, but classify the input beyond the occupied prompt
 * as provider-side orchestration (billable work absent from replayed context).
 *
 * Vanilla pi sizes the footer/compaction meter from `totalTokens` and ignores
 * `contextTokens`. Only that host needs occupancy mirrored into both fields.
 * OMP prefers `contextTokens` and sums `totalTokens` for billable session usage.
 */
export function cursorFinishPiUsage(
  part: LanguageModelV3StreamPart & { type: "finish" },
  usage: PiUsage,
  host: PiHostId = "omp",
): PiUsage {
  if (part.finishReason.unified === "error") return usage
  const cursor = asRecord(asRecord(part.providerMetadata)?.cursor)
  const contextTokens = usage.contextTokens
  if (!cursor || contextTokens === undefined) return usage

  let next = usage
  if (cursor.occupancyOnly !== true) {
    const rawInput = usage.input + usage.cacheRead + usage.cacheWrite
    const reportedOccupiedInput = part.usage.inputTokens.total
    const occupiedInput = typeof reportedOccupiedInput === "number" && Number.isFinite(reportedOccupiedInput)
      ? Math.max(0, Math.trunc(reportedOccupiedInput))
      : contextTokens
    const budget = Math.min(rawInput, contextTokens, occupiedInput)
    if (rawInput > budget) {
      const input = Math.min(usage.input, budget)
      const cacheWrite = Math.min(usage.cacheWrite, budget - input)
      const cacheRead = Math.min(usage.cacheRead, budget - input - cacheWrite)
      const extraInput = usage.input - input + usage.cacheWrite - cacheWrite
      const extraCacheRead = usage.cacheRead - cacheRead
      next = {
        ...usage,
        input,
        cacheRead,
        cacheWrite,
        orchestration: {
          ...(extraInput > 0 ? { input: extraInput } : {}),
          ...(extraCacheRead > 0 ? { cacheRead: extraCacheRead } : {}),
        },
      }
    }
  }

  // Vanilla pi: calculateContextTokens(usage) === usage.totalTokens || components.
  // Keep cost/orchestration as the billable sidecar; never leave totalTokens on
  // the held-Run raw sum or the meter reads hundreds of thousands too high.
  if (host === "pi" && next.totalTokens !== contextTokens) {
    next = { ...next, totalTokens: contextTokens }
  }
  return next
}
