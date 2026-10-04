/** Normalize AI-SDK aggregates into disjoint host buckets, without inventing exact totals. */
export function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

export type UsageContext = { contextTokens: number; promptTokens: number }

/** Keep unknown aggregates unknown while completing known V3 partitions. */
export function normalizeV3Usage(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  const usage = record(value)
  if (!usage.inputTokens || typeof usage.inputTokens !== "object"
    || !usage.outputTokens || typeof usage.outputTokens !== "object") return value
  const input = record(usage.inputTokens)
  const output = record(usage.outputTokens)
  const normalized = normalizeUsage(value)
  const exactInput = usageCount(input.total) ?? (usageCount(input.noCache) !== undefined
    && usageCount(input.cacheRead) !== undefined && usageCount(input.cacheWrite) !== undefined
    ? usageCount(input.noCache)! + usageCount(input.cacheRead)! + usageCount(input.cacheWrite)! : undefined)
  const exactOutput = usageCount(output.total) ?? (usageCount(output.text) !== undefined
    && usageCount(output.reasoning) !== undefined ? usageCount(output.text)! + usageCount(output.reasoning)! : undefined)
  return {
    ...usage,
    inputTokens: { ...input, total: usageCount(exactInput), noCache: normalized.input,
      cacheRead: normalized.cacheRead, cacheWrite: normalized.cacheWrite },
    outputTokens: { ...output, total: usageCount(exactOutput),
      text: exactOutput === undefined ? usageCount(output.text) : exactOutput - (normalized.reasoning ?? 0),
      reasoning: normalized.reasoning },
  }
}

export function normalizeUsage(value: unknown): {
  input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; total?: number
} {
  const usage = record(value)
  const input = record(usage.inputTokens)
  const output = record(usage.outputTokens)
  const inputTotal = usageCount(typeof usage.inputTokens === "number" ? usage.inputTokens : input.total)
  const outputTotal = usageCount(typeof usage.outputTokens === "number" ? usage.outputTokens : output.total)
  const noCache = usageCount(input.noCache)
  const read = usageCount(input.cacheRead)
  const write = usageCount(input.cacheWrite)
  const text = usageCount(output.text)
  const reasoning = usageCount(output.reasoning)
  // An aggregate is authoritative. Missing components must not erase it, and
  // contradictory components must not make a disjoint host sum exceed it.
  const cacheRead = read === undefined ? undefined : Math.min(read, inputTotal ?? read)
  const cacheWrite = write === undefined ? undefined : Math.min(write, inputTotal === undefined ? write : inputTotal - (cacheRead ?? 0))
  const uncached = inputTotal === undefined ? noCache ?? 0 : inputTotal - (cacheRead ?? 0) - (cacheWrite ?? 0)
  const generated = outputTotal ?? (text ?? 0) + (reasoning ?? 0)
  const exactInput = inputTotal ?? (noCache !== undefined && read !== undefined && write !== undefined ? noCache + read + write : undefined)
  const exactOutput = outputTotal ?? (text !== undefined && reasoning !== undefined ? text + reasoning : undefined)
  const total = exactInput !== undefined && exactOutput !== undefined ? usageCount(exactInput + exactOutput) : undefined
  return {
    input: uncached, output: generated,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning: Math.min(reasoning, generated) }),
    ...(total === undefined ? {} : { total }),
  }
}

/** Explicit package identity; metadata alone never activates an integration. */
export function providerPackageMatches(specifier: string, name: string): boolean {
  const at = specifier.lastIndexOf("@")
  const bare = at > 0 && !specifier.slice(at + 1).includes("/") ? specifier.slice(0, at) : specifier
  return bare === name || bare.startsWith(`${name}/`) || bare.includes(`/${name}/`) || bare.endsWith(`/${name}`)
}
