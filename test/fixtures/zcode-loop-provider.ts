/**
 * An unmodified-style OpenCode provider package with a deterministic native
 * read / follow-up loop and a real `doGenerate`, standing in for an arbitrary
 * third-party provider. Only standard conventions: a `createXxx` AI-SDK
 * factory and a classic plugin factory with a `config` catalog (no auth).
 *
 * Every call's options are recorded on `globalThis[CALLS]` so tests can assert
 * exactly what the bridge handed the provider.
 */
const CALLS = Symbol.for("ocp.test.zcode-loop-provider.calls")
export const LOOP_CALL_ID = "call_loop_1"

type Options = {
  prompt: Array<{ role: string; content: unknown }>
  providerOptions?: Record<string, Record<string, unknown>>
  tools?: Array<{ name: string }>
  headers?: Record<string, string | undefined>
  abortSignal?: AbortSignal
}

export function recordedCalls(): Options[] {
  const store = globalThis as unknown as Record<symbol, Options[]>
  return (store[CALLS] ??= [])
}

const usage = {
  inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function toolResult(options: Options): string | undefined {
  for (const message of options.prompt) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ toolCallId?: string; output?: { type: string; value?: unknown } }>) {
      if (part.toolCallId === LOOP_CALL_ID) return String(part.output?.value ?? "")
    }
  }
  return undefined
}

function decide(modelId: string, options: Options) {
  const result = toolResult(options)
  if (result !== undefined) return { text: `FINAL:${result}` }
  if (modelId !== "plain" && options.tools?.some(tool => tool.name === "read")) {
    return { call: { toolCallId: LOOP_CALL_ID, toolName: "read", input: JSON.stringify({ filePath: "/tmp/ocp-loop.txt", offset: 1, limit: 5 }) } }
  }
  return { text: "plain reply" }
}

export function createLoop(options: Record<string, unknown> = {}) {
  return {
    options,
    languageModel(modelId: string) {
      return {
        specificationVersion: "v3",
        provider: "loop",
        modelId,
        supportedUrls: {},
        async doGenerate(call: Options) {
          recordedCalls().push(call)
          const next = decide(modelId, call)
          return {
            content: next.call ? [{ type: "tool-call", ...next.call }] : [{ type: "text", text: next.text! }],
            finishReason: next.call ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          }
        },
        async doStream(call: Options) {
          recordedCalls().push(call)
          if (modelId === "slow") {
            // Holds the stream open until the bridge cancels it.
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "text-start", id: "t" })
                  controller.enqueue({ type: "text-delta", id: "t", delta: "thinking…" })
                  call.abortSignal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
                },
              }),
            }
          }
          if (modelId === "error-stream") {
            // Emits an error part, then would keep running until cancelled.
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "text-start", id: "t" })
                  controller.enqueue({ type: "error", error: new Error("upstream exploded") })
                },
              }),
            }
          }
          if (modelId === "truncated") {
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: "text-start", id: "t" })
                  controller.enqueue({ type: "text-delta", id: "t", delta: "partial" })
                  controller.close()
                },
              }),
            }
          }
          const next = decide(modelId, call)
          return {
            stream: new ReadableStream({
              start(controller) {
                if (next.call) {
                  controller.enqueue({ type: "tool-input-start", id: next.call.toolCallId, toolName: "read" })
                  controller.enqueue({ type: "tool-input-delta", id: next.call.toolCallId, delta: next.call.input })
                  controller.enqueue({ type: "tool-input-end", id: next.call.toolCallId })
                  controller.enqueue({ type: "tool-call", ...next.call })
                  controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage })
                } else {
                  controller.enqueue({ type: "text-start", id: "t" })
                  controller.enqueue({ type: "text-delta", id: "t", delta: next.text! })
                  controller.enqueue({ type: "text-end", id: "t" })
                  controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage })
                }
                controller.close()
              },
            }),
          }
        },
      }
    },
  }
}

export async function LoopPlugin() {
  return {
    async config(config: { provider?: Record<string, unknown> }) {
      config.provider ??= {}
      config.provider.loop = {
        name: "Loop",
        models: {
          "loop-1": { name: "Loop One", limit: { context: 64_000, output: 4_000 }, modalities: { input: ["text"], output: ["text"] }, options: { wireModel: "loop-1-wire" } },
          "error-stream": { name: "Error stream" },
          // Published ids outside the operator alias pattern stay servable.
          "_model": { name: "Underscore" },
          "model+extended": { name: "Plus" },
          plain: { name: "Plain" },
          slow: { name: "Slow" },
          truncated: { name: "Truncated" },
        },
      }
    },
  }
}

export default LoopPlugin
