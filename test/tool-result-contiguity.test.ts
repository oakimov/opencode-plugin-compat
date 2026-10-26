import { describe, expect, test } from "bun:test"
import { ensureToolResultContiguity } from "../packages/opencode-loader/src/tool-result-contiguity.ts"

describe("ensureToolResultContiguity", () => {
  test("notes before the first result and unknown roles stay in place", () => {
    const prompt = [
      { role: "assistant", content: [] },
      { role: "system", content: "before" },
      { role: "tool", content: [] },
      { role: "system", content: "middle" },
      { role: "extension", content: "barrier" },
      { role: "tool", content: [] },
      { role: "system", content: "after" },
    ]
    expect(ensureToolResultContiguity(prompt)).toEqual(prompt)
    expect(ensureToolResultContiguity([])).toEqual([])
  })

  test("moves system notes that sit between a step's tool results", () => {
    const out = ensureToolResultContiguity([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a" }, { type: "tool-call", toolCallId: "b" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a" }] },
      { role: "system", content: "note" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "b" }] },
    ])
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "system"])
    expect(out[3]).toMatchObject({ role: "system", content: "note" })
  })

  test("does not move a user message inside the window", () => {
    const out = ensureToolResultContiguity([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a" }] },
      { role: "user", content: [{ type: "text", text: "steer" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "b" }] },
    ])
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user", "tool"])
  })

  test("leaves already-contiguous results alone", () => {
    const prompt = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a" }] },
      { role: "system", content: "after" },
    ]
    expect(ensureToolResultContiguity(prompt)).toEqual(prompt)
  })
})
