/**
 * Pi-family subagent vocabulary ↔ OpenCode's canonical `task` tool.
 *
 * The two Pi hosts deliberately stay separate from the OpenCode-clone
 * adapter: omp's built-in `task` and pi's optional `subagent` extension both
 * execute `{agent, task}`, while OpenCode plugins expect
 * `{description, prompt, subagent_type}`. This module translates only that
 * declared role and only when the host advertises it on the current call.
 */
import type { PiHostProfile, PiToolInputProfile } from "../host/profile.js"
import type { PiTool } from "../pi-provider-types.js"
import {
  translateCanonicalQuestionCall,
  type PiQuestionVocabulary,
} from "./question.js"

export const CANONICAL_SUBAGENT_TOOL = "task"

export type SubagentToolSchemaFn = (tool: PiTool) => Record<string, unknown>

export type PiSubagentVocabulary = {
  hostToolName: string
  hostDescription: string
  hostSchema: Record<string, unknown>
  /** Host agent names discovered from the live schema/description. */
  availableAgents: readonly string[]
  /** Whether the discovered list is exhaustive for this call. */
  agentCatalogComplete: boolean
  /** OpenCode agent type → host agent type; null delegates to the host default. */
  agentAliases: Readonly<Record<string, string | null>>
  /** Host-native coordination tool that remains directly callable. */
  coordinationToolName?: string
  /** Host tools renamed provider-side to make room for canonical `task`. */
  hostToolAliases: Readonly<Record<string, string>>
  /** Host argument that preserves OpenCode's unstructured task result. */
  unstructuredOutput?: { field: string; value: unknown }
}

/**
 * Live subset of the profile's `toolInputs`, keyed by host tool name. Carries
 * the profile entry verbatim so a new `PiToolInputProfile` field reaches the
 * translation boundary without a matching edit here.
 */
export type PiToolInputVocabulary = Readonly<Record<string, PiToolInputProfile>>

export type PiTerminalResultVocabulary = {
  hostToolName: string
  input: Readonly<Record<string, unknown>>
}

export type TranslatedSubagentCall = {
  toolName: string
  input: Record<string, unknown>
}

/** Normalize a translate result to a (possibly empty) call list. */
export function asTranslatedCalls(
  translated: TranslatedSubagentCall | TranslatedSubagentCall[] | undefined,
): TranslatedSubagentCall[] {
  if (!translated) return []
  return Array.isArray(translated) ? translated : [translated]
}

function todoCallsForHost(
  hostToolName: string,
  input: Record<string, unknown>,
  shape: PiToolInputProfile["inputShape"],
): TranslatedSubagentCall | TranslatedSubagentCall[] {
  if (shape === "opencode-todo") {
    const ops = expandTodoSnapshotToHostOps(input)
    if (!ops) return { toolName: hostToolName, input }
    if (ops.length === 1) return { toolName: hostToolName, input: ops[0]! }
    return ops.map(op => ({ toolName: hostToolName, input: op }))
  }
  if (shape === "opencode-read") {
    return expandReadCalls(hostToolName, input)
  }
  return { toolName: hostToolName, input: applyInputShape(input, shape) }
}

/**
 * Split a model-joined multi-path string into absolute path segments.
 * Only `;` with every segment absolute (posix / Windows drive / UNC) — a
 * lone semicolon inside a relative name is left alone.
 */
export function splitJoinedAbsolutePaths(path: string): string[] | undefined {
  if (!path.includes(";")) return undefined
  const parts = path.split(";").map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length < 2) return undefined
  if (!parts.every(isAbsolutePathToken)) return undefined
  return parts
}

function isAbsolutePathToken(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\\\")) return true
  return /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * One OpenCode/Cursor read → one or more host reads. Models sometimes join
 * glob hits with `;` into a single `path`; the host (and Cursor's pre-exec
 * missing-file reject) treat that as one nonexistent target. Fan out so each
 * absolute segment is a real read instead of a reject→retry loop.
 */
function expandReadCalls(
  hostToolName: string,
  input: Record<string, unknown>,
): TranslatedSubagentCall | TranslatedSubagentCall[] {
  const path = input["path"]
  if (typeof path === "string") {
    const parts = splitJoinedAbsolutePaths(path)
    if (parts) {
      return parts.map(part => ({
        toolName: hostToolName,
        input: applyReadShape({ ...input, path: part }),
      }))
    }
  }
  return { toolName: hostToolName, input: applyReadShape(input) }
}

function agentNamesFromSchema(schema: unknown): string[] {
  const names = new Set<string>()
  const seen = new Set<object>()

  const visit = (value: unknown, propertyName?: string): void => {
    if (!value || typeof value !== "object") return
    if (seen.has(value as object)) return
    seen.add(value as object)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, propertyName)
      return
    }

    const record = value as Record<string, unknown>
    if (propertyName === "agent") {
      if (Array.isArray(record["enum"])) {
        for (const item of record["enum"]) {
          if (typeof item === "string" && item) names.add(item)
        }
      }
      if (typeof record["const"] === "string" && record["const"]) names.add(record["const"])
    }
    for (const [key, child] of Object.entries(record)) visit(child, key)
  }

  visit(schema)
  return [...names]
}

