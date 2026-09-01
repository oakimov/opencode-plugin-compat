/**
 * AI-SDK V3 stream parts → DSH `StreamChunk`.
 * Inverts `ai-sdk-provider-dsh` `event-mapper.ts` direction.
 * DSH protocol: `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`
 * — `usage` before `finish`, tool args raw JSON strings, nothing after `finish`.
 * Validated against `packages/llm/llm/src/types.ts:364` + `assembler.ts:38`.
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

// Minimal StreamChunk — structural, mirrors DSH `packages/llm/llm/src/types.ts:364`
export type StreamChunk =
  | { type: "block-start"; index: number; blockType: "text" | "reasoning" | "tool-call" }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: { type: string; [k: string]: unknown } }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; reasoningTokens?: number; [k: string]: unknown } }
  | { type: "finish"; reason: { kind: string; [k: string]: unknown }; replayState?: unknown }

function mapFinishReason(v3: unknown): { kind: string; [k: string]: unknown } {
  const unified = typeof v3 === "string"
    ? v3
    : (v3 && typeof v3 === "object" && "unified" in v3 ? String((v3 as { unified?: unknown }).unified ?? "") : "")
  switch (unified) {
    case "stop": return { kind: "stop" }
    case "tool-calls": return { kind: "tool-calls" }
    case "length": return { kind: "max-tokens" }
    default: return { kind: unified.length > 0 ? unified : "stop" }
  }
}

/**
 * Convert a V3 stream into DSH chunks.
 * Each V3 part becomes one or more DSH chunks with monotonic block indexes.
 * Tool-call `input` is serialized as raw JSON string (DSH expects `argumentsDelta` as JSON fragments).
 */
