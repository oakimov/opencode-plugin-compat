/**
 * ZCode native tool catalog ↔ canonical OpenCode tool vocabulary.
 *
 * Only native tools with a verified mapping are renamed (currently `Read` →
 * `read`; see docs/tool-vocabulary.md). Every other advertised tool — other
 * native tools and MCP tools — passes through with its exact name and schema,
 * so the provider sees every enabled tool. The provider-facing catalog is
 * frozen per session (first nonempty catalog sorted once, newcomers appended
 * sorted), and a call against a tool whose live schema drifted from the frozen
 * descriptor fails closed instead of reaching ZCode with stale arguments.
 */
import type { JSONSchema7 } from "@ai-sdk/provider"
import { createToolCatalogOrder } from "@opencode-compat/opencode-loader"

/** A tool as ZCode advertises it on the Anthropic Messages wire. */
export type NativeTool = {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** A provider-facing (canonical) function tool. */
export type CanonicalTool = {
  type: "function"
  name: string
  description?: string
  inputSchema: JSONSchema7
}

export class ToolMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolMappingError"
  }
}

type Args = Record<string, unknown>

type VerifiedMapping = {
  native: string
  canonical: string
  description: string
  schema: JSONSchema7
  /** Canonical call input → native input. Throws on loss or ambiguity. */
  toNative(input: Args): Args
  /** Native input (history replay) → canonical input. */
  toCanonical(input: Args): Args
  /** The live native schema still has the shape this mapping was verified against. */
  matches(schema: Record<string, unknown>): boolean
}

function isArgs(value: unknown): value is Args {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalInteger(input: Args, key: string, min: number): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ToolMappingError(`read.${key} must be an integer >= ${min}`)
  }
  return value
}

/**
 * OpenCode 1 `read(filePath, offset?, limit?)` ↔ ZCode `Read(file_path,
 * offset?, limit?)`. Both use 1-based line offsets (ZCode treats offset <= 1
 * as line 1: apps/zcode-cli/packages/core/src/tool/handlers/read-text.ts:127).
 * ZCode's PDF-only `pages` has no canonical field and is never synthesized.
 */
