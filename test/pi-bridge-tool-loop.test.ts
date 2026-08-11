/**
 * End-to-end append-to-history round trip: Pi's generic custom-provider loop
 * calls `streamSimple` once per model turn with the FULL history, tool
 * results arriving as trailing `role:"toolResult"` Context messages on the
 * next call (confirmed against oh-my-pi 17.2.12's `agent-loop.ts` — see
 * `bridge.ts`'s module doc). This composes `runV3StreamToPi` (turn 1 output)
 * with `translateContextToPrompt` (turn 2 input) the way Pi's own loop would,
 * proving a `toolCallId` an AI-SDK provider emits on turn 1 survives the
 * round trip unmodified into turn 2's tool-result prompt part — any provider
 * whose own continuation logic keys off that id (as `cursor-opencode-provider`'s
 * does, for example) depends on this exact match.
 */
import { describe, expect, test } from "bun:test"
import { aiSdkHeadersFromPi } from "../packages/pi-bridge/src/bridge.ts"
import { translateContextToPrompt } from "../packages/pi-bridge/src/translate/context.ts"
import { runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"

class FakeAssistantMessageEventStream {
  events: unknown[] = []
  push(event: unknown) {
    this.events.push(event)
  }
  end() {}
  fail() {}
  async result() {
    return (this.events.find((e: never) => (e as { type: string }).type === "done") as { message: unknown } | undefined)?.message
  }
  async *[Symbol.asyncIterator]() {
    yield* this.events as never
  }
}

const MODEL = {
  id: "acme-large",
  name: "Acme Large",
  api: "acme-bridge",
  provider: "acme",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never

async function* v3Parts(parts: unknown[]) {
  for (const p of parts) yield p
}

describe("tool loop round trip (append-to-history)", () => {
  test("carries Pi's session identity into the OpenCode provider without overriding explicit affinity", () => {
    expect(aiSdkHeadersFromPi({ sessionId: "omp-parent-123", headers: { "x-client": "omp" } })).toEqual({
      "x-client": "omp",
      "x-opencode-session": "omp-parent-123",
    })
    expect(aiSdkHeadersFromPi({
      sessionId: "ignored",
      headers: { "X-Session-Affinity": "operator-choice" },
    })).toEqual({ "X-Session-Affinity": "operator-choice" })
  })

  test("a toolCallId emitted on turn 1 survives into turn 2's tool-result prompt part", async () => {
    const TOOL_CALL_ID = "provider_session123_1"

    // Turn 1: Pi calls streamSimple with the user's question; the model calls a tool.
    const turn1Stream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: TOOL_CALL_ID, toolName: "read", input: '{"path":"README.md"}' },
        { type: "finish", usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: turn1Stream as never,
    })

    const assistantMessage = await turn1Stream.result()
    expect((assistantMessage as { content: Array<{ id: string }> }).content[0]!.id).toBe(TOOL_CALL_ID)

    // Pi's agent-loop appends the assistant turn, executes the tool, and
    // appends a ToolResultMessage with the same id (agent-loop.ts:2391-2401).
    const context = {
      messages: [
        { role: "user", content: "what's in the readme?", timestamp: 1 },
        assistantMessage,
        {
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
          toolName: "read",
          content: [{ type: "text", text: "# hello world" }],
          isError: false,
          timestamp: 2,
        },
      ],
    }

    // Turn 2: Pi calls streamSimple again with the full updated history.
    const prompt = translateContextToPrompt(context as never)

    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: TOOL_CALL_ID, toolName: "read", input: { path: "README.md" } }],
    })
    const toolMessage = prompt[2] as { role: string; content: Array<{ toolCallId: string; toolName: string; output: { type: string; value: string } }> }
    expect(toolMessage.role).toBe("tool")
    expect(toolMessage.content[0]!.toolCallId).toBe(TOOL_CALL_ID)
    expect(toolMessage.content[0]!.output).toEqual({ type: "text", value: "# hello world" })
  })
})
