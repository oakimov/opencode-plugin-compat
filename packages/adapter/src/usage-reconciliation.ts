import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { hostCacheDir } from "./runtime-host"
import type { ProviderUsageIntegration, StreamPartLike } from "./language-model"

const HOST_EVENT_BRIDGE = Symbol.for("opencode.host.event-bridge")
const BRIDGE_MARKER = Symbol.for("opencode.compat.usage-reconciliation")
const RECORD_VERSION = 1
const RECORD_TTL_MS = 60 * 60 * 1000
const MAX_SESSION_RECORDS = 128
const RAW_COUNTER_KEYS = [
  "inputTokensRaw",
  "outputTokensRaw",
  "cacheReadRaw",
  "cacheWriteRaw",
  "reasoningTokensRaw",
] as const

type RecordLike = Record<string, unknown>

export type HostTokenUsage = {
  total: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type ReconciliationRecord = {
  version: 1
  sessionID: string
  createdAt: number
  reason?: string
  expected: HostTokenUsage
  exact: HostTokenUsage
  occupancyOnly?: boolean
  /** Only a live display estimate. TurnEnded always replaces it. */
  provisional?: HostTokenUsage
  ledgerKey?: string
}

type StepObservation = {
  textChars: number
  reasoningChars: number
  toolChars: number
  elapsedMs: number
  hasTools: boolean
}

type UsageLedger = {
  lastContext?: number
  lastRate?: number
  cacheFactor: number
  parts: Array<{ part: RecordLike; provisional: HostTokenUsage }>
}

type HostEventInput = {
  event: unknown
  client: unknown
  directory: string
  serverUrl: URL
}

let reconciliationRoot: string | undefined
const ledgers = new Map<string, UsageLedger>()
const eventQueues = new Map<string, Promise<void>>()

const zeroUsage = (): HostTokenUsage => ({
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

function isRecord(value: unknown): value is RecordLike {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

function hostUsageFromV3(usage: unknown): HostTokenUsage | undefined {
  if (!isRecord(usage)) return undefined
  const input = isRecord(usage.inputTokens) ? usage.inputTokens : undefined
  const output = isRecord(usage.outputTokens) ? usage.outputTokens : undefined
  if (!input || !output) return undefined
  const inputTotal = count(input.total)
  const outputTotal = count(output.total)
  const cacheRead = Math.min(count(input.cacheRead), inputTotal)
  const cacheWrite = Math.min(count(input.cacheWrite), inputTotal - cacheRead)
  const reasoning = Math.min(count(output.reasoning), outputTotal)
  return {
    total: inputTotal + outputTotal,
    input: inputTotal - cacheRead - cacheWrite,
    output: outputTotal - reasoning,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  }
}

/** An opt-in, provider-namespaced usage contract. Unknown metadata passes through. */
function usageMetadata(metadata: unknown): RecordLike | undefined {
  if (!isRecord(metadata)) return undefined
  const candidates = [metadata, ...Object.values(metadata)]
    .filter(isRecord)
    .filter((value) => value.usageVersion === 3
      && (value.occupancyOnly === true
        || RAW_COUNTER_KEYS.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))))
  return candidates.length === 1 ? candidates[0] : undefined
}

function exactUsageFromMetadata(metadata: unknown): HostTokenUsage | undefined {
  const accounting = usageMetadata(metadata)
  if (!accounting || accounting.occupancyOnly === true) return undefined
  if (RAW_COUNTER_KEYS.some((key) => typeof accounting[key] !== "number" || !Number.isFinite(accounting[key]))) return undefined
  const inputTotal = count(accounting.inputTokensRaw)
  const outputTotal = count(accounting.outputTokensRaw)
  const cacheRead = Math.min(count(accounting.cacheReadRaw), inputTotal)
  const cacheWrite = Math.min(count(accounting.cacheWriteRaw), inputTotal - cacheRead)
  const reasoning = Math.min(count(accounting.reasoningTokensRaw), outputTotal)
  return {
    total: inputTotal + outputTotal,
    input: inputTotal - cacheRead - cacheWrite,
    output: outputTotal - reasoning,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  }
}

function sameUsage(left: HostTokenUsage, right: HostTokenUsage): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.reasoning === right.reasoning
    && left.cache.read === right.cache.read
    && left.cache.write === right.cache.write
}

function finishReason(part: RecordLike): string | undefined {
  const reason = part.finishReason ?? part.reason
  if (typeof reason === "string") return reason
  return isRecord(reason) && typeof reason.unified === "string" ? reason.unified : undefined
}

function sessionPrefix(sessionID: string): string {
  if (!sessionID) return "unscoped"
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 32)
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Claimed by another process or already cleaned.
  }
}

