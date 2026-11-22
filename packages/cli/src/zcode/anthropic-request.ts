/**
 * Anthropic Messages request (as ZCode's `@ai-sdk/anthropic` transport sends
 * it) → AI SDK V3 call options for the consumer provider.
 *
 * Message order and boundaries are preserved; tool results stay structured
 * tool messages (never flattened into prose); native tool names and inputs are
 * mapped to the canonical vocabulary through the request's tool map. Any
 * content path this bridge cannot represent is rejected with a 400 naming it.
 */
import type {
  JSONSchema7,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"
import type { NativeTool, RequestToolMap } from "./tools.js"

export class RequestTranslationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RequestTranslationError"
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new RequestTranslationError(`${path}: ${message}`)
}

/** Top-level fields with a V3 equivalent, or accepted without one. */
const MAPPED_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice", "stream",
  "temperature", "top_p", "top_k", "stop_sequences", "output_config",
])
/**
 * Fields with no canonical equivalent for an arbitrary provider. They are
 * accepted and reported (by name only) instead of failing every request:
 * Anthropic-specific prompt caching, request metadata, thinking budgets and
 * effort/speed hints are upstream-API controls, not conversation content.
 */
const UNMAPPED_FIELDS = new Set(["thinking", "metadata", "cache_control", "speed", "inference_geo", "context_management"])

export type ParsedMessagesRequest = {
  model: string
  stream: boolean
  nativeTools: NativeTool[]
  /** Builds V3 options once the request's tool map is known. */
  build(toolMap: RequestToolMap): { options: LanguageModelV3CallOptions; ignored: string[] }
}

function parseNativeTools(value: unknown): NativeTool[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail("tools", "must be an array")
  return value.map((raw, index) => {
    const path = `tools[${index}]`
    if (!isObject(raw)) fail(path, "must be an object")
    if (raw.type !== undefined && raw.type !== "custom") fail(`${path}.type`, `provider-defined tool type ${JSON.stringify(raw.type)} is not supported`)
    if (typeof raw.name !== "string" || raw.name.length === 0) fail(`${path}.name`, "must be a nonempty string")
    if (raw.description !== undefined && typeof raw.description !== "string") fail(`${path}.description`, "must be a string")
    if (!isObject(raw.input_schema)) fail(`${path}.input_schema`, "must be an object")
    return {
      name: raw.name,
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
      input_schema: raw.input_schema,
    }
  })
}

function optionalNumber(body: Json, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) fail(key, "must be a finite number")
  return value
}

function textBlocks(value: unknown, path: string): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) fail(path, "must be a string or an array of text blocks")
  return value.map((block, index) => {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") fail(`${path}[${index}]`, "must be a text block")
    return block.text
  })
}

function filePart(block: Json, path: string): LanguageModelV3FilePart {
  const source = block.source
  if (!isObject(source)) fail(`${path}.source`, "must be an object")
  if (source.type === "base64") {
    if (typeof source.media_type !== "string" || typeof source.data !== "string") fail(`${path}.source`, "base64 source needs media_type and data")
    return { type: "file", mediaType: source.media_type, data: source.data }
  }
  if (source.type === "url") {
    if (typeof source.url !== "string") fail(`${path}.source.url`, "must be a string")
    let url: URL
    try {
      url = new URL(source.url)
    } catch {
      fail(`${path}.source.url`, "must be an absolute URL")
    }
    const mediaType = block.type === "document" ? "application/pdf" : "image/*"
    return { type: "file", mediaType, data: url }
  }
  if (block.type === "document" && source.type === "text" && typeof source.data === "string") {
    return { type: "file", mediaType: typeof source.media_type === "string" ? source.media_type : "text/plain", data: Buffer.from(source.data, "utf8").toString("base64") }
  }
  fail(`${path}.source.type`, `unsupported ${String(block.type)} source ${JSON.stringify(source.type)}`)
}

