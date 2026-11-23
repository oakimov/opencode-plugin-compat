/**
 * AI SDK V3 output → Anthropic Messages wire (SSE and JSON), in the dialect
 * `@ai-sdk/anthropic` parses on the ZCode side.
 *
 * - A `tool_use` block is emitted only for a complete call whose canonical
 *   input converted losslessly to the native shape; streamed tool-input
 *   fragments are never forwarded.
 * - Provider-executed tool calls/results stay inside the provider.
 * - A stream that ends without a `finish`, or finishes with `error` or an
 *   unknown status, produces an `error` event — never a synthetic success.
 */
import { randomBytes } from "node:crypto"
import type {
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { ToolMappingError, type RequestToolMap } from "./tools.js"

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error"

export function anthropicError(type: AnthropicErrorType, message: string) {
  return { type: "error" as const, error: { type, message } }
}

export function messageId(): string {
  return `msg_ocp_${randomBytes(12).toString("hex")}`
}

type AnthropicUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** V3 usage → Anthropic usage: `input_tokens` excludes cache reads/writes. */
export function anthropicUsage(usage: LanguageModelV3Usage | undefined): AnthropicUsage {
  const input = usage?.inputTokens
  const cacheRead = input?.cacheRead
  const cacheWrite = input?.cacheWrite
  const noCache = input?.noCache ?? (input?.total !== undefined ? Math.max(0, input.total - (cacheRead ?? 0) - (cacheWrite ?? 0)) : 0)
  return {
    input_tokens: noCache,
    output_tokens: usage?.outputTokens?.total ?? 0,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

const ANTHROPIC_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"])

/**
 * V3 finish → Anthropic `stop_reason`, or `undefined` when the finish must be
 * reported as an error (explicit `error`, or an `other` with no recognizable
 * raw stop reason).
 */
export function anthropicStopReason(finish: LanguageModelV3FinishReason, emittedToolUse: boolean): string | undefined {
  if (emittedToolUse && finish.unified !== "error") return "tool_use"
  switch (finish.unified) {
    case "stop": return "end_turn"
    case "length": return "max_tokens"
    case "content-filter": return "refusal"
    // All tool calls were provider-executed: nothing for ZCode to run.
    case "tool-calls": return "end_turn"
    case "error": return undefined
    case "other": return finish.raw && ANTHROPIC_STOP_REASONS.has(finish.raw) ? finish.raw : undefined
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export type StreamOutcome = {
  stopReason?: string
  error?: string
  toolCallIds: string[]
  /** The client went away before the stream completed. */
  aborted: boolean
}

export type EncodeStreamOptions = {
  model: string
  toolMap: RequestToolMap
  parts: ReadableStream<LanguageModelV3StreamPart>
  signal: AbortSignal
  /** Keepalive interval for `ping` events while waiting on the provider. */
  pingIntervalMs?: number
  onOutcome?: (outcome: StreamOutcome) => void
}

/** Encode a V3 stream as an Anthropic SSE byte stream. */
export function encodeAnthropicStream(options: EncodeStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const reader = options.parts.getReader()
  const id = messageId()
  let index = 0
  const open = new Map<string, number>()
  const outcome: StreamOutcome = { toolCallIds: [], aborted: false }
  let ping: ReturnType<typeof setInterval> | undefined
  let done = false

  let onAbort: (() => void) | undefined
  const finishOutcome = () => {
    if (ping) clearInterval(ping)
    ping = undefined
    if (onAbort) options.signal.removeEventListener("abort", onAbort)
    if (!done) {
      done = true
      options.onOutcome?.(outcome)
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse("message_start", {
        type: "message_start",
        message: {
          id, type: "message", role: "assistant", model: options.model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
      })))
      const interval = options.pingIntervalMs ?? 15_000
      if (interval > 0) {
        ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(sse("ping", { type: "ping" })))
          } catch {
            // The consumer already closed the stream.
          }
        }, interval)
      }
      // An aborted attempt (client gone, provider failure, shutdown) ends the
      // response at once, even when no read is pending to observe it.
      onAbort = () => {
        if (done) return
        outcome.aborted = true
        finishOutcome()
        try {
          controller.close()
        } catch {
          // Already closed or errored by the consumer.
        }
        void reader.cancel().catch(() => undefined)
      }
      if (options.signal.aborted) queueMicrotask(onAbort)
      else options.signal.addEventListener("abort", onAbort, { once: true })
    },

    async pull(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)))
      const closeBlocks = () => {
        for (const blockIndex of open.values()) emit("content_block_stop", { type: "content_block_stop", index: blockIndex })
        open.clear()
      }
      const failWith = (message: string) => {
        closeBlocks()
        outcome.error = message
        emit("error", anthropicError("api_error", message))
        finishOutcome()
        controller.close()
        void reader.cancel().catch(() => undefined)
      }

      // Drain parts until something is enqueued, so backpressure is honored.
      while (true) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          if (done) return
          if (options.signal.aborted) {
            outcome.aborted = true
            finishOutcome()
            controller.close()
            return
          }
          failWith(`provider stream failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        if (done) return
        if (next.done) {
          failWith("provider stream ended without a finish")
          return
        }
        const part = next.value
        switch (part.type) {
          case "text-start":
          case "reasoning-start": {
            const key = `${part.type === "text-start" ? "t" : "r"}:${part.id}`
            if (open.has(key)) continue
            open.set(key, index)
            emit("content_block_start", {
              type: "content_block_start",
              index: index++,
              content_block: part.type === "text-start" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
            })
            return
          }
          case "text-delta":
          case "reasoning-delta": {
            const isText = part.type === "text-delta"
            const key = `${isText ? "t" : "r"}:${part.id}`
            let blockIndex = open.get(key)
            if (blockIndex === undefined) {
              blockIndex = index++
              open.set(key, blockIndex)
              emit("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: isText ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
              })
            }
            if (part.delta.length === 0) continue
            emit("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: isText ? { type: "text_delta", text: part.delta } : { type: "thinking_delta", thinking: part.delta },
            })
            return
          }
          case "text-end":
          case "reasoning-end": {
            const key = `${part.type === "text-end" ? "t" : "r"}:${part.id}`
            const blockIndex = open.get(key)
            if (blockIndex === undefined) continue
            open.delete(key)
            emit("content_block_stop", { type: "content_block_stop", index: blockIndex })
            return
          }
          case "tool-call": {
            if (part.providerExecuted) continue
            let call: { name: string; input: string }
            try {
              call = options.toolMap.toNativeCall(part.toolName, part.input)
            } catch (error) {
              failWith(error instanceof ToolMappingError ? `invalid tool call ${part.toolCallId}: ${error.message}` : String(error))
              return
            }
            closeBlocks()
            const blockIndex = index++
            outcome.toolCallIds.push(part.toolCallId)
            emit("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: part.toolCallId, name: call.name, input: {} },
            })
            emit("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: call.input },
            })
            emit("content_block_stop", { type: "content_block_stop", index: blockIndex })
            return
          }
          case "finish": {
            closeBlocks()
            const stopReason = anthropicStopReason(part.finishReason, outcome.toolCallIds.length > 0)
            if (stopReason === undefined) {
              failWith(`provider finished with ${part.finishReason.unified}${part.finishReason.raw ? ` (${part.finishReason.raw})` : ""}`)
              return
            }
            outcome.stopReason = stopReason
            emit("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: anthropicUsage(part.usage),
            })
            emit("message_stop", { type: "message_stop" })
            finishOutcome()
            controller.close()
            void reader.cancel().catch(() => undefined)
            return
          }
          case "error": {
            failWith("provider reported a stream error")
            return
          }
          // Streamed tool input is only forwarded as a complete, converted call.
          case "tool-input-start":
          case "tool-input-delta":
          case "tool-input-end":
          // Provider-side execution, sources, files, approvals and metadata have
          // no ZCode-executable representation on this wire.
          case "tool-result":
          case "tool-approval-request":
          case "source":
          case "file":
          case "stream-start":
          case "response-metadata":
          case "raw":
            continue
          default:
            continue
        }
      }
    },

    async cancel() {
      outcome.aborted = true
      finishOutcome()
      await reader.cancel().catch(() => undefined)
    },
  })
}

export type GenerateResultLike = {
  content: LanguageModelV3Content[]
  finishReason: LanguageModelV3FinishReason
  usage: LanguageModelV3Usage
}

/** Encode a V3 generate result as an Anthropic Messages JSON body. Throws on an unrepresentable result. */
export function encodeAnthropicMessage(model: string, toolMap: RequestToolMap, result: GenerateResultLike) {
  const content: unknown[] = []
  const toolCallIds: string[] = []
  for (const part of result.content) {
    if (part.type === "text") {
      if (part.text.length > 0) content.push({ type: "text", text: part.text })
    } else if (part.type === "reasoning") {
      content.push({ type: "thinking", thinking: part.text, signature: "" })
    } else if (part.type === "tool-call") {
      if (part.providerExecuted) continue
      const call = toolMap.toNativeCall(part.toolName, part.input)
      let input: unknown
      try {
        input = call.input.trim() === "" ? {} : JSON.parse(call.input)
      } catch {
        throw new ToolMappingError(`${part.toolName} call input is not valid JSON`)
      }
      toolCallIds.push(part.toolCallId)
      content.push({ type: "tool_use", id: part.toolCallId, name: call.name, input })
    }
  }
  const stopReason = anthropicStopReason(result.finishReason, toolCallIds.length > 0)
  if (stopReason === undefined) {
    throw new Error(`provider finished with ${result.finishReason.unified}${result.finishReason.raw ? ` (${result.finishReason.raw})` : ""}`)
  }
  return {
    body: {
      id: messageId(), type: "message", role: "assistant", model, content,
      stop_reason: stopReason, stop_sequence: null, usage: anthropicUsage(result.usage),
    },
    toolCallIds,
    stopReason,
  }
}

/**
 * Aggregate a V3 stream into a generate result (for providers without a usable
 * doGenerate). Like the SSE encoder, stop at the first finish and cancel the
 * remaining source on finish, error, or request abort.
 */
export async function collectStream(parts: ReadableStream<LanguageModelV3StreamPart>, signal?: AbortSignal): Promise<GenerateResultLike> {
  const content: LanguageModelV3Content[] = []
  const texts = new Map<string, { type: "text" | "reasoning"; text: string }>()
  const reader = parts.getReader()
  const cancelSource = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener("abort", cancelSource, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) throw new Error("provider stream ended without a finish")
      const part = next.value
      if (part.type === "text-start" || part.type === "reasoning-start") {
        const entry = { type: part.type === "text-start" ? "text" as const : "reasoning" as const, text: "" }
        texts.set(`${entry.type}:${part.id}`, entry)
        content.push(entry as LanguageModelV3Content)
      } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
        const kind = part.type === "text-delta" ? "text" : "reasoning"
        let entry = texts.get(`${kind}:${part.id}`)
        if (!entry) {
          entry = { type: kind, text: "" }
          texts.set(`${kind}:${part.id}`, entry)
          content.push(entry as LanguageModelV3Content)
        }
        entry.text += part.delta
      } else if (part.type === "tool-call") {
        content.push(part)
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      } else if (part.type === "finish") {
        return { content, finishReason: part.finishReason, usage: part.usage }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelSource)
    // Cancellation releases pending reads immediately. The provider's cleanup
    // promise may itself need the attempt's abort signal to settle.
    cancelSource()
    reader.releaseLock()
  }
}
