import { afterEach, describe, expect, test } from "bun:test"
import { piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt } from "../packages/pi-bridge/src/translate/context.ts"
import {
  registerHiddenHostNoteListener,
  rememberHiddenHostNotes,
  resetHiddenHostNotes,
} from "../packages/pi-bridge/src/host-notes.ts"

const REMINDER = "<system-reminder>Plan mode is active.</system-reminder>"

describe("pi hidden extension notes", () => {
  afterEach(() => resetHiddenHostNotes())

  test("a hidden note between a tool call and its result is a host note, not a new user turn", () => {
    rememberHiddenHostNotes([
      { role: "custom", customType: "plan-mode-reminder", display: false, timestamp: 22, content: REMINDER },
    ])
    const prompt = translateContextToPrompt({
      messages: [
        { role: "user", content: "plan it", timestamp: 10 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "cursor_plan_stage", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 20,
        } as never,
        { role: "user", content: [{ type: "text", text: REMINDER }], timestamp: 22 },
        { role: "toolResult", toolCallId: "call_1", toolName: "cursor_plan_stage", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 25 } as never,
      ],
    }, undefined, piProfile())
    expect(prompt.map(message => message.role)).toEqual(["user", "assistant", "system", "tool"])
    expect(prompt[2]).toEqual({ role: "system", content: REMINDER })
  })

  test("a hidden note after a tool result is a host note, so the tool result stays the live tail", () => {
    rememberHiddenHostNotes([
      { role: "custom", customType: "plan-mode-reminder", display: false, timestamp: 30, content: REMINDER },
      { role: "custom", customType: "shown", display: true, timestamp: 40, content: "visible" },
    ])
    const prompt = translateContextToPrompt({
      messages: [
        { role: "user", content: "plan it", timestamp: 10 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "plan_enter", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 20,
        } as never,
        { role: "toolResult", toolCallId: "call_1", toolName: "plan_enter", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 25 } as never,
        // pi's convertToLlm turned both custom messages into user messages.
        { role: "user", content: [{ type: "text", text: REMINDER }], timestamp: 30 },
        { role: "user", content: [{ type: "text", text: "visible" }], timestamp: 40 },
      ],
    }, undefined, piProfile())
    expect(prompt.map(message => message.role)).toEqual(["user", "assistant", "tool", "system", "user"])
    expect(prompt[3]).toEqual({ role: "system", content: REMINDER })
  })

  test("a hidden message that starts a turn stays a user turn, so the original request is not replayed", () => {
    rememberHiddenHostNotes([{ role: "custom", display: false, timestamp: 50, content: "Plan mode is OFF." }])
    const prompt = translateContextToPrompt({
      messages: [
        { role: "user", content: "plan it, then implement", timestamp: 10 },
        { role: "assistant", content: [{ type: "text", text: "Waiting for the instructions." }], stopReason: "stop", timestamp: 40 } as never,
        { role: "user", content: [{ type: "text", text: "Plan mode is OFF." }], timestamp: 50 },
      ],
    }, undefined, piProfile())
    expect(prompt.map(message => message.role)).toEqual(["user", "assistant", "user"])
  })

  test("a user message is never mistaken for a note: timestamp and text must both match", () => {
    rememberHiddenHostNotes([{ role: "custom", display: false, timestamp: 30, content: REMINDER }])
    const prompt = translateContextToPrompt({
      messages: [{ role: "user", content: [{ type: "text", text: REMINDER }], timestamp: 31 }],
    }, undefined, piProfile())
    expect(prompt.map(message => message.role)).toEqual(["user"])
  })

  test("records notes from pi's context event", () => {
    const handlers: Array<(event: unknown) => unknown> = []
    registerHiddenHostNoteListener((event, handler) => { if (event === "context") handlers.push(handler) })
    handlers[0]!({ messages: [{ role: "custom", display: false, timestamp: 5, content: [{ type: "text", text: "note" }] }] })
    const prompt = translateContextToPrompt({
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 1 } as never,
        { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: 2 } as never,
        { role: "user", content: "note", timestamp: 5 },
      ],
    }, undefined, piProfile())
    expect(prompt.at(-1)).toEqual({ role: "system", content: "note" })
  })
})