function cleanup(root: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith(".json") && !name.includes(".claim-")) continue
    const file = path.join(root, name)
    try {
      if (now - statSync(file).mtimeMs > RECORD_TTL_MS) safeUnlink(file)
    } catch {
      // Concurrent cleanup is harmless.
    }
  }
}

function estimateStep(
  accounting: RecordLike,
  step: StepObservation,
  ledger: UsageLedger,
): HostTokenUsage {
  const context = isRecord(accounting.context) ? accounting.context : undefined
  const current = context?.stale === false && typeof context.usedTokens === "number"
    ? count(context.usedTokens)
    : undefined
  let prompt = 0
  let read = 0
  if (current !== undefined && current > 0 && current !== ledger.lastContext) {
    prompt = current
    read = ledger.lastContext === undefined
      ? 0
      : Math.min(prompt, Math.round(ledger.lastContext * ledger.cacheFactor))
    ledger.lastContext = current
  }

  // Cursor's checkpoint does not provide call-local output. Estimate visible
  // text, reasoning, and tool arguments; a silent step uses a conservative
  // fraction of the last measured rate rather than the one-token context flag.
  const visible = Math.ceil((step.textChars + step.reasoningChars + step.toolChars) / 4)
  const elapsed = Math.max(1, step.elapsedMs)
  const observedRate = step.textChars + step.reasoningChars >= 80 && elapsed >= 500
    ? Math.min(200, Math.max(1, visible * 1_000 / elapsed))
    : undefined
  const carried = ledger.lastRate === undefined || elapsed < 500
    ? 0
    : Math.round(ledger.lastRate * elapsed / 2_000)
  const generated = Math.max(visible, carried)
  if (observedRate !== undefined) {
    ledger.lastRate = ledger.lastRate === undefined
      ? observedRate
      : ledger.lastRate * 0.6 + observedRate * 0.4
  }
  const reasoning = Math.min(generated, Math.ceil(step.reasoningChars / 4))
  return {
    total: prompt + generated,
    input: prompt - read,
    output: generated - reasoning,
    reasoning,
    cache: { read, write: 0 },
  }
}

/**
 * Let the host attach every checkpoint occupancy to its assistant message,
 * then replace only the separately persisted step-finish accounting record.
 * Intermediate records carry clearly provisional request-work estimates. The
 * terminal aggregate clears them and replaces their sum with exact counters.
 */
export function recordFinishUsage(sessionID: string | undefined, part: unknown, step?: StepObservation): void {
  const root = reconciliationRoot
  if (!root || !isRecord(part) || part.type !== "finish") return
  const expected = hostUsageFromV3(part.usage)
  const accounting = usageMetadata(part.providerMetadata)
  const occupancyOnly = accounting?.occupancyOnly === true
  const ledgerKey = sessionID && step?.hasTools ? sessionID : undefined
  const ledger = ledgerKey
    ? ledgers.get(ledgerKey) ?? { cacheFactor: 0.7, parts: [] }
    : undefined
  if (ledgerKey && ledger) ledgers.set(ledgerKey, ledger)
  const provisional = accounting && step && ledger
    ? estimateStep(accounting, step, ledger)
    : undefined
  const exact = occupancyOnly
    ? provisional ?? zeroUsage()
    : exactUsageFromMetadata(part.providerMetadata)
  if (!expected || !exact || (sameUsage(expected, exact) && !provisional)) return

  const createdAt = Date.now()
  const record: ReconciliationRecord = {
    version: RECORD_VERSION,
    sessionID: sessionID ?? "",
    createdAt,
    reason: finishReason(part),
    expected,
    exact,
    ...(occupancyOnly ? { occupancyOnly: true } : {}),
    ...(provisional ? { provisional } : {}),
    ...(ledgerKey ? { ledgerKey } : {}),
  }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    cleanup(root, createdAt)
    const stem = `${sessionPrefix(record.sessionID)}-${createdAt}-${randomUUID()}`
    const temp = path.join(root, `${stem}.tmp`)
    const target = path.join(root, `${stem}.json`)
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temp, target)
  } catch {
    // Reconciliation is additive; never disrupt the provider stream.
  }
}