function agentNamesFromDescription(description: string): { names: string[]; complete: boolean } {
  const names: string[] = []
  let inAgents = false
  let complete = false

  for (const line of description.split(/\r?\n/)) {
    if (/^#{1,2}\s+Available Agents\s*$/i.test(line.trim())) {
      inAgents = true
      complete = true
      continue
    }
    if (!inAgents) continue
    if (/^#{1,2}\s+/.test(line.trim())) break
    const heading = line.trim().match(/^###\s+`?([A-Za-z0-9_-]+)`?(?:\s|$)/)
    if (heading?.[1] && !names.includes(heading[1])) names.push(heading[1])
  }

  return { names, complete }
}

/**
 * Resolve the live subagent role. The catalog, not merely the profile, is
 * authoritative because Pi's reference extension can be absent or disabled.
 * If pi also has an unrelated `task`, that host tool receives a deterministic
 * provider-side alias so canonical `task` can still launch `subagent`.
 */
export function buildPiSubagentVocabulary(
  tools: readonly PiTool[] | undefined,
  toSchema: SubagentToolSchemaFn,
  profile: PiHostProfile,
): PiSubagentVocabulary | undefined {
  if (!tools || tools.length === 0) return undefined
  const configured = profile.tools?.subagent
  if (!configured) return undefined
  const hostTool = tools.find(tool => tool.name === configured.name)
  if (!hostTool) return undefined

  const hostSchema = toSchema(hostTool)
  const described = agentNamesFromDescription(hostTool.description)
  const schemaAgents = agentNamesFromSchema(hostSchema)
  const availableAgents = new Set([...schemaAgents, ...described.names])
  const occupied = new Set(tools.map(tool => tool.name))
  const hostToolAliases: Record<string, string> = {}
  if (configured.name !== CANONICAL_SUBAGENT_TOOL && occupied.has(CANONICAL_SUBAGENT_TOOL)) {
    const base = `${profile.id}_host_${CANONICAL_SUBAGENT_TOOL}`
    let alias = base
    let suffix = 2
    while (occupied.has(alias)) alias = `${base}_${suffix++}`
    hostToolAliases[CANONICAL_SUBAGENT_TOOL] = alias
  }

  return {
    hostToolName: configured.name,
    hostDescription: hostTool.description,
    hostSchema,
    availableAgents: [...availableAgents],
    agentCatalogComplete: described.complete || schemaAgents.length > 0,
    agentAliases: configured.agentAliases,
    hostToolAliases,
    coordinationToolName:
      configured.coordinationTool && tools.some(tool => tool.name === configured.coordinationTool?.name)
        ? configured.coordinationTool.name
        : undefined,
    unstructuredOutput: configured.unstructuredOutput,
  }
}

/**
 * Does the live tool advertise `key` as a parameter? Used to confirm the host
 * is currently running the schema an alias set was written against.
 *
 * Fails open (`true`) only when no resolver is supplied at all — a host we
 * cannot inspect keeps the profile's declared behaviour. Once a resolver is
 * given, an unreadable or property-less result is `false`, which selects the
 * OpenCode edit overlay instead of assuming replace mode is live.
 */
function schemaDeclaresKey(tool: PiTool, key: string, toSchema: SubagentToolSchemaFn | undefined): boolean {
  if (!toSchema) return true
  try {
    const properties = (toSchema(tool) as { properties?: Record<string, unknown> } | undefined)?.properties
    return !!properties && Object.hasOwn(properties, key)
  } catch {
    return false
  }
}

/** Resolve strict host-tool argument aliases independently of subagent support. */
export function buildPiToolInputVocabulary(
  tools: readonly PiTool[] | undefined,
  profile: PiHostProfile,
  toSchema?: SubagentToolSchemaFn,
): PiToolInputVocabulary | undefined {
  if (!tools || tools.length === 0) return undefined
  const live = new Map(tools.map(tool => [tool.name, tool] as const))
  const out: Record<string, PiToolInputProfile> = {}

  for (const [name, configured] of Object.entries(profile.tools?.toolInputs ?? {})) {
    const tool = live.get(name)
    if (!tool || !configured) continue
    // When the live schema is not the replace-mode one, keep the OpenCode
    // aliases and advertise the flat contract. Execution is the replace overlay.
    out[name] =
      configured.aliasSchemaKey && !schemaDeclaresKey(tool, configured.aliasSchemaKey, toSchema)
        ? { ...configured, inputShape: configured.inputShape ?? "opencode-edit" }
        : configured
  }

  // A coordination tool may also carry a `toolInputs` entry; merge its aliases
  // over that entry rather than replacing it, so the tool keeps any shape or
  // drop rules the profile declared for it.
  const coordination = profile.tools?.subagent?.coordinationTool
  if (coordination?.inputAliases && live.has(coordination.name)) {
    const existing = out[coordination.name]
    out[coordination.name] = {
      ...existing,
      inputAliases: { ...existing?.inputAliases, ...coordination.inputAliases },
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/** Resolve a host-only terminal result tool independently of spawn support. */
export function buildPiTerminalResultVocabulary(
  tools: readonly PiTool[] | undefined,
  profile: PiHostProfile,
): PiTerminalResultVocabulary | undefined {
  const configured = profile.tools?.terminalResult
  if (!configured || !tools?.some(tool => tool.name === configured.name)) return undefined
  return { hostToolName: configured.name, input: configured.input }
}

function canonicalAgentNames(vocabulary: PiSubagentVocabulary): string[] {
  if (!vocabulary.agentCatalogComplete) return []
  const names = new Set(vocabulary.availableAgents)
  for (const [canonical, host] of Object.entries(vocabulary.agentAliases)) {
    if ((host === null && names.size > 0) || (host !== null && names.has(host))) names.add(canonical)
  }
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** OpenCode's flat `task` schema, carrying a live agent enum when available. */
export function canonicalSubagentSchema(vocabulary: PiSubagentVocabulary): Record<string, unknown> {
  const agentNames = canonicalAgentNames(vocabulary)
  const subagentType: Record<string, unknown> = {
    type: "string",
    description: "The type of specialized agent to use for this task.",
  }
  if (agentNames.length > 0) subagentType["enum"] = agentNames

  return {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 words) description of the task.",
      },
      prompt: { type: "string", description: "The task for the agent to perform." },
      subagent_type: subagentType,
    },
    required: ["description", "prompt", "subagent_type"],
    additionalProperties: false,
  }
}

/**
 * Constant OpenCode-shaped task-tool description. Agent membership lives only
 * in the sorted `subagent_type` enum (see `canonicalSubagentSchema`); embedding
 * the live agent list or coordination tool name here would re-tokenize the
 * tools prefix every time host agent configuration changes.
 */
export function canonicalSubagentDescription(_vocabulary: PiSubagentVocabulary): string {
  return "Launch a specialized agent for an isolated delegated task."
}

function hostAgentFor(canonical: unknown, vocabulary: PiSubagentVocabulary): string | null | undefined {
  if (typeof canonical !== "string" || !canonical) return undefined
  if (Object.hasOwn(vocabulary.agentAliases, canonical)) return vocabulary.agentAliases[canonical]
  return canonical
}

function canonicalAgentFor(host: unknown, vocabulary: PiSubagentVocabulary): string {
  if (typeof host !== "string" || !host) return "general"
  for (const [canonical, mapped] of Object.entries(vocabulary.agentAliases)) {
    if (mapped === host) return canonical
  }
  return host
}

/** Restate one OpenCode-shaped call in the active host's single-spawn shape. */
export function translateCanonicalSubagentCall(
  toolName: string,
  input: Record<string, unknown>,
  vocabulary: PiSubagentVocabulary | undefined,
): TranslatedSubagentCall | undefined {
  if (!vocabulary || toolName !== CANONICAL_SUBAGENT_TOOL) return undefined

  // A provider may already honor the host catalog itself. Preserve that input
  // while still applying pi's `task` → `subagent` name mapping.
  if (typeof input["task"] === "string" && typeof input["prompt"] !== "string") {
    return { toolName: vocabulary.hostToolName, input }
  }

  const hostInput: Record<string, unknown> = {}
  if (typeof input["prompt"] === "string") hostInput["task"] = input["prompt"]
  const agent = hostAgentFor(input["subagent_type"], vocabulary)
  if (typeof agent === "string" && agent) hostInput["agent"] = agent
  if (vocabulary.unstructuredOutput) {
    hostInput[vocabulary.unstructuredOutput.field] = vocabulary.unstructuredOutput.value
  }
  return { toolName: vocabulary.hostToolName, input: hostInput }
}

/** Rename provider-emitted keys onto host names, then drop harness-only keys. */
function rewriteInputKeys(
  input: Record<string, unknown>,
  aliases: Readonly<Record<string, string>>,
  dropInputKeys: readonly string[] = [],
): Record<string, unknown> {
  const translated = { ...input }
  for (const [providerName, hostName] of Object.entries(aliases)) {
    if (!Object.hasOwn(translated, providerName)) continue
    if (!Object.hasOwn(translated, hostName)) translated[hostName] = translated[providerName]
    delete translated[providerName]
  }
  for (const key of dropInputKeys) delete translated[key]
  return translated
}

/**
 * Accepted spellings of Pi's `edit` replacement fields, most authoritative
 * first. Pi's own vocabulary is `oldText`/`newText`; OpenCode and Kilo use
 * `oldString`/`newString`; MiMo (`tool/edit.ts`) and OMP's `replace` mode use
 * snake_case. All four are hosts this repo supports, so a model carrying a
 * sibling host's vocabulary is ordinary drift, not a malformed call.
 */
const PI_EDIT_OLD_KEYS = ["oldText", "oldString", "old_string"] as const
const PI_EDIT_NEW_KEYS = ["newText", "newString", "new_string"] as const
/** Consumed by the conversion, plus replace-all flags Pi has no equivalent for. */
const PI_EDIT_CONSUMED_KEYS = [
  ...PI_EDIT_OLD_KEYS,
  ...PI_EDIT_NEW_KEYS,
  "replaceAll",
  "replace_all",
] as const

/** First string value among the accepted spellings of one logical field. */
function firstString(input: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string") return value
  }
  return undefined
}

/**
 * OpenCode's `read` tool exposes `offset`/`limit` as separate arguments, but
 * omp accepts only `path` and embeds line ranges inline. Without this
 * conversion the host silently drops `offset`/`limit` and returns the head on
 * every paged read, so the model cannot advance past line 1 of a large file.
 *
 * `offset` is 1-indexed; `limit` is a line count — matching omp's `:N-M`
 * inclusive grammar. Selectors are minted as `raw:N-M` (not bare `:N-M`):
 * omp's default ranged-read display pads +1 leading / +3 trailing context
 * lines, which would violate OpenCode's exact-window contract
 * (`offset:10, limit:5` must be lines 10–14, not 9–17).
 */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined
  return value
}

function pathWithReadSelector(path: string, selector: string): string {
  if (/^https?:\/\//i.test(path)) {
    const boundary = [path.indexOf("?"), path.indexOf("#")]
      .filter(index => index >= 0)
      .reduce((left, right) => Math.min(left, right), path.length)
    let base = path.slice(0, boundary)
    const suffix = path.slice(boundary)
    // A bare authority would parse `:N-M` as a port; give it a root path.
    if (/^https?:\/\/[^/]+$/i.test(base)) base += "/"
    return `${base}:${selector}${suffix}`
  }
  return `${path}:${selector}`
}

/** Match a trailing omp line selector the bridge (or a prior host call) attached. */
const READ_SELECTOR_SUFFIX = /:(?:raw:)?(\d+)(?:-(\d+))?$/i

/**
 * Peel a bridge-minted (or equivalent) omp read selector back into OpenCode
 * `{filePath, offset?, limit?}` so history matches the advertised catalog.
 */
function peelReadSelector(path: string): Record<string, unknown> | undefined {
  if (/^https?:\/\//i.test(path)) {
    const boundary = [path.indexOf("?"), path.indexOf("#")]
      .filter(index => index >= 0)
      .reduce((left, right) => Math.min(left, right), path.length)
    const baseWithSel = path.slice(0, boundary)
    const suffix = path.slice(boundary)
    const match = baseWithSel.match(READ_SELECTOR_SUFFIX)
    if (!match || match.index === undefined) return undefined
    const bare = baseWithSel.slice(0, match.index)
    // Undo the synthetic root slash minted for bare-authority URLs.
    const fileBase = /^https?:\/\/[^/]+\/$/i.test(bare) ? bare.slice(0, -1) : bare
    return openCodeReadFromSelector(fileBase + suffix, match[1]!, match[2])
  }
  const match = path.match(READ_SELECTOR_SUFFIX)
  if (!match || match.index === undefined) return undefined
  return openCodeReadFromSelector(path.slice(0, match.index), match[1]!, match[2])
}

function openCodeReadFromSelector(
  filePath: string,
  startText: string,
  endText: string | undefined,
): Record<string, unknown> {
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 1) return { filePath }
  if (endText === undefined) return { filePath, offset: start }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return { filePath, offset: start }
  return { filePath, offset: start, limit: end - start + 1 }
}

