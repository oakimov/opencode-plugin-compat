import { describe, expect, test } from "bun:test"
import { installCursorPlanKickoff, pendingPlanKickoff } from "../packages/dsh-bridge/src/cursor-plan-kickoff.ts"

const review = "cursor_s1_900001"
const mirror = "cursor_s1_900002"

function assistant(...content: unknown[]) {
  return { type: "assistant/message", data: { message: { role: "assistant", content, source: { kind: "model", provider: "cursor-opencode" } } } }
}
function call(callId: string, name: string) {
  return { type: "tool/call", data: { callId, name, arguments: "{}" } }
}
function result(toolCallId: string, text: string, isError = false) {
  return { type: "tool/result", data: { message: { role: "tool", toolCallId, isError, content: [{ type: "text", text }] } } }
}

// Event order DSH recorded for a Cursor CreatePlan approved through `exit_plan_mode`.
const approvedThenStopped = [
  { type: "request/header", data: { header: { config: { provider: "cursor-opencode", model: "default" } } } },
  { type: "turn/start", data: { turn: 2 } },
  { type: "user/message", data: { content: [{ type: "text", text: "continue" }], source: { kind: "user" } } },
  assistant({ type: "reasoning", text: "Creating a plan." }, { type: "tool-call", id: review, name: "exit_plan_mode", arguments: "{}" }),
  call(review, "exit_plan_mode"),
  result(review, "Plan approved — plan mode exited; carry out the plan starting with your next step."),
  { type: "plan/mode", data: { active: false } },
  assistant({ type: "tool-call", id: mirror, name: "todo_write", arguments: "{}" }),
  call(mirror, "todo_write"),
  result(mirror, "Updated todo list: 2 pending, 0 in progress, 1 completed."),
  assistant(),
]

describe("Cursor plan kickoff on DSH", () => {
  test("an approved review followed only by the todo mirror still needs its build turn", () => {
    expect(pendingPlanKickoff(approvedThenStopped)).toBe(review)
  })

  test("no kickoff once work started, after a rejection, or for an earlier turn", () => {
    expect(pendingPlanKickoff([...approvedThenStopped, assistant({ type: "tool-call", id: "w1", name: "write", arguments: "{}" })])).toBeUndefined()
    expect(pendingPlanKickoff([...approvedThenStopped, assistant({ type: "text", text: "Writing note.txt now." })])).toBeUndefined()
    const rejected = approvedThenStopped.map(event => event === approvedThenStopped[5] ? result(review, "Plan not approved", true) : event)
    expect(pendingPlanKickoff(rejected)).toBeUndefined()
    expect(pendingPlanKickoff([...approvedThenStopped, { type: "turn/start", data: { turn: 3 } }, assistant()])).toBeUndefined()
  })

  test("steers one build instruction per approval on a Cursor route only", async () => {
    let listener: ((payload: unknown) => Promise<void> | void) | undefined
    installCursorPlanKickoff((event, registered) => {
      if (event === "agent/turn-stopping") listener = registered as never
    }, new Set(["cursor-opencode"]))
    const steered: unknown[] = []
    const agent = (events: readonly unknown[]) => ({
      id: "session-a",
      options: { provider: "deepseek-official" },
      session: { snapshotEvents: () => events },
      steer: (message: unknown) => { steered.push(message) },
    })
    const logs: unknown[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")) }
    try {
      const otherRoute = approvedThenStopped.map((event, index) => index === 0
        ? { type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "x" } } } }
        : event)
      await listener!({ agent: agent(otherRoute) })
      expect(steered).toHaveLength(0)
      await listener!({ agent: agent(approvedThenStopped) })
      await listener!({ agent: agent(approvedThenStopped) })
    } finally {
      console.log = original
    }
    expect(steered).toHaveLength(1)
    expect(steered[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Plan mode has ended. Continue with the approved work." }],
      source: { kind: "dsh-bridge" },
    })
    expect(logs).toEqual(["dsh-bridge: starting approved plan sessionId=session-a"])
  })
})
