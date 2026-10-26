/**
 * AI-SDK V3 stream parts → DSH `StreamChunk`.
 * Inverts `ai-sdk-provider-dsh` `event-mapper.ts` direction.
 * DSH protocol: `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`
 * — `usage` before `finish`, tool args raw JSON strings, nothing after `finish`.
 * Validated against `packages/llm/llm/src/types.ts:364` + `assembler.ts:38`.
 */
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { normalizeUsage, type UsageContext } from "@opencode-compat/opencode-loader"
import { dshToolInputs } from "../host/profile.js"
import {
  hostToolCallArgumentsJson,
  hostToolName,
  type DshToolInputVocabulary,
} from "./tools.js"

// Minimal StreamChunk — structural, mirrors DSH `packages/llm/llm/src/types.ts:364`
export type StreamChunk =
  | { type: "block-start"; index: number; blockType: "text" | "reasoning" | "tool-call" }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: { type: string; [k: string]: unknown } }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; [k: string]: unknown } }
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
type TextBlock = { index: number; buffer: string; started: boolean; ended: boolean }

export async function* v3StreamToDshChunks(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
  options: {
    allowedProviderToolNames?: ReadonlySet<string>
    /** Optional package-selected accounting projection; null means display only. */
    finishUsage?: (part: LanguageModelV3StreamPart & { type: "finish" }) => LanguageModelV3Usage | null | undefined
    finishContext?: (part: LanguageModelV3StreamPart & { type: "finish" }) => UsageContext | undefined
  } = {},
): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader()
  let nextIndex = 0
  // Per V3 id — a second text/reasoning after a tool call must open a new DSH
  // block. Reusing a closed index is dropped by DSH's assembler.
  const textBlocks = new Map<string, TextBlock>()
  const reasoningBlocks = new Map<string, TextBlock>()
  const toolIndices = new Map<string, number>()
  const toolArgBuffers = new Map<number, string>()
  const toolNames = new Map<string, string>()
  const providerToolNames = new Map<string, string>()
  const toolClosed = new Set<number>()
  let pendingUsage: StreamChunk | undefined
  let pendingFinish: StreamChunk | undefined

  const assertAllowedTool = (name: string): void => {
    if (options.allowedProviderToolNames && !options.allowedProviderToolNames.has(name)) {
      throw new Error(`Provider emitted unadvertised tool call "${name}"`)
    }
  }

  const openText = (id: string): TextBlock => {
    const existing = textBlocks.get(id)
    if (existing && !existing.ended) return existing
    const block: TextBlock = { index: nextIndex++, buffer: "", started: false, ended: false }
    textBlocks.set(id, block)
    return block
  }
  const openReasoning = (id: string): TextBlock => {
    const existing = reasoningBlocks.get(id)
    if (existing && !existing.ended) return existing
    const block: TextBlock = { index: nextIndex++, buffer: "", started: false, ended: false }
    reasoningBlocks.set(id, block)
    return block
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
          const block = openText(String(part.id ?? "text"))
          if (!block.started) {
            block.started = true
            yield { type: "block-start", index: block.index, blockType: "text" }
          }
          break
        }
        case "text-delta": {
          const block = openText(String(part.id ?? "text"))
          if (!block.started) {
            block.started = true
            yield { type: "block-start", index: block.index, blockType: "text" }
          }
          block.buffer += part.delta as string
          yield { type: "text-delta", index: block.index, text: part.delta }
          break
        }
        case "text-end": {
          const block = textBlocks.get(String(part.id ?? "text"))
          if (block && !block.ended) {
            block.ended = true
            yield { type: "block-end", index: block.index, block: { type: "text", text: block.buffer } }
          }
          break
        }

        case "reasoning-start": {
          const block = openReasoning(String(part.id ?? "reasoning"))
          if (!block.started) {
            block.started = true
            yield { type: "block-start", index: block.index, blockType: "reasoning" }
          }
          break
        }
        case "reasoning-delta": {
          const block = openReasoning(String(part.id ?? "reasoning"))
          if (!block.started) {
            block.started = true
            yield { type: "block-start", index: block.index, blockType: "reasoning" }
          }
          block.buffer += part.delta as string
          yield { type: "reasoning-delta", index: block.index, text: part.delta }
          break
        }
        case "reasoning-end": {
          const block = reasoningBlocks.get(String(part.id ?? "reasoning"))
          if (block && !block.ended) {
            block.ended = true
            yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.buffer } }
          }
          break
        }

        case "tool-input-start": {
          const id = part.id as string
          if (typeof part.toolName === "string" && part.toolName.length > 0) {
            assertAllowedTool(part.toolName)
            providerToolNames.set(id, part.toolName)
          }
          const name = typeof part.toolName === "string" ? hostToolName(part.toolName, toolInputs) : undefined
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
          const providerName = typeof part.toolName === "string" && part.toolName.length > 0
            ? part.toolName
            : providerToolNames.get(id)
          if (providerName) assertAllowedTool(providerName)
          const idx = toolIndices.get(id)
          if (idx !== undefined && !toolClosed.has(idx)) {
            toolClosed.add(idx)
            const assembled = toolArgBuffers.get(idx) ?? ""
            const rawName = providerName ?? toolNames.get(id) ?? ""
            const rewritten = {
              name: hostToolName(rawName, toolInputs),
              arguments: hostToolCallArgumentsJson(rawName, assembled, toolInputs),
            }
            if (rewritten.name) toolNames.set(id, rewritten.name)
            yield {
              type: "block-end",
              index: idx,
              block: { type: "tool-call", id, name: rewritten.name, arguments: rewritten.arguments },
            }
          }
          break
        }
        case "tool-call": {
          const id = (part as any).toolCallId as string
          const providerName = typeof (part as any).toolName === "string" ? (part as any).toolName : (providerToolNames.get(id) ?? "")
          assertAllowedTool(providerName)
          const input = (part as any).input
          const rawArgs = typeof input === "string" ? input : JSON.stringify(input ?? {})
          const rewritten = {
            name: hostToolName(providerName, toolInputs),
            arguments: hostToolCallArgumentsJson(providerName, rawArgs, toolInputs),
          }
          const name = rewritten.name
          const args = rewritten.arguments
          if (name) toolNames.set(id, name)
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
          const projected = options.finishUsage?.(part)
          const usage = (projected === null
            ? { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, reasoning: 0 } }
            : projected ?? part.usage) as any
          if (usage) {
            const mapped = normalizeUsage(usage)
            pendingUsage = { type: "usage", usage: {
              inputTokens: mapped.input, outputTokens: mapped.output,
              ...(mapped.cacheRead === undefined ? {} : { cacheReadTokens: mapped.cacheRead }),
              ...(mapped.cacheWrite === undefined ? {} : { cacheWriteTokens: mapped.cacheWrite }),
              ...(mapped.reasoning === undefined ? {} : { reasoningTokens: mapped.reasoning }),
              ...(mapped.total === undefined ? {} : { totalTokens: mapped.total }),
            } }
          }
          const context = options.finishContext?.(part)
          pendingFinish = {
            type: "finish", reason: mapFinishReason(part.finishReason),
            ...(part.providerMetadata || context ? { replayState: { response: {
              ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
              ...(context ? { ocpContext: context } : {}),
            } } } : {}),
          }
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

  const openTextEnds = [...textBlocks.values()]
    .filter((block) => block.started && !block.ended)
    .sort((a, b) => a.index - b.index)
  for (const block of openTextEnds) {
    block.ended = true
    yield { type: "block-end", index: block.index, block: { type: "text", text: block.buffer } }
  }
  const openReasoningEnds = [...reasoningBlocks.values()]
    .filter((block) => block.started && !block.ended)
    .sort((a, b) => a.index - b.index)
  for (const block of openReasoningEnds) {
    block.ended = true
    yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.buffer } }
  }
  for (const [id, idx] of toolIndices) {
    if (toolClosed.has(idx)) continue
    toolClosed.add(idx)
    const providerName = providerToolNames.get(id) ?? toolNames.get(id) ?? ""
    assertAllowedTool(providerName)
    const rewritten = {
      name: hostToolName(providerName, toolInputs),
      arguments: hostToolCallArgumentsJson(providerName, toolArgBuffers.get(idx) ?? "", toolInputs),
    }
    yield {
      type: "block-end",
      index: idx,
      block: { type: "tool-call", id, name: rewritten.name, arguments: rewritten.arguments },
    }
  }

  if (pendingUsage) yield pendingUsage
  if (pendingFinish) yield pendingFinish
  else yield { type: "finish", reason: { kind: "stop" } }
}

/** Helper for tests: collect V3 stream parts into DSH chunks array */
export async function collectV3ToDsh(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  toolInputs?: DshToolInputVocabulary,
  options?: {
    allowedProviderToolNames?: ReadonlySet<string>
    finishUsage?: (part: LanguageModelV3StreamPart & { type: "finish" }) => LanguageModelV3Usage | null | undefined
    finishContext?: (part: LanguageModelV3StreamPart & { type: "finish" }) => UsageContext | undefined
  },
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of v3StreamToDshChunks(stream, toolInputs ?? dshToolInputs(), options)) out.push(chunk)
  return out
}