function applyReadShape(input: Record<string, unknown>): Record<string, unknown> {
  const path = input["path"]
  if (typeof path !== "string") return input
  const offset = positiveInt(input["offset"])
  const limit = positiveInt(input["limit"])
  const hasOffset = Object.hasOwn(input, "offset")
  const hasLimit = Object.hasOwn(input, "limit")
  if (!hasOffset && !hasLimit) return input

  const rest = { ...input }
  delete rest["offset"]
  delete rest["limit"]
  // Match OpenCode's protobuf-default handling: zero means omitted. Other
  // invalid values must not silently widen to a different valid range.
  if (hasOffset && offset === undefined && input["offset"] !== 0) return rest
  if (hasLimit && limit === undefined && input["limit"] !== 0) return rest
  if (offset === undefined && limit === undefined) return rest

  if (
    offset !== undefined && limit !== undefined &&
    limit - 1 > Number.MAX_SAFE_INTEGER - offset
  ) return rest
  const end = offset !== undefined && limit !== undefined ? offset + limit - 1 : undefined

  // `raw:` disables omp's ranged-read context padding (+1 / +3).
  const selector = offset !== undefined && limit !== undefined
    ? `raw:${offset}-${end}`
    : offset !== undefined
      ? `raw:${offset}`
      : `raw:1-${limit}`

  rest["path"] = pathWithReadSelector(path, selector)
  return rest
}

