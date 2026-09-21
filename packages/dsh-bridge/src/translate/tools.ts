/**
 * Bidirectional DSH ↔ OpenCode tool vocabulary.
 * Catalog and history replay: host names/keys → OpenCode names/keys.
 * Streamed calls: OpenCode names/keys → host names/keys.
 * Vocabulary is data in `host/profile.ts`.
 */
import { dshToolInputs, type DshToolInputProfile } from "../host/profile.js"
import {
  translateToHostQuestionInput,
  translateToProviderQuestionInput,
} from "./question.js"
import { translateToHostTodoInput } from "./todo.js"

export type DshToolInputVocabulary = Readonly<Record<string, DshToolInputProfile>>

/** Host catalog name → advertised OpenCode name. */
export function canonicalToolName(
  hostName: string,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): string {
  return toolInputs[hostName]?.providerName ?? hostName
}

/** Advertised OpenCode name → host catalog name. */
export function hostToolName(
  providerName: string,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): string {
  if (Object.hasOwn(toolInputs, providerName)) return providerName
  for (const [hostName, profile] of Object.entries(toolInputs)) {
    if (profile.providerName === providerName) return hostName
  }
  return providerName
}

/** Same fill as clone-path `defaultBashDescription` — do not import adapter. */
export function defaultBashDescription(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : ""
  if (!text) return "Run shell command"
  const first = text.split(/\s+/)[0] || "command"
  const clipped = text.length > 60 ? `${text.slice(0, 57)}...` : text
  return `Run: ${clipped || first}`
}

function rewriteKeys(
  input: Record<string, unknown>,
  aliases: Readonly<Record<string, string>>,
): Record<string, unknown> {
  if (Object.keys(aliases).length === 0) return input
  const translated = { ...input }
  let changed = false
  for (const [from, to] of Object.entries(aliases)) {
    if (!Object.hasOwn(translated, from)) continue
    if (!Object.hasOwn(translated, to)) translated[to] = translated[from]
    delete translated[from]
    changed = true
  }
  return changed ? translated : input
}

function withBashDescription(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.description === "string" && input.description.trim().length > 0) return input
  return { ...input, description: defaultBashDescription(input.command) }
}

export function translateProviderToolCallInput(
  toolName: string,
  input: Record<string, unknown>,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): Record<string, unknown> {
  const hostName = hostToolName(toolName, toolInputs)
  const profile = toolInputs[hostName]
  const rewritten = profile ? rewriteKeys(input, profile.inputAliases) : input
  if (hostName === "bash") return withBashDescription(rewritten)
  if (profile?.providerName === "question") return translateToHostQuestionInput(rewritten)
  if (hostName === "todo_write") return translateToHostTodoInput(rewritten)
  return rewritten
}

export type RewrittenHostToolCall = {
  name: string
  input: Record<string, unknown>
}

/** Provider tool-call → host name + args. */
export function rewriteProviderToolCall(
  providerName: string,
  input: Record<string, unknown>,
  options?: { toolInputs?: DshToolInputVocabulary },
): RewrittenHostToolCall {
  const toolInputs = options?.toolInputs ?? dshToolInputs()
  const hostName = hostToolName(providerName, toolInputs)
  const translated = translateProviderToolCallInput(providerName, input, toolInputs)
  return { name: hostName, input: translated }
}

export function rewriteHostToolCallJson(
  providerName: string,
  json: string,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): { name: string; arguments: string } {
  const hostName = hostToolName(providerName, toolInputs)
  if (json.length === 0) return { name: hostName, arguments: json }
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { name: hostName, arguments: json }
    }
    const rewritten = rewriteProviderToolCall(
      providerName,
      parsed as Record<string, unknown>,
      { toolInputs },
    )
    return { name: rewritten.name, arguments: JSON.stringify(rewritten.input) }
  } catch {
    return { name: hostName, arguments: json }
  }
}

export function translateHostToolCallInput(
  toolName: string,
  input: Record<string, unknown>,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): Record<string, unknown> {
  const profile = toolInputs[toolName]
  if (!profile) return input
  const rewritten = rewriteKeys(input, profile.providerKeys)
  if (profile.providerName === "question") return translateToProviderQuestionInput(rewritten)
  return rewritten
}

/** DSH `BlockAssembler` treats `block-end.arguments` as authoritative. */
export function hostToolCallArgumentsJson(
  toolName: string,
  json: string,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): string {
  if (json.length === 0) return json
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json
    const translated = translateProviderToolCallInput(toolName, parsed as Record<string, unknown>, toolInputs)
    if (translated === parsed) return json
    return JSON.stringify(translated)
  } catch {
    return json
  }
}

/** UTF-16 code-unit order (JavaScript string comparison). */
export function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function providerToolSchema(
  parameters: Record<string, unknown>,
  toolName: string,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
): Record<string, unknown> {
  const profile = toolInputs[toolName]
  if (!profile) return parameters
  const properties = parameters.properties
  const hasProps = properties !== undefined && typeof properties === "object" && !Array.isArray(properties)
  const nextProperties: Record<string, unknown> = {}
  let renamed = false
  if (hasProps) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const next = profile.providerKeys[key] ?? key
      if (next !== key) renamed = true
      nextProperties[next] = value
    }
  }
  // Host schemas enumerate properties in authoring order; emit sorted so the
  // same catalog always serializes to the same overlay bytes (cache stability).
  const sortedProperties: Record<string, unknown> = {}
  for (const key of Object.keys(nextProperties).sort(compareCanonicalKeys)) {
    sortedProperties[key] = nextProperties[key]
  }
  const orderChanged = hasProps
    && Object.keys(nextProperties).some((key, index) => key !== Object.keys(sortedProperties)[index])
  const required = parameters.required
  const mappedRequired = Array.isArray(required)
    ? required.map(key => typeof key === "string" ? (profile.providerKeys[key] ?? key) : key)
    : required
  const drop = new Set(profile.dropRequired ?? [])
  const nextRequired = Array.isArray(mappedRequired)
    ? mappedRequired.filter(key => typeof key !== "string" || !drop.has(key))
    : mappedRequired
  const sortedRequired = Array.isArray(nextRequired) ? [...nextRequired].sort(compareCanonicalKeys) : nextRequired
  const requiredChanged = Array.isArray(required) && Array.isArray(sortedRequired)
    && (required.length !== sortedRequired.length || required.some((key, index) => key !== sortedRequired[index]))
  if (!renamed && !orderChanged && !requiredChanged) return parameters
  return {
    ...parameters,
    ...(hasProps ? { properties: sortedProperties } : {}),
    ...(sortedRequired !== undefined ? { required: sortedRequired } : {}),
  }
}
