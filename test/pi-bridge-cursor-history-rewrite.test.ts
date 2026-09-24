import { describe, expect, test } from "bun:test"
import {
  markCursorHistoryRewrite,
  registerCursorHistoryRewriteListener,
  takeCursorHistoryRewrite,
} from "../packages/pi-bridge/src/cursor-history-rewrite.ts"

describe("Cursor Pi-family history rewrite", () => {
  test("survives no-tool lifecycle calls and resets only the affected session", () => {
    markCursorHistoryRewrite("rewritten")
    expect(takeCursorHistoryRewrite("rewritten", false)).toBe(false)
    expect(takeCursorHistoryRewrite("other", true)).toBe(false)
    expect(takeCursorHistoryRewrite("rewritten", true)).toBe(true)
    expect(takeCursorHistoryRewrite("rewritten", true)).toBe(false)
  })

  test("records the compacted session from the host event", () => {
    let handler: ((...args: unknown[]) => unknown) | undefined
    registerCursorHistoryRewriteListener((event, callback) => {
      expect(event).toBe("session_compact")
      handler = callback
    })
    handler?.({ type: "session_compact" }, { sessionManager: { getSessionId: () => "event-session" } })
    expect(takeCursorHistoryRewrite("event-session", true)).toBe(true)
  })
})
