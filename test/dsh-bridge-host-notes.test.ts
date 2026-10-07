import { describe, expect, test } from "bun:test"
import { lowerCursorTrailingHostNotes } from "../packages/dsh-bridge/src/cursor-host-notes.ts"
import { translateGenerateOptionsToPrompt, type DshMessage } from "../packages/dsh-bridge/src/translate/context.ts"

const call: DshMessage = {
  role: "assistant",
  source: { kind: "model" },
  content: [{ type: "tool-call", id: "c1", name: "plan_enter", arguments: "{}" }],
}
const result: DshMessage = {
  role: "tool",
  source: { kind: "tool", callId: "c1" },
  toolCallId: "c1",
  content: [{ type: "text", text: "Plan mode selected." }],
}
// Shapes recorded by DSH in a live session (seq 188 and 215).
const planNotice: DshMessage = {
  role: "user",
  source: { kind: "plan-mode", form: "notice", summary: "The user switched this session to plan mode." },
  content: [{ type: "text", text: "The user switched this session to plan mode." }],
}
const timeSnapshot: DshMessage = {
  role: "user",
  source: { kind: "time-context", form: "snapshot", sections: [] },
  content: [{ type: "text", text: "Time sampled while preparing turn 5, step 6: 2026-10-06T09:52:13+02:00" }],
}
const human: DshMessage = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "continue" }] }

function lowered(messages: DshMessage[]): DshMessage[] {
  return lowerCursorTrailingHostNotes({ provider: "cursor-opencode", model: "default", messages }).messages
}

describe("Cursor trailing DSH host notes", () => {
  test("host notes after a tool result become OpenCode system updates", () => {
    const out = lowered([call, result, planNotice, timeSnapshot])
    expect(out.slice(0, 2)).toEqual([call, result])
    expect(out.slice(2).map(message => message.content)).toEqual([
      [{ type: "text", text: "<system-update>\nThe user switched this session to plan mode.\n</system-update>" }],
      [{ type: "text", text: "<system-update>\nTime sampled while preparing turn 5, step 6: 2026-10-06T09:52:13+02:00\n</system-update>" }],
    ])
    const prompt = translateGenerateOptionsToPrompt({ provider: "cursor-opencode", model: "default", messages: out })
    expect(prompt.map(message => message.role)).toEqual(["assistant", "tool", "user", "user"])
  })

  test("a person's message, or notes after one, stay as they are", () => {
    for (const messages of [
      [call, result, human],
      [call, result, human, timeSnapshot],
      [human, timeSnapshot],
      [timeSnapshot],
    ]) expect(lowered(messages)).toBe(messages)
  })
})