function isOccupancyFinish(part: StreamPartLike): boolean {
  return usageMetadata(part.providerMetadata)?.occupancyOnly === true
}

/** Kilo accounts for step parts separately from assistant context snapshots. */
export function usageIntegrationForHost(
  hostId: string,
  env: Record<string, string | undefined> = process.env,
): ProviderUsageIntegration | undefined {
  if (hostId !== "kilo") return undefined
  installUsageReconciliation(hostId, env)
  return {
    isOccupancyFinish,
    recordFinishUsage,
  }
}

function parseRecord(file: string): ReconciliationRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!isRecord(value) || value.version !== RECORD_VERSION) return undefined
    if (typeof value.sessionID !== "string" || typeof value.createdAt !== "number") return undefined
    if (value.reason !== undefined && typeof value.reason !== "string") return undefined
    if (!isRecord(value.expected) || !isRecord(value.exact)) return undefined
    const expected = hostUsageFromStored(value.expected)
    const exact = hostUsageFromStored(value.exact)
    const provisional = isRecord(value.provisional) ? hostUsageFromStored(value.provisional) : undefined
    if (!expected || !exact) return undefined
    if (value.provisional !== undefined && !provisional) return undefined
    if (value.occupancyOnly !== undefined && value.occupancyOnly !== true) return undefined
    if (value.ledgerKey !== undefined && typeof value.ledgerKey !== "string") return undefined
    return {
      version: RECORD_VERSION,
      sessionID: value.sessionID,
      createdAt: value.createdAt,
      reason: value.reason,
      expected,
      exact,
      ...(value.occupancyOnly === true ? { occupancyOnly: true } : {}),
      ...(provisional ? { provisional } : {}),
      ...(typeof value.ledgerKey === "string" ? { ledgerKey: value.ledgerKey } : {}),
    }
  } catch {
    return undefined
  }
}

function hostUsageFromStored(value: RecordLike): HostTokenUsage | undefined {
  if (!isRecord(value.cache)) return undefined
  for (const candidate of [value.total, value.input, value.output, value.reasoning, value.cache.read, value.cache.write]) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return undefined
  }
  return {
    total: count(value.total),
    input: count(value.input),
    output: count(value.output),
    reasoning: count(value.reasoning),
    cache: { read: count(value.cache.read), write: count(value.cache.write) },
  }
}

