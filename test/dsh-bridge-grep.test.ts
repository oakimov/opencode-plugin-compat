import { describe, expect, test } from "bun:test"
import { formatOpenCodeGrepResult } from "../packages/dsh-bridge/src/translate/grep.ts"
import { translateGenerateOptionsToPrompt } from "../packages/dsh-bridge/src/translate/context.ts"

describe("DSH grep result in OpenCode's shape", () => {
  test("groups previews under a path header with indented lines", () => {
    expect(formatOpenCodeGrepResult("Found 3 matches\n\n/a/x.ts\nLine 1: one\nLine 3: three\n\n/a/y.ts\nLine 2: two")).toBe(
      "Found 3 matches\n\n/a/x.ts:\n  Line 1: one\n  Line 3: three\n\n/a/y.ts:\n  Line 2: two",
    )
  })

  test("normalizes the singular and capped headers and keeps DSH's recovery footer", () => {
    expect(formatOpenCodeGrepResult("Found 1 match\n\n/a/x.ts\nLine 7: hit")).toBe("Found 1 matches\n\n/a/x.ts:\n  Line 7: hit")
    expect(formatOpenCodeGrepResult("Found 2 of 9 matches\n\n/a/x.ts\nLine 1: a\nLine 2: b\n\n(Full grep result stored at: spill-1.)"))
      .toBe("Found 2 matches (more matches available)\n\n/a/x.ts:\n  Line 1: a\n  Line 2: b\n\n(Full grep result stored at: spill-1.)")
  })

  test("leaves other text and OpenCode-shaped output unchanged", () => {
    for (const text of ["No matches found", "Found 1 matches\n/a/x.ts:\n  Line 1: a", "anything else"]) {
      expect(formatOpenCodeGrepResult(text)).toBe(text)
    }
  })

  test("is applied to grep tool results only", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "default",
      messages: [
        {
          role: "assistant",
          source: { kind: "model" },
          content: [
            { type: "tool-call", id: "g1", name: "grep", arguments: "{\"pattern\":\"a\"}" },
            { type: "tool-call", id: "b1", name: "bash", arguments: "{\"command\":\"echo\"}" },
          ],
        },
        { role: "tool", source: { kind: "tool", callId: "g1" }, toolCallId: "g1", content: [{ type: "text", text: "Found 1 match\n\n/a/x.ts\nLine 1: a" }] },
        { role: "tool", source: { kind: "tool", callId: "b1" }, toolCallId: "b1", content: [{ type: "text", text: "Found 1 match\n\n/a/x.ts\nLine 1: a" }] },
      ],
    })
    const outputs = prompt.flatMap(message => message.role === "tool" ? message.content.map(part => (part as { output: { value: string } }).output.value) : [])
    expect(outputs).toEqual(["Found 1 matches\n\n/a/x.ts:\n  Line 1: a", "Found 1 match\n\n/a/x.ts\nLine 1: a"])
  })
})
