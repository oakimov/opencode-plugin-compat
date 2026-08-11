/**
 * Pi `Context` (systemPrompt/messages/tools) → AI-SDK V3 call inputs.
 * One-directional: the host builds its own `ToolResultMessage` from a tool's
 * execute() result, so nothing here translates the reverse.
 *
 * Host-neutral: `systemPrompt` is `string[]` on oh-my-pi but a plain `string`
 * on pi, so both are accepted.
 */
import type {
  JSONSchema7,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"
import type {
  PiAssistantMessage,
  PiContextLike,
  PiTextContent,
  PiTextOrImageContent,
  PiTool,
  PiToolChoice,
  PiToolResultMessage,
} from "../pi-provider-types.js"

/** Resolves a host `Tool`'s parameters (ArkType / TypeBox / JSON Schema) to JSON Schema. */
export type ToolSchemaFn = (tool: PiTool) => Record<string, unknown>

function flattenTextAndImages(
  content: string | PiTextOrImageContent[],
): Array<{ type: "text"; text: string } | { type: "file"; data: string; mediaType: string }> {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : []
  return content.map(part => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "file" as const, data: part.data, mediaType: part.mimeType }))
}

function flattenToPlainText(content: string | PiTextOrImageContent[]): string {
  if (typeof content === "string") return content
  return content
    .filter((part): part is PiTextContent => part.type === "text")
    .map(part => part.text)
    .join("\n")
}

/**
 * Tool result → AI-SDK V3 output.
 *
 * A result carrying images uses the multimodal `{type:"content", value:[…]}`
 * form with `file-data` parts, so the image bytes reach the provider intact.
 * Text-only results keep the simpler `text`/`error-text` form, which is what
 * every provider handles and avoids churn for the common case.
 */
function toolResultOutputFromPi(result: PiToolResultMessage): LanguageModelV3ToolResultPart["output"] {
  const isError = result.isError
  if (typeof result.content === "string") {
    return { type: isError ? "error-text" : "text", value: result.content }
  }

  const hasImages = result.content.some(part => part.type === "image")
  if (!hasImages) {
    return { type: isError ? "error-text" : "text", value: flattenToPlainText(result.content) }
  }

  return {
    type: "content",
    value: result.content.map(part =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "file-data" as const, data: part.data, mediaType: part.mimeType },
    ),
  }
}

function assistantMessageToV3(message: PiAssistantMessage) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "file"; data: string; mediaType: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = []
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
    else if (block.type === "thinking") content.push({ type: "reasoning", text: block.thinking })
    else if (block.type === "image") content.push({ type: "file", data: block.data, mediaType: block.mimeType })
    else if (block.type === "toolCall") {
      content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments })
    }
    // `redactedThinking` is provider-opaque and has no V3 prompt-part; it is the
    // one block kind without a faithful mapping.
  }
  return { role: "assistant" as const, content }
}

/** Normalize either host's `systemPrompt` shape to a single string. */
export function normalizeSystemPrompt(systemPrompt: string | string[] | undefined): string | undefined {
  if (systemPrompt === undefined) return undefined
  const text = Array.isArray(systemPrompt) ? systemPrompt.filter(s => s.length > 0).join("\n\n") : systemPrompt
  return text.length > 0 ? text : undefined
}

/** Translate a host Context into an AI-SDK V3 `prompt` array (system + history). */
export function translateContextToPrompt(context: PiContextLike): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []

  const systemText = normalizeSystemPrompt(context.systemPrompt)
  if (systemText) prompt.push({ role: "system", content: systemText })

  for (const message of context.messages) {
    if (message.role === "user") {
      prompt.push({ role: "user", content: flattenTextAndImages(message.content) })
    } else if (message.role === "developer") {
      // No `developer` role in AI-SDK V3 prompts; fold into `system` like most
      // non-OpenAI wire protocols do. Images have no `system` equivalent.
      const text = flattenToPlainText(message.content)
      if (text.length > 0) prompt.push({ role: "system", content: text })
    } else if (message.role === "assistant") {
      prompt.push(assistantMessageToV3(message))
    } else if (message.role === "toolResult") {
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: toolResultOutputFromPi(message),
          },
        ],
      })
    }
  }

  return prompt
}

/** Translate host tools into AI-SDK V3 function tools. */
export function translateTools(tools: PiTool[] | undefined, toSchema: ToolSchemaFn): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: toSchema(tool) as unknown as JSONSchema7,
  }))
}

/** Translate the host's `toolChoice` into AI-SDK V3's shape. */
export function translateToolChoice(choice: PiToolChoice | undefined): LanguageModelV3ToolChoice | undefined {
  if (choice === undefined || choice === "auto") return undefined
  if (choice === "none") return { type: "none" }
  if (choice === "any" || choice === "required") return { type: "required" }
  if (typeof choice === "object" && "name" in choice) return { type: "tool", toolName: choice.name }
  return undefined
}