function usageFromPart(part: RecordLike): HostTokenUsage | undefined {
  if (!isRecord(part.tokens) || !isRecord(part.tokens.cache)) return undefined
  const tokens = part.tokens as RecordLike
  const cache = tokens.cache as RecordLike
  for (const candidate of [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return undefined
  }
  return {
    total: count(tokens.total) || count(tokens.input) + count(tokens.output) + count(tokens.reasoning) + count(cache.read) + count(cache.write),
    input: count(tokens.input),
    output: count(tokens.output),
    reasoning: count(tokens.reasoning),
    cache: { read: count(cache.read), write: count(cache.write) },
  }
}

function claimRecord(sessionID: string, observed: HostTokenUsage, reason: string | undefined): { file: string; record: ReconciliationRecord } | undefined {
  const root = reconciliationRoot
  if (!root) return undefined
  const prefix = `${sessionPrefix(sessionID)}-`
  let names: string[]
  try {
    names = readdirSync(root)
      .filter((name) => (name.startsWith(prefix) || name.startsWith("unscoped-")) && name.endsWith(".json"))
      .sort()
      .slice(0, MAX_SESSION_RECORDS)
  } catch {
    return undefined
  }
  for (const name of names) {
    const source = path.join(root, name)
    const record = parseRecord(source)
    if (!record
      || (record.sessionID && record.sessionID !== sessionID)
      || (record.reason && record.reason !== reason)
      || !sameUsage(record.expected, observed)) continue
    const claimed = `${source}.claim-${process.pid}-${randomUUID()}`
    try {
      renameSync(source, claimed)
      return { file: claimed, record }
    } catch {
      // Another process won this record; try the next candidate.
    }
  }
  return undefined
}

async function updatePersistedPart(input: HostEventInput, part: RecordLike): Promise<void> {
  const client = isRecord(input.client) ? input.client : undefined
  const transport = client && isRecord(client._client) ? client._client : undefined
  if (transport && typeof transport.patch === "function") {
    const response = await transport.patch({
      url: "/session/{sessionID}/message/{messageID}/part/{partID}",
      path: {
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
      },
      query: { directory: input.directory },
      body: part,
      headers: { "Content-Type": "application/json" },
    })
    if (isRecord(response) && response.error != null) throw new Error("part update failed")
    return
  }

  const url = new URL(
    `/session/${encodeURIComponent(String(part.sessionID))}/message/${encodeURIComponent(String(part.messageID))}/part/${encodeURIComponent(String(part.id))}`,
    input.serverUrl,
  )
  url.searchParams.set("directory", input.directory)
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(part),
  })
  if (!response.ok) throw new Error(`part update failed (${response.status})`)
}

function accountingPart(part: RecordLike, usage: HostTokenUsage, speedSample = false): RecordLike {
  const { metrics: _oldMetrics, ...rest } = part
  const generated = usage.output + usage.reasoning
  // Kilo's sidebar appends the original host event and this PATCH as separate
  // samples. The original supplies the measured step duration; the added
  // token estimate must not add that same duration a second time. Exact
  // settlement below restores the original persisted time on the part.
  const time = speedSample && isRecord(part.time) && count(part.time.elapsed) > 0
    ? { ...part.time, elapsed: 1 }
    : part.time
  return {
    ...rest,
    tokens: usage,
    ...(speedSample && time !== undefined ? { time } : {}),
    ...(speedSample && generated > 0 && isRecord(time) && count(time.elapsed) > 0
      ? { metrics: { generation: generated * 1_000 / count(time.elapsed), source: "computed" } }
      : {}),
  }
}

function generatedOnlyUsage(generated: number): HostTokenUsage {
  return { ...zeroUsage(), total: generated, output: generated }
}

function distributeExact(
  exact: HostTokenUsage,
  estimates: HostTokenUsage[],
): HostTokenUsage[] {
  const allocations = estimates.map(() => zeroUsage())
  const fields = ["input", "output", "reasoning", "read", "write"] as const
  for (const field of fields) {
    const target = field === "read" || field === "write" ? exact.cache[field] : exact[field]
    const weights = estimates.map((usage) => field === "read" || field === "write" ? usage.cache[field] : usage[field])
    const weightTotal = weights.reduce((sum, value) => sum + value, 0)
    let assigned = 0
    for (let index = 0; index < allocations.length; index++) {
      const allocation = allocations[index]!
      const value = index === allocations.length - 1
        ? target - assigned
        : weightTotal > 0 ? Math.floor(target * weights[index]! / weightTotal) : 0
      if (field === "read" || field === "write") allocation.cache[field] = value
      else allocation[field] = value
      assigned += value
    }
  }
  for (const usage of allocations) {
    usage.total = usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
  }
  return allocations
}