function toolResultOutput(block: Json, path: string): LanguageModelV3ToolResultOutput {
  const isError = block.is_error === true
  const content = block.content
  if (content === undefined || content === null) return isError ? { type: "error-text", value: "" } : { type: "text", value: "" }
  if (typeof content === "string") return isError ? { type: "error-text", value: content } : { type: "text", value: content }
  if (!Array.isArray(content)) fail(`${path}.content`, "must be a string or an array of blocks")

  const parts: Extract<LanguageModelV3ToolResultOutput, { type: "content" }>["value"] = []
  content.forEach((item, index) => {
    const itemPath = `${path}.content[${index}]`
    if (!isObject(item)) fail(itemPath, "must be an object")
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text })
      return
    }
    if (item.type === "image" && isObject(item.source)) {
      if (item.source.type === "base64" && typeof item.source.media_type === "string" && typeof item.source.data === "string") {
        parts.push({ type: "image-data", mediaType: item.source.media_type, data: item.source.data })
        return
      }
      if (item.source.type === "url" && typeof item.source.url === "string") {
        parts.push({ type: "image-url", url: item.source.url })
        return
      }
    }
    if (item.type === "document" && isObject(item.source) && item.source.type === "base64"
      && typeof item.source.media_type === "string" && typeof item.source.data === "string") {
      parts.push({ type: "file-data", mediaType: item.source.media_type, data: item.source.data })
      return
    }
    fail(itemPath, `unsupported tool_result content block ${JSON.stringify(item.type)}`)
  })

  const onlyText = parts.every(part => part.type === "text")
  if (isError) {
    if (!onlyText) fail(path, "an error tool_result with non-text content cannot be represented")
    return { type: "error-text", value: parts.map(part => (part as { text: string }).text).join("\n") }
  }
  if (onlyText && parts.length <= 1) return { type: "text", value: parts.length === 1 ? (parts[0] as { text: string }).text : "" }
  return { type: "content", value: parts }
}

