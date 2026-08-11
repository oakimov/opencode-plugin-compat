/**
 * `runV3StreamToPi` — AI-SDK V3 `doStream` parts → Pi `AssistantMessageEvent`s
 * pushed against one mutate-in-place `partial`. `stream.ts` only ever
 * `import type`s from `@oh-my-pi/pi-ai`, so a hand-rolled fake stream (same
 * shape as `AssistantMessageEventStream`: push/end/fail/result/asyncIterator)
 * is enough — no real or mocked package needed.
 */
import { describe, expect, test } from "bun:test"
import { emptyUsage, runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"

class FakeAssistantMessageEventStream {
  events: unknown[] = []
  private settled = false
  private resolveResult!: (v: unknown) => void
  private rejectResult!: (e: unknown) => void
  private resultPromise: Promise<unknown>

  constructor() {
    this.resultPromise = new Promise((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
  }

  push(event: { type: string; message?: unknown; error?: unknown }) {
    this.events.push(event)
    if (event.type === "done" && !this.settled) {
      this.settled = true
      this.resolveResult(event.message)
    } else if (event.type === "error" && !this.settled) {
      this.settled = true
      this.resolveResult(event.error)
    }
  }

  end() {}
  fail(err: unknown) {
    if (!this.settled) {
      this.settled = true
      this.rejectResult(err)
    }
  }
  result() {
    return this.resultPromise
  }
  async *[Symbol.asyncIterator]() {
    yield* this.events as never
  }
}

const MODEL = {
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
  api: "acme-bridge",
  provider: "acme",
  baseUrl: "https://example.com",
  reasoning: true,
  input: ["text"] as const,
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never

async function* v3Parts(parts: unknown[]) {
  for (const p of parts) yield p
}

describe("runV3StreamToPi", () => {
  test("streams text start/delta/end and finishes with stop", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hel" },
        { type: "text-delta", id: "t1", delta: "lo" },
        { type: "text-end", id: "t1" },
        { type: "finish", usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }, finishReason: { unified: "stop", raw: "stop" } },
      ]) as never,
      piStream: piStream as never,
    })

    const types = piStream.events.map((e: never) => (e as { type: string }).type)
    expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"])

    const done = piStream.events.at(-1) as { type: "done"; reason: string; message: { content: unknown[]; stopReason: string; usage: { input: number; output: number; totalTokens: number; cost: { total: number } } } }
    expect(done.reason).toBe("stop")
    expect(done.message.stopReason).toBe("stop")
    expect(done.message.content).toEqual([{ type: "text", text: "Hello" }])
    // cost = input 10/1e6*1 + output 2/1e6*2 = 0.00001 + 0.000004
    expect(done.message.usage.input).toBe(10)
    expect(done.message.usage.output).toBe(2)
    expect(done.message.usage.totalTokens).toBe(12)
    expect(done.message.usage.cost.total).toBeCloseTo(0.000014, 10)
  })

  test("streams reasoning start/delta/end alongside text", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "thinking..." },
        { type: "reasoning-end", id: "r1" },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "stop", raw: "stop" } },
      ]) as never,
      piStream: piStream as never,
    })
    const done = piStream.events.at(-1) as { message: { content: unknown[] } }
    expect(done.message.content).toEqual([{ type: "thinking", thinking: "thinking..." }])
  })

  test("a single-shot tool-call part (no preceding tool-input-start) opens+closes in one step", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "call_1", toolName: "read", input: '{"path":"a.ts"}' },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })
    const types = piStream.events.map((e: never) => (e as { type: string }).type)
    expect(types).toEqual(["start", "toolcall_start", "toolcall_end", "done"])

    const toolcallEnd = piStream.events[2] as { toolCall: { id: string; name: string; arguments: unknown } }
    expect(toolcallEnd.toolCall).toEqual({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } })

    const done = piStream.events.at(-1) as { reason: string; message: { stopReason: string } }
    expect(done.reason).toBe("toolUse")
    expect(done.message.stopReason).toBe("toolUse")
  })

  test("streamed tool-input-start/delta/end followed by the terminal tool-call part reuses the same block", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-input-start", id: "call1", toolName: "read" },
        { type: "tool-input-delta", id: "call1", delta: '{"path":' },
        { type: "tool-input-delta", id: "call1", delta: '"a.ts"}' },
        { type: "tool-input-end", id: "call1" },
        { type: "tool-call", toolCallId: "call1", toolName: "read", input: '{"path":"a.ts"}' },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })
    const types = piStream.events.map((e: never) => (e as { type: string }).type)
    expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"])
    // Exactly one block was opened for the whole call (start/delta/end/tool-call all share contentIndex 0).
    const done = piStream.events.at(-1) as { message: { content: unknown[] } }
    expect(done.message.content).toHaveLength(1)
  })

  test("malformed tool-call JSON input degrades to empty arguments instead of throwing", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "id1", toolName: "read", input: "{not json" },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })
    const done = piStream.events.at(-1) as { message: { content: Array<{ arguments: unknown }> } }
    expect(done.message.content[0]!.arguments).toEqual({})
  })

  test("finish with unified error pushes a Pi error event, not done", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([{ type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "error", raw: "server_error" } }]) as never,
      piStream: piStream as never,
    })
    const last = piStream.events.at(-1) as { type: string; error: { stopReason: string } }
    expect(last.type).toBe("error")
    expect(last.error.stopReason).toBe("error")
  })

  test("an explicit V3 error part pushes a Pi error event with the message", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([{ type: "error", error: new Error("network blip") }]) as never,
      piStream: piStream as never,
    })
    const last = piStream.events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(last.type).toBe("error")
    expect(last.error.errorMessage).toBe("network blip")
  })

  test("a stream that ends without finish/error settles result() as an error instead of hanging", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({ model: MODEL, v3Stream: v3Parts([{ type: "text-start", id: "t1" }]) as never, piStream: piStream as never })
    const last = piStream.events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(last.type).toBe("error")
    expect(last.error.errorMessage).toMatch(/ended without a finish/)
    await expect(piStream.result()).resolves.toBeDefined()
  })

  test("a thrown error mid-iteration is caught and surfaced as a Pi error event", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    async function* throwing() {
      yield { type: "text-start", id: "t1" }
      throw new Error("transport reset")
    }
    await runV3StreamToPi({ model: MODEL, v3Stream: throwing() as never, piStream: piStream as never })
    const last = piStream.events.at(-1) as { type: string; error: { errorMessage: string } }
    expect(last.type).toBe("error")
    expect(last.error.errorMessage).toBe("transport reset")
  })
})

describe("emptyUsage", () => {
  test("all-zero usage with a zeroed cost breakdown", () => {
    expect(emptyUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
  })
})
