import type { PiContextLike, PiExtensionApi, PiSimpleStreamOptions, PiToolResultMessage } from "./pi-provider-types.js"

const ENTRY_TYPE = "ocp-task-result"

type Job = {
  id: string
  agentId?: string
  ownerId?: string
  status: string
  promise: Promise<void>
  resultText?: string
  errorText?: string
}
type JobManager = {
  getAllJobs(filter: { ownerId: string }): Job[]
  watchJobs(ids: string[]): unknown
  unwatchJobs(ids: string[]): unknown
  consumeJobResults(ids: string[]): unknown
  cancel(id: string, filter: { ownerId: string }): unknown
}
type Session = {
  sessionManager: {
    getSessionId(): string
    getEntries(): Array<{ type: string; customType?: string; data?: unknown }>
    appendCustomEntry(type: string, data: unknown): unknown
  }
  asyncJobManager?: JobManager
}
type Ref = { id: string; session?: Session | null }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Recover foreground task results through the public, owner-scoped job API. */
export async function collectOmpTaskResults(
  pi: PiExtensionApi,
  context: PiContextLike,
  options?: PiSimpleStreamOptions,
): Promise<PiContextLike> {
  const receipts = context.messages.filter((message): message is PiToolResultMessage =>
    message.role === "toolResult" && message.toolName === "task" && !message.isError
    && record(message.details) && record(message.details.async) && message.details.async.type === "task",
  )
  if (receipts.length === 0) return context
  let lastAssistant = -1
  context.messages.forEach((message, index) => { if (message.role === "assistant") lastAssistant = index })
  const pending = context.messages.at(-1)?.role === "toolResult" && context.tools?.some(tool => tool.name === "task")
    ? receipts.filter(message => context.messages.indexOf(message) > lastAssistant) : []
  const registry = pi.pi?.AgentRegistry?.global() as { list?: () => Ref[] } | undefined
  const owner = registry?.list?.().find(ref => ref.session?.sessionManager.getSessionId() === options?.sessionId)
  if (!owner?.session) {
    if (pending.length > 0) throw new Error("Delegated task result is unavailable: no owning OMP session")
    return context
  }
  const { sessionManager, asyncJobManager: manager } = owner.session
  const results = new Map<string, PiToolResultMessage>()
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !record(entry.data)) continue
    const result = entry.data.result
    if (record(result) && result.role === "toolResult" && typeof result.toolCallId === "string") {
      results.set(result.toolCallId, result as PiToolResultMessage)
    }
  }
  for (const message of pending) {
    if (results.has(message.toolCallId)) continue
    if (!manager) throw new Error("Delegated task result is unavailable: no OMP job manager")
    const details = message.details as Record<string, unknown>
    const async = details.async as Record<string, unknown>
    const progress = Array.isArray(details.progress) ? details.progress : []
    const agentIds = new Set(progress.flatMap(item => record(item) && typeof item.id === "string" ? [item.id] : []))
    const jobs = manager.getAllJobs({ ownerId: owner.id }).filter(job =>
      job.id === async.jobId || (job.agentId !== undefined && agentIds.has(job.agentId)),
    )
    if (jobs.length === 0) throw new Error("Delegated task result is unavailable: its OMP jobs are no longer retained")
    const ids = jobs.map(job => job.id)
    const cancel = () => { for (const id of ids) manager.cancel(id, { ownerId: owner.id }) }
    options?.signal?.throwIfAborted()
    manager.watchJobs(ids)
    options?.signal?.addEventListener("abort", cancel, { once: true })
    try {
      await Promise.all(jobs.map(job => job.promise))
      options?.signal?.throwIfAborted()
      const failed = jobs.some(job => job.status !== "completed")
      const result: PiToolResultMessage = {
        ...message,
        content: [{ type: "text", text: jobs.map(job => job.status === "completed"
          ? job.resultText ?? "" : job.errorText ?? `Delegated task ${job.id} ${job.status}`).join("\n\n") }],
        isError: failed,
        details: { ...details, async: { ...async, state: failed ? "failed" : "completed" } },
      }
      // Keep the collected outcome after native jobs are evicted or the process
      // restarts. This is a public session custom entry, not a model message.
      sessionManager.appendCustomEntry(ENTRY_TYPE, { result })
      results.set(message.toolCallId, result)
      manager.consumeJobResults(ids)
    } finally {
      options?.signal?.removeEventListener("abort", cancel)
      manager.unwatchJobs(ids)
    }
  }
  return { ...context, messages: context.messages.map(message => message.role === "toolResult"
    ? results.get(message.toolCallId) ?? message : message) }
}
