/**
 * AI-SDK V3 `doStream` output → Pi `AssistantMessageEvent`s, pushed into one
 * event stream against a single mutate-in-place `partial` (the contract both
 * hosts' `utils/event-stream.ts` and their mock providers rely on).
 *
 * Host-neutral: only the event variants **both** hosts share are emitted, so
 * this works unchanged on oh-my-pi (which additionally has `image_end`) and pi
 * (which additionally has a `deferred` done-reason).
 */
import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import type {
  PiAssistantMessage as AssistantMessage,
  PiEventStream as AssistantMessageEventStream,
  PiModelLike as Model,
  PiToolCall,
  PiUsage,
} from "../pi-provider-types.js"

export function emptyUsage(): PiUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function translateUsage(usage: LanguageModelV3Usage, model: Model): PiUsage {
  const input = usage.inputTokens.noCache ?? 0
  const cacheRead = usage.inputTokens.cacheRead ?? 0
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0
  const output = usage.outputTokens.total ?? 0
  const totalInput = usage.inputTokens.total ?? input + cacheRead + cacheWrite
  const totalTokens = totalInput + output
  const rate = model.cost
  const cost = {
    input: (input / 1_000_000) * rate.input,
    output: (output / 1_000_000) * rate.output,
    cacheRead: (cacheRead / 1_000_000) * rate.cacheRead,
    cacheWrite: (cacheWrite / 1_000_000) * rate.cacheWrite,
    total: 0,
  }
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite
  const out: PiUsage = { input, output, cacheRead, cacheWrite, totalTokens, cost }
  if (usage.outputTokens.reasoning !== undefined) out.reasoningTokens = usage.outputTokens.reasoning
  return out
}

/** `finish.finishReason.unified` → Pi's narrower `done`/`error` reason unions. */
function translateFinishReason(reason: LanguageModelV3FinishReason): { kind: "done"; reason: "stop" | "length" | "toolUse" } | { kind: "error"; reason: "error" } {
  switch (reason.unified) {
    case "tool-calls":
      return { kind: "done", reason: "toolUse" }
    case "length":
      return { kind: "done", reason: "length" }
    case "error":
      return { kind: "error", reason: "error" }
    case "content-filter":
    case "stop":
    case "other":
    default:
      return { kind: "done", reason: "stop" }
  }
}

function parseToolInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Drive `piStream` to completion from a V3 `doStream` result. Fire-and-forget:
 * callers construct `piStream` synchronously, invoke this without awaiting,
 * and return `piStream` immediately (matches `streamSimple`'s sync-return
 * contract).
 */
export async function runV3StreamToPi(options: {
  model: Model
  v3Stream: AsyncIterable<LanguageModelV3StreamPart> | ReadableStream<LanguageModelV3StreamPart>
  piStream: AssistantMessageEventStream
}): Promise<void> {
  const { model, piStream } = options
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  }
  piStream.push({ type: "start", partial })

  const textIndexById = new Map<string, number>()
  const reasoningIndexById = new Map<string, number>()
  const toolCallIndexById = new Map<string, number>()

  function openTextBlock(id: string) {
    const idx = partial.content.push({ type: "text", text: "" }) - 1
    textIndexById.set(id, idx)
    piStream.push({ type: "text_start", contentIndex: idx, partial })
  }

  function openReasoningBlock(id: string) {
    const idx = partial.content.push({ type: "thinking", thinking: "" }) - 1
    reasoningIndexById.set(id, idx)
    piStream.push({ type: "thinking_start", contentIndex: idx, partial })
  }

  function openToolCallBlock(id: string): number {
    const idx = partial.content.push({ type: "toolCall", id, name: "", arguments: {} }) - 1
    toolCallIndexById.set(id, idx)
    piStream.push({ type: "toolcall_start", contentIndex: idx, partial })
    return idx
  }

  const v3Stream: AsyncIterable<LanguageModelV3StreamPart> =
    Symbol.asyncIterator in options.v3Stream ? (options.v3Stream as AsyncIterable<LanguageModelV3StreamPart>) : (options.v3Stream as unknown as AsyncIterable<LanguageModelV3StreamPart>)

  try {
    for await (const part of v3Stream) {
      switch (part.type) {
        case "stream-start":
          break
        case "text-start":
          openTextBlock(part.id)
          break
        case "text-delta": {
          let idx = textIndexById.get(part.id)
          if (idx === undefined) {
            openTextBlock(part.id)
            idx = textIndexById.get(part.id)!
          }
          const block = partial.content[idx]! as { type: "text"; text: string }
          block.text += part.delta
          piStream.push({ type: "text_delta", contentIndex: idx, delta: part.delta, partial })
          break
        }
        case "text-end": {
          const idx = textIndexById.get(part.id)
          if (idx === undefined) break
          const block = partial.content[idx]! as { type: "text"; text: string }
          piStream.push({ type: "text_end", contentIndex: idx, content: block.text, partial })
          break
        }
        case "reasoning-start":
          openReasoningBlock(part.id)
          break
        case "reasoning-delta": {
          let idx = reasoningIndexById.get(part.id)
          if (idx === undefined) {
            openReasoningBlock(part.id)
            idx = reasoningIndexById.get(part.id)!
          }
          const block = partial.content[idx]! as { type: "thinking"; thinking: string }
          block.thinking += part.delta
          piStream.push({ type: "thinking_delta", contentIndex: idx, delta: part.delta, partial })
          break
        }
        case "reasoning-end": {
          const idx = reasoningIndexById.get(part.id)
          if (idx === undefined) break
          const block = partial.content[idx]! as { type: "thinking"; thinking: string }
          piStream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial })
          break
        }
        case "tool-input-start":
          openToolCallBlock(part.id)
          break
        case "tool-input-delta": {
          const idx = toolCallIndexById.get(part.id) ?? openToolCallBlock(part.id)
          piStream.push({ type: "toolcall_delta", contentIndex: idx, delta: part.delta, partial })
          break
        }
        case "tool-input-end":
          break
        case "tool-call": {
          const idx = toolCallIndexById.get(part.toolCallId) ?? openToolCallBlock(part.toolCallId)
          const toolCall: PiToolCall = { type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: parseToolInput(part.input) }
          partial.content[idx] = toolCall
          piStream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial })
          break
        }
        case "finish": {
          partial.usage = translateUsage(part.usage, model)
          const finish = translateFinishReason(part.finishReason)
          if (finish.kind === "done") {
            partial.stopReason = finish.reason
            piStream.push({ type: "done", reason: finish.reason, message: partial })
          } else {
            partial.stopReason = "error"
            piStream.push({ type: "error", reason: "error", error: partial })
          }
          return
        }
        case "error": {
          partial.stopReason = "error"
          partial.errorMessage = part.error instanceof Error ? part.error.message : String(part.error)
          piStream.push({ type: "error", reason: "error", error: partial })
          return
        }
        default:
          break
      }
    }
    // Stream closed without a `finish`/`error` part — treat as a protocol error
    // rather than leaving `piStream.result()` unsettled.
    partial.stopReason = "error"
    partial.errorMessage = "Provider stream ended without a finish event"
    piStream.push({ type: "error", reason: "error", error: partial })
  } catch (err) {
    partial.stopReason = "error"
    partial.errorMessage = err instanceof Error ? err.message : String(err)
    piStream.push({ type: "error", reason: "error", error: partial })
  }
}
