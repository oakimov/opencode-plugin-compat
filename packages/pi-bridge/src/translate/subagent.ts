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
  return [...names].sort()
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

export function canonicalSubagentDescription(vocabulary: PiSubagentVocabulary): string {
  const agents = canonicalAgentNames(vocabulary)
  const catalog = agents.length > 0 ? ` Available agent types: ${agents.join(", ")}.` : ""
  const lifecycle = vocabulary.coordinationToolName
    ? ` Each call starts a new agent; never call task to poll or resume one. Results auto-deliver. Use the host's built-in ${vocabulary.coordinationToolName} tool for status and follow-up; it is not an MCP server.`
    : ""
  return `Launch a specialized agent for an isolated delegated task.${catalog}${lifecycle}`
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
 * omp accepts only `path` and embeds line ranges inline
 * (`path:150-229`). Without this conversion the host silently drops
 * `offset`/`limit` and returns the head on every paged read, so the model
 * cannot advance past line 1 of a large file. `offset` is 1-indexed; `limit`
 * is a line count — matching the host's `:N-M` inclusive grammar.
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

  const selector = offset !== undefined && limit !== undefined
    ? `${offset}-${end}`
    : offset !== undefined
      ? `${offset}`
      : `1-${limit}`

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

/**
 * Fold an OpenCode/Cursor todo snapshot into one omp `todo` op.
 *
 * omp requires `op`; Cursor keeps emitting `{todos:[{content,status,…}]}` and
 * gets `op must be operation to apply (was missing)`. Active items become a
 * flat `init`; a snapshot with no remaining open work clears via `rm`. Native
 * `{op:…}` calls pass through with harness-only keys stripped.
 */
function applyTodoShape(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input["op"] === "string" && input["op"]) {
    const rest = { ...input }
    for (const key of OPENCODE_TODO_HARNESS_KEYS) delete rest[key]
    return rest
  }

  const todos = input["todos"]
  if (!Array.isArray(todos)) return input

  const active: string[] = []
  const inProgress: string[] = []
  for (const entry of todos) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const content = record["content"]
    if (typeof content !== "string" || !content.trim()) continue
    const status = normalizeOpenCodeTodoStatus(record["status"])
    if (status === "completed" || status === "cancelled") continue
    const trimmed = content.trim()
    if (status === "in_progress") inProgress.push(trimmed)
    else active.push(trimmed)
  }

  const items = [...inProgress, ...active]
  if (items.length === 0) return { op: "rm" }
  return { op: "init", items }
}

/**
 * Pi's edit tool is structurally different from OpenCode's replacement tool:
 * it requires `edits: [{ oldText, newText }]`. Models sometimes retain another
 * vocabulary even after receiving Pi's nested schema, so perform the conversion
 * at the last boundary before Pi validates the call.
 */
function applyInputShape(
  input: Record<string, unknown>,
  shape: "pi-edit" | "opencode-edit" | "opencode-read" | "opencode-todo" | undefined,
): Record<string, unknown> {
  if (shape === "opencode-read") return applyReadShape(input)
  if (shape === "opencode-todo") return applyTodoShape(input)
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
): TranslatedSubagentCall | undefined {
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
    return { toolName: hostToolName, input: applyInputShape(translated, profile.inputShape) }
  }

  const inputProfile = toolInputs?.[toolName]
  if (!inputProfile) return undefined
  const { inputAliases, dropInputKeys, inputShape } = inputProfile

  const rewrites =
    Object.keys(inputAliases).some(name => Object.hasOwn(input, name)) ||
    dropInputKeys?.some(name => Object.hasOwn(input, name)) === true
  if (rewrites) {
    const translated = rewriteInputKeys(input, inputAliases, dropInputKeys)
    return { toolName, input: applyInputShape(translated, inputShape) }
  }
  if (inputShape) {
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
    return typeof path === "string" ? { filePath: path } : input
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