const READ_MAPPING: VerifiedMapping = {
  native: "Read",
  canonical: "read",
  description:
    "Read a file from the local filesystem. filePath must be an absolute path. offset is the 1-based line number to start reading from; limit is the number of lines to read. Omit both to read the whole file.",
  schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "The absolute path to the file to read" },
      offset: { type: "integer", minimum: 1, description: "The 1-based line number to start reading from" },
      limit: { type: "integer", minimum: 1, description: "The number of lines to read" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  toNative(input) {
    const unknown = Object.keys(input).filter(key => !["filePath", "offset", "limit"].includes(key))
    if (unknown.length > 0) throw new ToolMappingError(`read has no native field for ${unknown.join(", ")}`)
    if (typeof input.filePath !== "string" || input.filePath.length === 0) throw new ToolMappingError("read.filePath must be a nonempty string")
    const offset = optionalInteger(input, "offset", 1)
    const limit = optionalInteger(input, "limit", 1)
    return { file_path: input.filePath, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }
  },
  toCanonical(input) {
    const { file_path: filePath, ...rest } = input
    return filePath === undefined ? { ...rest } : { filePath, ...rest }
  },
  matches(schema) {
    const properties = isArgs(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    const filePath = properties.file_path
    return isArgs(filePath) && filePath.type === "string"
      && required.every(key => key === "file_path")
      && required.includes("file_path")
      && ["offset", "limit"].every(key => properties[key] === undefined || (isArgs(properties[key]) && ["integer", "number"].includes(String((properties[key] as Args).type))))
  },
}

const VERIFIED: readonly VerifiedMapping[] = [READ_MAPPING]
const BY_NATIVE = new Map(VERIFIED.map(mapping => [mapping.native, mapping]))

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isArgs(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

export type RequestToolMap = {
  /** Provider-facing catalog in frozen session order. */
  tools: CanonicalTool[]
  /** Canonical tool call → native name and JSON input string for the wire. */
  toNativeCall(canonicalName: string, input: string): { name: string; input: string }
  /** True when the request advertised a tool with this canonical name. */
  has(canonicalName: string): boolean
  /** Native name in history → canonical name (identity when unmapped). */
  canonicalName(nativeName: string): string
  /** Native input in history → canonical input (unchanged when unmapped). */
  canonicalInput(nativeName: string, input: unknown): unknown
}

/**
 * Per-session frozen ordering, shared across requests of one bridge process.
 * At most `maxSessions` session catalogs are retained (least recently used out).
 */
export function createSessionToolCatalog(maxSessions?: number) {
  const order = createToolCatalogOrder<CanonicalTool>(maxSessions)

  return (nativeTools: readonly NativeTool[], sessionKey: string | undefined): RequestToolMap => {
    const current = new Map<string, { tool: CanonicalTool; mapping?: VerifiedMapping }>()
    const unmatched = new Set<string>()
    for (const native of nativeTools) {
      // A native schema that no longer matches the verified shape passes through
      // unchanged rather than being called through a stale mapping.
      const candidate = BY_NATIVE.get(native.name)
      const mapping = candidate?.matches(native.input_schema) ? candidate : undefined
      if (candidate && !mapping) unmatched.add(native.name)
      const tool: CanonicalTool = mapping
        ? { type: "function", name: mapping.canonical, description: mapping.description, inputSchema: mapping.schema }
        : {
          type: "function",
          name: native.name,
          ...(native.description !== undefined ? { description: native.description } : {}),
          inputSchema: native.input_schema as JSONSchema7,
        }
      const existing = current.get(tool.name)
      if (existing) {
        throw new ToolMappingError(`tool name collision: two advertised tools map to the provider-facing name "${tool.name}"`)
      }
      current.set(tool.name, { tool, ...(mapping ? { mapping } : {}) })
    }

    const ordered = order([...current.values()].map(entry => entry.tool), sessionKey) ?? []
    // The frozen descriptor may predate a same-name schema change in ZCode.
    const drifted = new Set<string>()
    for (const tool of ordered) {
      const live = current.get(tool.name)!.tool
      if (stableJson(live.inputSchema) !== stableJson(tool.inputSchema)) drifted.add(tool.name)
    }

    // History keeps the vocabulary the provider saw: mapped unless this request
    // advertises the native tool with a schema the mapping does not match.
    const replayMapping = (nativeName: string) => unmatched.has(nativeName) ? undefined : BY_NATIVE.get(nativeName)

    return {
      tools: ordered,
      has: name => current.has(name),
      canonicalName: nativeName => replayMapping(nativeName)?.canonical ?? nativeName,
      canonicalInput(nativeName, input) {
        const mapping = replayMapping(nativeName)
        return mapping && isArgs(input) ? mapping.toCanonical(input) : input
      },
      toNativeCall(canonicalName, input) {
        const entry = current.get(canonicalName)
        if (!entry) throw new ToolMappingError(`provider called "${canonicalName}", which this request did not advertise`)
        if (drifted.has(canonicalName)) {
          throw new ToolMappingError(`tool "${canonicalName}" changed its schema during the session; refusing a call made against the stale descriptor`)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(input.trim() === "" ? "{}" : input)
        } catch {
          throw new ToolMappingError(`${canonicalName} call input is not valid JSON`)
        }
        if (!isArgs(parsed)) throw new ToolMappingError(`${canonicalName} call input must be a JSON object`)
        return entry.mapping
          ? { name: entry.mapping.native, input: JSON.stringify(entry.mapping.toNative(parsed)) }
          : { name: canonicalName, input: input.trim() === "" ? "{}" : input }
      },
    }
  }
}