const OPENCODE_TODO_HARNESS_KEYS = ["todos", "id", "priority", "merge"] as const

type OpenCodeTodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

function normalizeOpenCodeTodoStatus(value: unknown): OpenCodeTodoStatus {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled") {
    return value
  }
  if (value === "canceled") return "cancelled"
  return "pending"
}

/** Suffix marking a host call fanned out of one canonical provider tool call. */
export function todoFanoutId(toolCallId: string, index: number): string {
  return `${toolCallId}#${index}`
}

/** Recover the canonical call id from a fanned-out host call id (`…#N`). */
export function originalTodoFanoutId(toolCallId: string): string | undefined {
  const at = toolCallId.lastIndexOf("#")
  if (at <= 0) return undefined
  const suffix = toolCallId.slice(at + 1)
  if (!/^\d+$/.test(suffix)) return undefined
  return toolCallId.slice(0, at)
}

/** True when the live host tool is the ops-based OpenCode-todo bridge target. */
export function isOpsTodoHostTool(
  toolName: string,
  toolInputs: PiToolInputVocabulary | undefined,
): boolean {
  return toolInputs?.[toolName]?.inputShape === "opencode-todo"
}

type SnapshotTodoRow = { content: string; status: OpenCodeTodoStatus }

function readSnapshotTodoRows(todos: unknown): SnapshotTodoRow[] | undefined {
  if (!Array.isArray(todos)) return undefined
  const rows: SnapshotTodoRow[] = []
  for (const entry of todos) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const content = record["content"]
    if (typeof content !== "string" || !content.trim()) continue
    rows.push({
      content: content.trim(),
      status: normalizeOpenCodeTodoStatus(record["status"]),
    })
  }
  return rows
}

