import type { HashlinePatchMeta } from "./hashline-overlap.js"

/** Default gather window for parallel same-tag hashline tool calls in one model turn. */
export const HASHLINE_COALESCE_WINDOW_MS = 25

export type HashlineCoalesceMember = {
  input: string
  meta: HashlinePatchMeta
  signal?: AbortSignal
}

export type HashlineCoalesceApply = (
  mergedInput: string,
  members: readonly HashlineCoalesceMember[],
) => Promise<unknown>

type PendingMember = HashlineCoalesceMember & {
  apply: HashlineCoalesceApply
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  onAbort?: () => void
}

type Batch = {
  key: string
  members: PendingMember[]
  timer: ReturnType<typeof setTimeout> | undefined
  flushing: boolean
}

const batches = new Map<string, Batch>()
let windowMs = HASHLINE_COALESCE_WINDOW_MS

export function hashlineCoalesceKey(meta: HashlinePatchMeta): string | undefined {
  if (!meta.path || !meta.tag) return undefined
  return `${meta.path}#${meta.tag}`
}

export function resetHashlineCoalesce(): void {
  for (const batch of batches.values()) {
    if (batch.timer !== undefined) clearTimeout(batch.timer)
    for (const member of batch.members) {
      if (member.onAbort && member.signal) member.signal.removeEventListener("abort", member.onAbort)
      member.reject(new Error("hashline coalesce batch cleared"))
    }
  }
  batches.clear()
}

/** Test-only: override the gather window. `0` flushes on the next macrotask. */
export function setHashlineCoalesceWindowMsForTests(ms: number): void {
  windowMs = Math.max(0, ms)
}

function scheduleFlush(batch: Batch): void {
  if (batch.timer !== undefined || batch.flushing) return
  batch.timer = setTimeout(() => {
    batch.timer = undefined
    void flushBatch(batch)
  }, windowMs)
}

function detach(member: PendingMember): void {
  if (member.onAbort && member.signal) member.signal.removeEventListener("abort", member.onAbort)
}

function removeMember(batch: Batch, member: PendingMember): void {
  const index = batch.members.indexOf(member)
  if (index < 0) return
  batch.members.splice(index, 1)
  detach(member)
  if (batch.members.length === 0 && !batch.flushing) {
    if (batch.timer !== undefined) clearTimeout(batch.timer)
    batches.delete(batch.key)
  }
}

async function flushBatch(batch: Batch): Promise<void> {
  if (batch.flushing) return
  batch.flushing = true
  if (batch.timer !== undefined) {
    clearTimeout(batch.timer)
    batch.timer = undefined
  }
  batches.delete(batch.key)

  const members = batch.members.splice(0, batch.members.length)
  for (const member of members) detach(member)
  if (members.length === 0) return

  const aborted = members.find(member => member.signal?.aborted)
  if (aborted) {
    const error = aborted.signal!.reason ?? new Error("hashline coalesce aborted")
    for (const member of members) member.reject(error)
    return
  }

  const mergedInput = members.map(member => member.input.replace(/\s+$/, "")).join("\n")
  const leader = members[0]!
  try {
    const result = await leader.apply(mergedInput, members)
    for (const member of members) member.resolve(result)
  } catch (error) {
    for (const member of members) member.reject(error)
  }
}

/**
 * Join parallel hashline calls that share the same `[path#tag]` into one host
 * apply. Line anchors in a multi-section call all refer to the original tagged
 * snapshot, so one apply advances the snapshot store once instead of once per
 * parallel hunk (which quickly evicts in-session tags; host keeps ~4 versions).
 *
 * Calls without a path+tag apply immediately through `apply` with no batching.
 */
export function coalesceSameTagHashline(
  member: HashlineCoalesceMember,
  apply: HashlineCoalesceApply,
): Promise<unknown> {
  const key = hashlineCoalesceKey(member.meta)
  if (!key) return apply(member.input, [member])

  return new Promise<unknown>((resolve, reject) => {
    let batch = batches.get(key)
    if (!batch || batch.flushing) {
      batch = { key, members: [], timer: undefined, flushing: false }
      batches.set(key, batch)
    }

    const pending: PendingMember = {
      ...member,
      apply,
      resolve,
      reject,
    }
    if (member.signal) {
      if (member.signal.aborted) {
        reject(member.signal.reason ?? new Error("hashline coalesce aborted"))
        return
      }
      pending.onAbort = () => {
        removeMember(batch, pending)
        reject(member.signal!.reason ?? new Error("hashline coalesce aborted"))
        if (batch.members.length > 0) scheduleFlush(batch)
      }
      member.signal.addEventListener("abort", pending.onAbort, { once: true })
    }

    batch.members.push(pending)
    scheduleFlush(batch)
  })
}
