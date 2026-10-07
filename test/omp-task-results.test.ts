import { expect, test } from "bun:test"
import { collectOmpTaskResults } from "../packages/pi-bridge/src/omp-task-results.ts"
import type { PiContextLike, PiExtensionApi, PiToolResultMessage } from "../packages/pi-bridge/src/pi-provider-types.ts"

function fixture() {
  const done = Promise.withResolvers<void>()
  const entries: Array<{ type: string; customType: string; data: unknown }> = []
  const actions: string[] = []
  const job = { id: "job", ownerId: "parent", agentId: "child", status: "running", promise: done.promise, resultText: "CHILD_RESULT" }
  const manager = {
    getAllJobs: () => [job],
    watchJobs: () => actions.push("watch"),
    unwatchJobs: () => actions.push("unwatch"),
    consumeJobResults: () => actions.push("consume"),
    cancel: () => { actions.push("cancel"); job.status = "cancelled"; done.resolve() },
  }
  const session = { asyncJobManager: manager, sessionManager: {
    getSessionId: () => "session", getEntries: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } }
  const pi: PiExtensionApi = { registerProvider() {}, pi: { AgentRegistry: { global: () => ({ list: () => [{ id: "parent", session }] }) } } }
  const receipt: PiToolResultMessage = { role: "toolResult", toolName: "task", toolCallId: "call", isError: false,
    content: [{ type: "text", text: "Spawned child" }], details: { progress: [{ id: "child" }], async: { type: "task", state: "running", jobId: "job" } } }
  const context: PiContextLike = { tools: [{ name: "task", description: "Task", parameters: {} }], messages: [receipt] }
  return { done, entries, actions, job, manager, session, pi, context }
}

test("OMP waits for foreground task output once and persists it across eviction/restart", async () => {
  const f = fixture()
  let completed = false
  const collected = collectOmpTaskResults(f.pi, f.context, { sessionId: "session" }).then(result => { completed = true; return result })
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(f.actions).toEqual(["watch"])
  f.job.status = "completed"
  f.done.resolve()
  const result = await collected
  expect((result.messages[0] as PiToolResultMessage).content).toEqual([{ type: "text", text: "CHILD_RESULT" }])
  expect(f.context.messages[0]).not.toBe(result.messages[0])
  expect(f.actions).toEqual(["watch", "consume", "unwatch"])
  expect(f.entries).toHaveLength(1)
  f.manager.getAllJobs = () => []
  expect(await collectOmpTaskResults(f.pi, f.context, { sessionId: "session" })).toEqual(result)
  expect(f.entries).toHaveLength(1)
})

test("OMP foreground task cancellation cancels only its jobs and releases the watch", async () => {
  const f = fixture()
  const abort = new AbortController()
  const result = collectOmpTaskResults(f.pi, f.context, { sessionId: "session", signal: abort.signal })
  abort.abort()
  await expect(result).rejects.toThrow()
  expect(f.actions).toEqual(["watch", "cancel", "unwatch"])
  expect(f.entries).toHaveLength(0)
})

test("OMP does not collect old receipts on a new user turn or a tool-less lifecycle", async () => {
  const f = fixture()
  f.session.sessionManager.getSessionId = () => "unrelated"
  const next: PiContextLike = { ...f.context, messages: [...f.context.messages, { role: "user", content: "Next request" }] }
  expect(await collectOmpTaskResults(f.pi, next, { sessionId: "session" })).toBe(next)
  expect(await collectOmpTaskResults(f.pi, { ...f.context, tools: [] })).toEqual({ ...f.context, tools: [] })
  expect(f.actions).toEqual([])
})

test("OMP child failures remain failed task results", async () => {
  const f = fixture()
  f.job.status = "failed"
  Object.assign(f.job, { errorText: "Child failed" })
  f.done.resolve()
  const result = await collectOmpTaskResults(f.pi, f.context, { sessionId: "session" })
  expect(result.messages[0]).toMatchObject({ isError: true, content: [{ type: "text", text: "Child failed" }] })
})