/**
 * Expand an OpenCode/Cursor todo snapshot into the ops-based host `todo` ops
 * that realise it (`inputShape: "opencode-todo"`).
 *
 * That host shape is one op per call and `init` always creates pending rows —
 * statuses cannot ride on one replace-all. Open-only snapshots stay a single
 * `init` (creates). Snapshots that mark work done/cancelled fan out:
 * `init` (full content list) → `done`/`drop` per terminal row → `start` for the
 * active row. Without that fan-out, completions were dropped and the host only
 * ever re-inited remaining open items — creates worked, completions stuck open.
 *
 * Native `{op:…}` calls pass through as a one-element list with harness keys
 * stripped. Returns `undefined` when `todos` is present but not an array so the
 * host validation error stays honest.
 */
export function expandTodoSnapshotToHostOps(
  input: Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  if (typeof input["op"] === "string" && input["op"]) {
    const rest = { ...input }
    for (const key of OPENCODE_TODO_HARNESS_KEYS) delete rest[key]
    return [rest]
  }

  if (!Object.hasOwn(input, "todos")) return [input]
  const rows = readSnapshotTodoRows(input["todos"])
  if (!rows) return undefined

  if (rows.length === 0) return [{ op: "rm" }]

  const hasTerminal = rows.some(
    row => row.status === "completed" || row.status === "cancelled",
  )
  if (!hasTerminal) {
    const inProgress: string[] = []
    const pending: string[] = []
    for (const row of rows) {
      if (row.status === "in_progress") inProgress.push(row.content)
      else pending.push(row.content)
    }
    const items = [...inProgress, ...pending]
    return items.length === 0 ? [{ op: "rm" }] : [{ op: "init", items }]
  }

  // Full reconstruct: init every row, then apply terminal + active statuses.
  // Order matches the snapshot so done/drop/start target the same content.
  const ops: Record<string, unknown>[] = [{ op: "init", items: rows.map(row => row.content) }]
  for (const row of rows) {
    if (row.status === "completed") ops.push({ op: "done", task: row.content })
    else if (row.status === "cancelled") ops.push({ op: "drop", task: row.content })
  }
  const active = rows.find(row => row.status === "in_progress")
  if (active) ops.push({ op: "start", task: active.content })
  return ops
}

