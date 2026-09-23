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
const CURSOR_PROVIDER_PACKAGE = "cursor-opencode-provider"

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
  expected: HostTokenUsage
  exact: HostTokenUsage
}

type HostEventInput = {
  event: unknown
  client: unknown
  directory: string
  serverUrl: URL
}

let reconciliationRoot: string | undefined

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

function exactUsageFromMetadata(metadata: unknown): HostTokenUsage | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.cursor)) return undefined
  const cursor = metadata.cursor
  if (cursor.occupancyOnly === true) return undefined
  const keys = [
    "inputTokensRaw",
    "outputTokensRaw",
    "cacheReadRaw",
    "cacheWriteRaw",
    "reasoningTokensRaw",
  ] as const
  if (keys.some((key) => typeof cursor[key] !== "number" || !Number.isFinite(cursor[key]))) return undefined
  const inputTotal = count(cursor.inputTokensRaw)
  const outputTotal = count(cursor.outputTokensRaw)
  const cacheRead = Math.min(count(cursor.cacheReadRaw), inputTotal)
  const cacheWrite = Math.min(count(cursor.cacheWriteRaw), inputTotal - cacheRead)
  const reasoning = Math.min(count(cursor.reasoningTokensRaw), outputTotal)
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

/**
 * Save the exact terminal counters beside the occupancy-shaped finish that the
 * host must first attach to its assistant message. The plugin event bridge
 * later changes only the separately persisted step-finish accounting record.
 */
export function recordTerminalUsage(sessionID: string | undefined, part: unknown): void {
  const root = reconciliationRoot
  if (!root || !isRecord(part) || part.type !== "finish") return
  const expected = hostUsageFromV3(part.usage)
  const exact = exactUsageFromMetadata(part.providerMetadata)
  if (!expected || !exact || sameUsage(expected, exact)) return

  const createdAt = Date.now()
  const record: ReconciliationRecord = {
    version: RECORD_VERSION,
    sessionID: sessionID ?? "",
    createdAt,
    expected,
    exact,
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

function isCursorOccupancyFinish(part: StreamPartLike): boolean {
  return isRecord(part.providerMetadata)
    && isRecord(part.providerMetadata.cursor)
    && part.providerMetadata.cursor.occupancyOnly === true
}

/** Select Cursor accounting only for that exact provider package. */
export function cursorUsageIntegrationForPackage(
  packageName: string,
  hostId: string,
  env: Record<string, string | undefined> = process.env,
): ProviderUsageIntegration | undefined {
  if (packageName !== CURSOR_PROVIDER_PACKAGE) return undefined
  if (hostId === "kilo") installUsageReconciliation(hostId, env)
  return {
    isOccupancyFinish: isCursorOccupancyFinish,
    recordTerminalUsage: hostId === "kilo" ? recordTerminalUsage : () => {},
  }
}

function parseRecord(file: string): ReconciliationRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!isRecord(value) || value.version !== RECORD_VERSION) return undefined
    if (typeof value.sessionID !== "string" || typeof value.createdAt !== "number") return undefined
    if (!isRecord(value.expected) || !isRecord(value.exact)) return undefined
    const expected = hostUsageFromStored(value.expected)
    const exact = hostUsageFromStored(value.exact)
    if (!expected || !exact) return undefined
    return { version: RECORD_VERSION, sessionID: value.sessionID, createdAt: value.createdAt, expected, exact }
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

function claimRecord(sessionID: string, observed: HostTokenUsage): { file: string; record: ReconciliationRecord } | undefined {
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
    if (!record || (record.sessionID && record.sessionID !== sessionID) || !sameUsage(record.expected, observed)) continue
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

async function reconcileEvent(input: HostEventInput): Promise<void> {
  if (!isRecord(input.event) || input.event.type !== "message.part.updated") return
  const properties = isRecord(input.event.properties) ? input.event.properties : undefined
  const part = properties && isRecord(properties.part) ? properties.part : undefined
  if (!part || part.type !== "step-finish") return
  if (typeof part.sessionID !== "string" || typeof part.messageID !== "string" || typeof part.id !== "string") return
  const observed = usageFromPart(part)
  if (!observed) return
  const claimed = claimRecord(part.sessionID, observed)
  if (!claimed) return

  try {
    // Exact counters cover the whole held Run, while this part's elapsed time
    // covers only its final generation slice. Keeping computed throughput on
    // the corrected event would both duplicate the live sample and divide a
    // cumulative output count by one slice's duration.
    const { metrics: _sliceMetrics, ...accountingPart } = part
    await updatePersistedPart(input, {
      ...accountingPart,
      tokens: claimed.record.exact,
    })
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
      await reconcileEvent(input)
      await prior?.(input)
    },
  }
}

export function resetUsageReconciliationForTests(): void {
  reconciliationRoot = undefined
  const root = globalThis as typeof globalThis & Record<typeof HOST_EVENT_BRIDGE, unknown>
  const current = root[HOST_EVENT_BRIDGE]
  if (isRecord(current) && (current as RecordLike & { [BRIDGE_MARKER]?: unknown })[BRIDGE_MARKER] === true) {
    delete root[HOST_EVENT_BRIDGE]
  }
}
