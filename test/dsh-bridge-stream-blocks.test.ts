import { describe, expect, test } from "bun:test"
import { v3StreamToDshChunks } from "../packages/dsh-bridge/src/translate/stream.ts"

async function collect(
  parts: Array<Record<string, unknown>>,
): Promise<Array<{ type: string; index?: number; blockType?: string }>> {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never)
      controller.close()
    },
  })
  const out: Array<{ type: string; index?: number; blockType?: string }> = []
  for await (const chunk of v3StreamToDshChunks(stream as never)) {
    out.push({
      type: chunk.type,
      ...("index" in chunk ? { index: chunk.index as number } : {}),
      ...("blockType" in chunk ? { blockType: chunk.blockType as string } : {}),
    })
  }
  return out
}

describe("v3StreamToDshChunks per-id text blocks", () => {
  test("reasoning blocks reopen for repeated ids and retain distinct parallel ids", async () => {
    const chunks = await collect([
      { type: "reasoning-start", id: "a" },
      { type: "reasoning-delta", id: "a", delta: "first" },
      { type: "reasoning-start", id: "b" },
      { type: "reasoning-delta", id: "b", delta: "second" },
      { type: "reasoning-end", id: "a" },
      { type: "reasoning-start", id: "a" },
      { type: "reasoning-delta", id: "a", delta: "third" },
      { type: "reasoning-end", id: "a" },
      { type: "reasoning-end", id: "b" },
      { type: "reasoning-delta", id: "c", delta: "delta only" },
      { type: "finish", finishReason: "stop" },
    ])
    const starts = chunks.filter(c => c.type === "block-start" && c.blockType === "reasoning")
    expect(starts.map(c => c.index)).toEqual([0, 1, 2, 3])
    expect(chunks.filter(c => c.type === "block-end").map(c => c.index)).toEqual([0, 2, 1, 3])
  })

  test("reopens text under a new index after a tool call closes the first text block", async () => {
    const chunks = await collect([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "before" },
      { type: "text-end", id: "t1" },
      { type: "tool-input-start", id: "c1", toolName: "read" },
      { type: "tool-input-delta", id: "c1", delta: "{}" },
      { type: "tool-input-end", id: "c1", toolName: "read" },
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: {} },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "after" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    const starts = chunks.filter((c) => c.type === "block-start" && c.blockType === "text")
    expect(starts.length).toBe(2)
    expect(starts[0]!.index).not.toBe(starts[1]!.index)
  })
})