/**
 * Fold an OpenCode/Cursor todo snapshot into ops-based host `todo` op(s).
 *
 * Prefer {@link expandTodoSnapshotToHostOps} when the caller can fan out. This
 * single-op helper keeps the first op only for call sites that cannot expand.
 */
function applyTodoShape(input: Record<string, unknown>): Record<string, unknown> {
  const ops = expandTodoSnapshotToHostOps(input)
  if (!ops) return input
  return ops[0] ?? input
}

/**
 * Pi's edit tool is structurally different from OpenCode's replacement tool:
 * it requires `edits: [{ oldText, newText }]`. Models sometimes retain another
 * vocabulary even after receiving Pi's nested schema, so perform the conversion
 * at the last boundary before Pi validates the call.
 */
const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const

/** True when a path segment carries glob metacharacters (incl. brace unions). */
function hasGlobPathChars(filePath: string): boolean {
  return GLOB_PATH_CHARS.some(char => filePath.includes(char))
}

/**
 * Join OpenCode `{pattern, path}` onto omp's single `path` glob field.
 * `path` is the search root only; omp expects the glob itself in `path`
 * (e.g. `src/**` + `/*.ts`). A bare `.` root collapses to the pattern alone so
 * `parseFindPattern` still prepends a recursive prefix for patterns that begin
 * with a glob metacharacter.
 */
function joinOpenCodeGlobPath(searchPath: string | undefined, pattern: string): string {
  const normalizedPattern = pattern.replace(/\\/g, "/")
  if (!searchPath || searchPath === "." || searchPath === "./") {
    return normalizedPattern
  }
  const base = searchPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const glob = normalizedPattern.replace(/^\/+/, "")
  if (!base) return glob
  return `${base}/${glob}`
}

/**
 * Fold OpenCode/Cursor `{pattern, path?}` into omp's `{path}` glob field.
 * Passthrough when `pattern` is absent (already host-shaped or directory-only).
 * Preserves `gitignore` / `hidden` / `limit`.
 */
function applyGlobShape(input: Record<string, unknown>): Record<string, unknown> {
  const pattern = typeof input["pattern"] === "string" && input["pattern"] ? input["pattern"] : undefined
  if (!pattern) return input

  const searchPath = typeof input["path"] === "string" ? input["path"] : undefined
  const rest = { ...input }
  delete rest["pattern"]
  rest["path"] = joinOpenCodeGlobPath(searchPath, pattern)
  return rest
}

/**
 * Restate a stored omp glob `path` as OpenCode `{pattern, path?}` for history.
 * Mirrors omp's `parseFindPattern` split: first glob-bearing segment starts
 * the pattern; preceding segments are the search root.
 */
function peelGlobPath(hostPath: string): { pattern: string; path?: string } {
  const normalized = hostPath.replace(/\\/g, "/")
  const segments = normalized.split("/")
  let firstGlobIndex = -1
  for (let i = 0; i < segments.length; i++) {
    if (hasGlobPathChars(segments[i]!)) {
      firstGlobIndex = i
      break
    }
  }

  if (firstGlobIndex === -1) {
    return normalized === "." || normalized === ""
      ? { pattern: "**/*" }
      : { pattern: "**/*", path: normalized }
  }
  if (firstGlobIndex === 0) {
    return { pattern: normalized }
  }
  return {
    path: segments.slice(0, firstGlobIndex).join("/"),
    pattern: segments.slice(firstGlobIndex).join("/"),
  }
}

function applyInputShape(
  input: Record<string, unknown>,
  shape: "pi-edit" | "opencode-edit" | "opencode-read" | "opencode-todo" | "opencode-glob" | "opencode-bash" | undefined,
): Record<string, unknown> {
  if (shape === "opencode-read") return applyReadShape(input)
  if (shape === "opencode-todo") return applyTodoShape(input)
  if (shape === "opencode-glob") return applyGlobShape(input)
  if (shape !== "pi-edit" || Array.isArray(input.edits)) return input

  const oldText = firstString(input, PI_EDIT_OLD_KEYS)
  const newText = firstString(input, PI_EDIT_NEW_KEYS)
  if (oldText === undefined || newText === undefined) return input

  const rest = { ...input }
  for (const key of PI_EDIT_CONSUMED_KEYS) delete rest[key]
  return { ...rest, edits: [{ oldText, newText }] }
}