export function parseMessagesRequest(raw: unknown): ParsedMessagesRequest {
  if (!isObject(raw)) fail("$", "request body must be a JSON object")
  const body = raw
  for (const key of Object.keys(body)) {
    if (!MAPPED_FIELDS.has(key) && !UNMAPPED_FIELDS.has(key)) fail(key, "unsupported request field")
  }
  if (typeof body.model !== "string" || body.model.length === 0) fail("model", "must be a nonempty string")
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) fail("max_tokens", "must be a positive integer")
  if (!Array.isArray(body.messages)) fail("messages", "must be an array")
  if (body.stream !== undefined && typeof body.stream !== "boolean") fail("stream", "must be a boolean")
  const nativeTools = parseNativeTools(body.tools)
  const messages = body.messages as unknown[]
  const model = body.model
  const maxTokens = body.max_tokens

  const build = (toolMap: RequestToolMap) => {
    const ignored = Object.keys(body).filter(key => UNMAPPED_FIELDS.has(key))
    const prompt: LanguageModelV3Message[] = []

    if (body.system !== undefined) {
      for (const text of textBlocks(body.system, "system")) prompt.push({ role: "system", content: text })
    }

    // tool_use id → canonical tool name, for results that reference it.
    const callNames = new Map<string, string>()

    messages.forEach((rawMessage, index) => {
      const path = `messages[${index}]`
      if (!isObject(rawMessage)) fail(path, "must be an object")
      const role = rawMessage.role
      const content = rawMessage.content

      if (role === "system") {
        // ZCode keeps mid-conversation system notes in place (anthropic-stream-compat.ts).
        for (const text of textBlocks(content, `${path}.content`)) prompt.push({ role: "system", content: text })
        return
      }

      const blocks: Json[] = typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content.map((block, blockIndex) => isObject(block) ? block : fail(`${path}.content[${blockIndex}]`, "must be an object"))
          : fail(`${path}.content`, "must be a string or an array of blocks")

      if (role === "assistant") {
        const parts: Extract<LanguageModelV3Message, { role: "assistant" }>["content"] = []
        blocks.forEach((block, blockIndex) => {
          const blockPath = `${path}.content[${blockIndex}]`
          switch (block.type) {
            case "text":
              if (typeof block.text !== "string") fail(`${blockPath}.text`, "must be a string")
              parts.push({ type: "text", text: block.text })
              return
            case "thinking":
              if (typeof block.thinking !== "string") fail(`${blockPath}.thinking`, "must be a string")
              // The Anthropic signature only authenticates Anthropic-generated reasoning.
              parts.push({ type: "reasoning", text: block.thinking })
              return
            case "redacted_thinking":
              // Opaque, provider-encrypted reasoning from another upstream: not representable.
              if (!ignored.includes("redacted_thinking")) ignored.push("redacted_thinking")
              return
            case "tool_use": {
              if (typeof block.id !== "string" || typeof block.name !== "string") fail(blockPath, "tool_use needs id and name")
              const canonical = toolMap.canonicalName(block.name)
              callNames.set(block.id, canonical)
              parts.push({ type: "tool-call", toolCallId: block.id, toolName: canonical, input: toolMap.canonicalInput(block.name, block.input ?? {}) })
              return
            }
            default:
              fail(`${blockPath}.type`, `unsupported assistant content block ${JSON.stringify(block.type)}`)
          }
        })
        prompt.push({ role: "assistant", content: parts })
        return
      }

      if (role !== "user") fail(`${path}.role`, `unsupported role ${JSON.stringify(role)}`)

      // Consecutive tool_result blocks become one tool message; other blocks
      // become user messages, in their original order.
      let userParts: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = []
      let toolParts: LanguageModelV3ToolResultPart[] = []
      const flushUser = () => {
        if (userParts.length > 0) prompt.push({ role: "user", content: userParts })
        userParts = []
      }
      const flushTool = () => {
        if (toolParts.length > 0) prompt.push({ role: "tool", content: toolParts })
        toolParts = []
      }
      blocks.forEach((block, blockIndex) => {
        const blockPath = `${path}.content[${blockIndex}]`
        if (block.type === "tool_result") {
          flushUser()
          if (typeof block.tool_use_id !== "string") fail(`${blockPath}.tool_use_id`, "must be a string")
          const toolName = callNames.get(block.tool_use_id)
          if (toolName === undefined) fail(`${blockPath}.tool_use_id`, "references no earlier tool_use")
          toolParts.push({ type: "tool-result", toolCallId: block.tool_use_id, toolName, output: toolResultOutput(block, blockPath) })
          return
        }
        flushTool()
        if (block.type === "text") {
          if (typeof block.text !== "string") fail(`${blockPath}.text`, "must be a string")
          userParts.push({ type: "text", text: block.text })
          return
        }
        if (block.type === "image" || block.type === "document") {
          userParts.push(filePart(block, blockPath))
          return
        }
        fail(`${blockPath}.type`, `unsupported user content block ${JSON.stringify(block.type)}`)
      })
      flushTool()
      flushUser()
    })

    const options: LanguageModelV3CallOptions = { prompt, maxOutputTokens: maxTokens }
    if (toolMap.tools.length > 0) options.tools = toolMap.tools
    const temperature = optionalNumber(body, "temperature")
    if (temperature !== undefined) options.temperature = temperature
    const topP = optionalNumber(body, "top_p")
    if (topP !== undefined) options.topP = topP
    const topK = optionalNumber(body, "top_k")
    if (topK !== undefined) options.topK = topK
    if (body.stop_sequences !== undefined) {
      if (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every(value => typeof value === "string")) fail("stop_sequences", "must be an array of strings")
      options.stopSequences = body.stop_sequences as string[]
    }

    if (body.tool_choice !== undefined) {
      const choice = body.tool_choice
      if (!isObject(choice)) fail("tool_choice", "must be an object")
      if (choice.disable_parallel_tool_use !== undefined) ignored.push("tool_choice.disable_parallel_tool_use")
      let mapped: LanguageModelV3ToolChoice
      switch (choice.type) {
        case "auto": mapped = { type: "auto" }; break
        case "any": mapped = { type: "required" }; break
        case "none": mapped = { type: "none" }; break
        case "tool": {
          if (typeof choice.name !== "string") fail("tool_choice.name", "must be a string")
          const canonical = toolMap.canonicalName(choice.name)
          if (!toolMap.has(canonical)) fail("tool_choice.name", `names a tool this request did not advertise (${choice.name})`)
          mapped = { type: "tool", toolName: canonical }
          break
        }
        default:
          fail("tool_choice.type", `unsupported value ${JSON.stringify(choice.type)}`)
      }
      options.toolChoice = mapped
    }

    if (body.output_config !== undefined) {
      const config = body.output_config
      if (!isObject(config)) fail("output_config", "must be an object")
      for (const key of Object.keys(config)) {
        if (key === "format") continue
        if (key === "effort" || key === "task_budget") ignored.push(`output_config.${key}`)
        else fail(`output_config.${key}`, "unsupported field")
      }
      if (config.format !== undefined) {
        const format = config.format
        if (!isObject(format) || format.type !== "json_schema" || !isObject(format.schema)) fail("output_config.format", "only {type:\"json_schema\", schema} is supported")
        options.responseFormat = { type: "json", schema: format.schema as JSONSchema7 }
      }
    }

    return { options, ignored }
  }

  return { model, stream: body.stream === true, nativeTools, build }
}