async function reconcileEvent(input: HostEventInput): Promise<void> {
  if (!isRecord(input.event) || input.event.type !== "message.part.updated") return
  const properties = isRecord(input.event.properties) ? input.event.properties : undefined
  const part = properties && isRecord(properties.part) ? properties.part : undefined
  if (!part || part.type !== "step-finish") return
  if (typeof part.sessionID !== "string" || typeof part.messageID !== "string" || typeof part.id !== "string") return
  const observed = usageFromPart(part)
  if (!observed) return
  const claimed = claimRecord(part.sessionID, observed, finishReason(part))
  if (!claimed) return

  try {
    const { record } = claimed
    const ledger = record.ledgerKey ? ledgers.get(record.ledgerKey) : undefined
    if (record.provisional && record.occupancyOnly) {
      await updatePersistedPart(input, accountingPart(part, record.provisional, true))
      ledger?.parts.push({ part, provisional: record.provisional })
    } else {
      // Preserve step attribution while settling the exact turn total.
      // Each component is distributed independently, so the host's sum of
      // input/output/reasoning/cache is exactly the provider's terminal sum.
      const previous = ledger?.parts ?? []
      const allocated = distributeExact(
        record.exact,
        [...previous.map((entry) => entry.provisional), record.provisional ?? zeroUsage()],
      )
      for (let index = 0; index < previous.length; index++) {
        await updatePersistedPart(input, accountingPart(previous[index]!.part, allocated[index]!))
      }
      const priorGenerated = previous.reduce(
        (sum, entry) => sum + entry.provisional.output + entry.provisional.reasoning, 0,
      )
      const exactGenerated = record.exact.output + record.exact.reasoning
      const remainingGenerated = Math.max(0, exactGenerated - priorGenerated)
      if (record.provisional && remainingGenerated > 0) {
        await updatePersistedPart(input, accountingPart(part, generatedOnlyUsage(remainingGenerated), true))
      }
      await updatePersistedPart(input, accountingPart(part, allocated.at(-1)!))
      if (ledger) ledger.parts = []
    }
    safeUnlink(claimed.file)
  } catch (error) {
    const source = claimed.file.replace(/\.claim-[^.]+-[0-9a-f-]+$/, "")
    try {
      renameSync(claimed.file, source)
    } catch {
      // Keep the provider/plugin path non-fatal even if recovery races.
    }
    throw error
  }
}

/** Install Kilo's accounting reconciliation as a host capability. */
export function installUsageReconciliation(
  id: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (id !== "kilo") return
  reconciliationRoot = path.join(hostCacheDir(id, env), "ocp", "usage-reconciliation")
  try {
    mkdirSync(reconciliationRoot, { recursive: true, mode: 0o700 })
  } catch {
    // Stream adoption remains available even when accounting state is not.
  }
  const root = globalThis as typeof globalThis & Record<typeof HOST_EVENT_BRIDGE, unknown>
  const current = root[HOST_EVENT_BRIDGE]
  if (isRecord(current) && (current as RecordLike & { [BRIDGE_MARKER]?: unknown })[BRIDGE_MARKER] === true) return
  const prior = isRecord(current) && typeof current.handle === "function"
    ? current.handle.bind(current) as (input: HostEventInput) => void | Promise<void>
    : undefined
  root[HOST_EVENT_BRIDGE] = {
    [BRIDGE_MARKER]: true,
    async handle(input: HostEventInput) {
      const properties = isRecord(input.event) && isRecord(input.event.properties)
        ? input.event.properties : undefined
      const part = properties && isRecord(properties.part) ? properties.part : undefined
      const key = part?.type === "step-finish" && typeof part.sessionID === "string"
        ? part.sessionID : undefined
      if (key) {
        const priorEvent = eventQueues.get(key) ?? Promise.resolve()
        const currentEvent = priorEvent.catch(() => {}).then(() => reconcileEvent(input))
        eventQueues.set(key, currentEvent)
        try {
          await currentEvent
        } finally {
          if (eventQueues.get(key) === currentEvent) eventQueues.delete(key)
        }
      } else {
        await reconcileEvent(input)
      }
      await prior?.(input)
    },
  }
}

export function resetUsageReconciliationForTests(): void {
  reconciliationRoot = undefined
  ledgers.clear()
  eventQueues.clear()
  const root = globalThis as typeof globalThis & Record<typeof HOST_EVENT_BRIDGE, unknown>
  const current = root[HOST_EVENT_BRIDGE]
  if (isRecord(current) && (current as RecordLike & { [BRIDGE_MARKER]?: unknown })[BRIDGE_MARKER] === true) {
    delete root[HOST_EVENT_BRIDGE]
  }
}