/** Translate any provider-facing tool call into the live host vocabulary. */
function hostToolForProviderName(
  toolName: string,
  toolInputs: PiToolInputVocabulary | undefined,
): [string, PiToolInputProfile] | undefined {
  return Object.entries(toolInputs ?? {}).find(([, profile]) =>
    profile.providerName === toolName || profile.extraProviderNames?.includes(toolName) === true,
  )
}

export function translateCanonicalToolCall(
  toolName: string,
  input: Record<string, unknown>,
  vocabulary: PiSubagentVocabulary | undefined,
  toolInputs?: PiToolInputVocabulary,
  question?: PiQuestionVocabulary,
): TranslatedSubagentCall | TranslatedSubagentCall[] | undefined {
  const subagent = translateCanonicalSubagentCall(toolName, input, vocabulary)
  if (subagent) return subagent

  const asked = translateCanonicalQuestionCall(toolName, input, question)
  if (asked) return asked

  if (vocabulary) {
    for (const [hostName, providerName] of Object.entries(vocabulary.hostToolAliases)) {
      if (providerName === toolName) return { toolName: hostName, input }
    }
  }

  const renamedProfile = hostToolForProviderName(toolName, toolInputs)
  if (renamedProfile) {
    const [hostToolName, profile] = renamedProfile
    const source = toolName === "todoread" ? { op: "view", ...input } : input
    const translated = rewriteInputKeys(source, profile.inputAliases, profile.dropInputKeys)
    return todoCallsForHost(hostToolName, translated, profile.inputShape)
  }

  const inputProfile = toolInputs?.[toolName]
  if (!inputProfile) return undefined
  const { inputAliases, dropInputKeys, inputShape } = inputProfile

  const rewrites =
    Object.keys(inputAliases).some(name => Object.hasOwn(input, name)) ||
    dropInputKeys?.some(name => Object.hasOwn(input, name)) === true
  if (rewrites) {
    const translated = rewriteInputKeys(input, inputAliases, dropInputKeys)
    return todoCallsForHost(toolName, translated, inputShape)
  }
  if (inputShape) {
    if (inputShape === "opencode-todo" || inputShape === "opencode-read") {
      return todoCallsForHost(toolName, input, inputShape)
    }
    const translated = applyInputShape(input, inputShape)
    if (translated !== input || Array.isArray(input.edits)) return { toolName, input: translated }
  }
  return undefined
}

/**
 * Restate a stored host tool call's arguments in the provider-facing
 * vocabulary. Only needed where the catalog advertises a schema other than the
 * host's own: a `pi-edit` tool is offered as OpenCode's flat contract under
 * `additionalProperties: false`, so replaying pi's nested `{path, edits}` in
 * history would contradict the schema the model was just given.
 *
 * A multi-edit call cannot be expressed in that flat contract, so it is left in
 * host shape rather than silently dropping replacements; the model only ever
 * authors single edits through this bridge.
 */
export function translateHostToolCallInput(
  toolName: string,
  input: Record<string, unknown>,
  toolInputs: PiToolInputVocabulary | undefined,
): Record<string, unknown> {
  const shape = toolInputs?.[toolName]?.inputShape
  if (shape === "opencode-read") {
    const path = input["path"]
    if (typeof path !== "string") return input
    return peelReadSelector(path) ?? { filePath: path }
  }
  if (shape === "opencode-edit") {
    const path = input["path"]
    const oldString = firstString(input, PI_EDIT_OLD_KEYS)
    const newString = firstString(input, PI_EDIT_NEW_KEYS)
    if (typeof path !== "string" || oldString === undefined || newString === undefined) return input
    return { filePath: path, oldString, newString }
  }
  if (shape === "opencode-todo") {
    return hostTodoToOpenCodeSnapshot(input)
  }
  if (shape === "opencode-glob") {
    const path = input["path"]
    if (typeof path !== "string") return input
    const peeled = peelGlobPath(path)
    const rest: Record<string, unknown> = { pattern: peeled.pattern }
    if (peeled.path !== undefined) rest.path = peeled.path
    if (typeof input["gitignore"] === "boolean") rest.gitignore = input["gitignore"]
    if (typeof input["hidden"] === "boolean") rest.hidden = input["hidden"]
    if (typeof input["limit"] === "number") rest.limit = input["limit"]
    return rest
  }
  if (shape === "opencode-bash") {
    // History must match the advertised `workdir` schema, not host `cwd`.
    const cwd = input["cwd"]
    if (typeof cwd !== "string") return input
    const rest = { ...input }
    delete rest.cwd
    return { ...rest, workdir: cwd }
  }
  if (shape !== "pi-edit") return input
  const edits = input["edits"]
  if (!Array.isArray(edits) || edits.length !== 1) return input
  const [edit] = edits as ReadonlyArray<{ oldText?: unknown; newText?: unknown }>
  if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return input
  const path = input["path"]
  if (typeof path !== "string") return input

  // The advertised contract is `additionalProperties: false`. Pi's own edit
  // schema does not reject unknown keys, so a stored call can carry a
  // model-authored extra (e.g. `explanation`) beyond `path`/`edits`; replaying
  // it here would contradict the schema the model was just shown. Emit only
  // the three keys that schema declares.
  return { filePath: path, oldString: edit.oldText, newString: edit.newText }
}