export async function* v3StreamToDshChunks(stream: ReadableStream<LanguageModelV3StreamPart>): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader()
  let nextIndex = 0
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
  const toolIndices = new Map<string, number>()
  const toolArgBuffers = new Map<number, string>()
  const toolNames = new Map<string, string>()
  const toolClosed = new Set<number>()
  let textBuffer = ""
  let reasoningBuffer = ""
  let textStarted = false
  let reasoningStarted = false
  let textEnded = false
  let reasoningEnded = false
  let pendingUsage: StreamChunk | undefined
  let pendingFinish: StreamChunk | undefined

  const ensureText = (): number => {
    if (textIndex !== undefined) return textIndex
    const idx = nextIndex++
    textIndex = idx
    return idx
  }
  const ensureReasoning = (): number => {
    if (reasoningIndex !== undefined) return reasoningIndex
    const idx = nextIndex++
    reasoningIndex = idx
    return idx
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const part: any = value

      switch (part.type) {
        case "stream-start":
          // No DSH equivalent
          break

        case "text-start": {
          const idx = ensureText()
          if (!textStarted) {
            textStarted = true
            yield { type: "block-start", index: idx, blockType: "text" }
          }
          break
        }
        case "text-delta": {
          const idx = ensureText()
          if (!textStarted) {
            textStarted = true
            yield { type: "block-start", index: idx, blockType: "text" }
          }
          textBuffer += part.delta as string
          yield { type: "text-delta", index: idx, text: part.delta }
          break
        }
        case "text-end":
          if (textIndex !== undefined && !textEnded) {
            textEnded = true
            yield { type: "block-end", index: textIndex, block: { type: "text", text: textBuffer } }
          }
          break

        case "reasoning-start": {
          const idx = ensureReasoning()
          if (!reasoningStarted) {
            reasoningStarted = true
            yield { type: "block-start", index: idx, blockType: "reasoning" }
          }
          break
        }
        case "reasoning-delta": {
          const idx = ensureReasoning()
          if (!reasoningStarted) {
            reasoningStarted = true
            yield { type: "block-start", index: idx, blockType: "reasoning" }
          }
          reasoningBuffer += part.delta as string
          yield { type: "reasoning-delta", index: idx, text: part.delta }
          break
        }
        case "reasoning-end":
          if (reasoningIndex !== undefined && !reasoningEnded) {
            reasoningEnded = true
            yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningBuffer } }
          }
          break

        case "tool-input-start": {
          const id = part.id as string
          const name = typeof part.toolName === "string" ? part.toolName : undefined
          const idx = nextIndex++
          toolIndices.set(id, idx)
          toolArgBuffers.set(idx, "")
          if (name) toolNames.set(id, name)
          yield { type: "block-start", index: idx, blockType: "tool-call" }
          yield { type: "tool-call-delta", index: idx, id, ...(name ? { name } : {}), argumentsDelta: "" }
          break
        }
        case "tool-input-delta": {
          const id = part.id as string
          let idx = toolIndices.get(id)
          if (idx === undefined) {
            idx = nextIndex++
            toolIndices.set(id, idx)
            toolArgBuffers.set(idx, "")
            yield { type: "block-start", index: idx, blockType: "tool-call" }
          }
          const delta = (part.delta as string) ?? ""
          toolArgBuffers.set(idx, (toolArgBuffers.get(idx) ?? "") + delta)
          yield { type: "tool-call-delta", index: idx, id, argumentsDelta: delta }
          break
        }
        case "tool-input-end": {
          const id = part.id as string
          const idx = toolIndices.get(id)
          if (idx !== undefined && !toolClosed.has(idx)) {
            toolClosed.add(idx)
            const assembled = toolArgBuffers.get(idx) ?? ""
            const name = (typeof part.toolName === "string" && part.toolName.length > 0)
              ? part.toolName
              : (toolNames.get(id) ?? "")
            yield { type: "block-end", index: idx, block: { type: "tool-call", id, name, arguments: assembled } }
          }
          break
        }
        case "tool-call": {
          const id = (part as any).toolCallId as string
          const name = typeof (part as any).toolName === "string" ? (part as any).toolName : (toolNames.get(id) ?? "")
          if (name) toolNames.set(id, name)
          const input = (part as any).input
          const args = typeof input === "string" ? input : JSON.stringify(input ?? {})
          let idx = toolIndices.get(id)
          if (idx === undefined) {
            idx = nextIndex++
            toolIndices.set(id, idx)
            yield { type: "block-start", index: idx, blockType: "tool-call" }
          }
          if (toolClosed.has(idx)) break
          toolClosed.add(idx)
          if (!toolArgBuffers.has(idx)) {
            yield { type: "tool-call-delta", index: idx, id, ...(name ? { name } : {}), argumentsDelta: args }
          }
          yield { type: "block-end", index: idx, block: { type: "tool-call", id, name, arguments: args } }
          break
        }

        case "finish": {
          const usage = part.usage as any
          if (usage) {
            const mapped: any = {}
            if (typeof usage.inputTokens === "object" && usage.inputTokens) {
              mapped.inputTokens = usage.inputTokens.total ?? usage.inputTokens.noCache ?? 0
              if (usage.inputTokens.cacheRead !== undefined) mapped.cacheReadTokens = usage.inputTokens.cacheRead
            } else if (typeof usage.inputTokens === "number") mapped.inputTokens = usage.inputTokens
            else mapped.inputTokens = 0
            if (typeof usage.outputTokens === "object" && usage.outputTokens) {
              mapped.outputTokens = usage.outputTokens.total ?? ((usage.outputTokens.text ?? 0) + (usage.outputTokens.reasoning ?? 0))
              if (usage.outputTokens.reasoning !== undefined) mapped.reasoningTokens = usage.outputTokens.reasoning
            } else if (typeof usage.outputTokens === "number") mapped.outputTokens = usage.outputTokens
            else mapped.outputTokens = 0
            if (mapped.inputTokens !== undefined || mapped.outputTokens !== undefined) {
              pendingUsage = { type: "usage", usage: mapped }
            }
          }
          pendingFinish = { type: "finish", reason: mapFinishReason((part as any).finishReason), ...(part.providerMetadata ? { replayState: part.providerMetadata } : {}) }
          break
        }

        case "error": {
          const err = (part as any).error
          pendingFinish = {
            type: "finish",
            reason: {
              kind: "error",
              failure: { message: err instanceof Error ? err.message : String(err ?? "unknown"), code: "UNKNOWN" },
            },
          }
          break
        }

        default:
          // Unknown V3 part — log but ignore (e.g. file, source)
          break
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (textIndex !== undefined && !textEnded) {
    yield { type: "block-end", index: textIndex, block: { type: "text", text: textBuffer } }
  }
  if (reasoningIndex !== undefined && !reasoningEnded) {
    yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningBuffer } }
  }
  for (const [id, idx] of toolIndices) {
    if (toolClosed.has(idx)) continue
    toolClosed.add(idx)
    yield {
      type: "block-end",
      index: idx,
      block: { type: "tool-call", id, name: toolNames.get(id) ?? "", arguments: toolArgBuffers.get(idx) ?? "" },
    }
  }

  if (pendingUsage) yield pendingUsage
  if (pendingFinish) yield pendingFinish
  else yield { type: "finish", reason: { kind: "stop" } }
}

/** Helper for tests: collect V3 stream parts into DSH chunks array */
export async function collectV3ToDsh(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of v3StreamToDshChunks(stream)) out.push(chunk)
  return out
}