/**
 * Restate a stored omp `todo` op as an OpenCode snapshot when the catalog
 * advertises `todowrite`. Ops that cannot be expressed as a snapshot stay in
 * host shape rather than inventing a lossy rewrite.
 */
function hostTodoToOpenCodeSnapshot(input: Record<string, unknown>): Record<string, unknown> {
  const op = input["op"]
  // `view` is advertised as empty-schema `todoread`; do not invent a write snapshot.
  if (op === "view") return {}
  if (op === "rm") return { todos: [] }
  if (op !== "init") return input

  const items: Array<{ content: string; status: "pending" | "in_progress" }> = []
  const flat = input["items"]
  if (Array.isArray(flat)) {
    for (const entry of flat) {
      if (typeof entry !== "string" || !entry.trim()) continue
      items.push({ content: entry.trim(), status: items.length === 0 ? "in_progress" : "pending" })
    }
  } else if (Array.isArray(input["list"])) {
    for (const phase of input["list"]) {
      if (!phase || typeof phase !== "object") continue
      const phaseItems = (phase as { items?: unknown }).items
      if (!Array.isArray(phaseItems)) continue
      for (const entry of phaseItems) {
        if (typeof entry !== "string" || !entry.trim()) continue
        items.push({ content: entry.trim(), status: items.length === 0 ? "in_progress" : "pending" })
      }
    }
  }
  if (items.length === 0) return input
  return { todos: items }
}

/** Reconstruct the canonical snapshot represented by one fanned-out host op sequence. */
export function reconstructTodoSnapshotFromHostOps(
  operations: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  let rows: Array<{ content: string; status: OpenCodeTodoStatus }> | undefined
  for (const operation of operations) {
    const op = operation["op"]
    if (op === "init") {
      const snapshot = hostTodoToOpenCodeSnapshot(operation)["todos"]
      if (!Array.isArray(snapshot)) continue
      rows = snapshot
        .filter((row): row is { content: string; status?: unknown } =>
          !!row && typeof row === "object" && typeof (row as { content?: unknown }).content === "string")
        .map(row => ({ content: row.content, status: normalizeOpenCodeTodoStatus(row.status) }))
      continue
    }
    if (op === "rm") {
      rows = []
      continue
    }
    if (!rows) continue
    const task = typeof operation["task"] === "string" ? operation["task"].trim() : ""
    if (!task) continue
    let row = rows.find(item => item.content === task)
    if (!row) {
      row = { content: task, status: "pending" }
      rows.push(row)
    }
    if (op === "done") row.status = "completed"
    else if (op === "drop") row.status = "cancelled"
    else if (op === "start") {
      for (const item of rows) {
        if (item.status === "in_progress") item.status = "pending"
      }
      row.status = "in_progress"
    }
  }
  return rows ? { todos: rows } : undefined
}

/** Restate a stored host call for the OpenCode plugin's continuation prompt. */
export function translateHostSubagentCall(
  toolName: string,
  input: Record<string, unknown>,
  vocabulary: PiSubagentVocabulary | undefined,
): TranslatedSubagentCall | undefined {
  if (!vocabulary || toolName !== vocabulary.hostToolName || typeof input["task"] !== "string") {
    return undefined
  }
  const subagentType = canonicalAgentFor(input["agent"], vocabulary)
  const description =
    typeof input["name"] === "string" && input["name"]
      ? input["name"]
      : `${subagentType} delegated task`
  return {
    toolName: CANONICAL_SUBAGENT_TOOL,
    input: {
      description,
      prompt: input["task"],
      subagent_type: subagentType,
    },
  }
}

export function canonicalToolName(
  toolName: string,
  vocabulary: PiSubagentVocabulary | undefined,
  toolInputs?: PiToolInputVocabulary,
  input?: Record<string, unknown>,
): string {
  const profile = toolInputs?.[toolName]
  if (profile?.extraProviderNames?.includes("todoread") === true && input?.["op"] === "view") {
    return "todoread"
  }
  const renamed = profile?.providerName
  if (renamed) return renamed
  if (!vocabulary) return toolName
  if (toolName === vocabulary.hostToolName) return CANONICAL_SUBAGENT_TOOL
  return vocabulary.hostToolAliases[toolName] ?? toolName
}
