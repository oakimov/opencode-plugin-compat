/**
 * Pi `Context` (systemPrompt/messages/tools) → AI-SDK V3 call inputs.
 * The optional subagent vocabulary restates stored host calls/results in the
 * OpenCode shape the plugin saw in its tool catalog.
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
import type { PiHostProfile } from "../host/profile.js"
import {
  canonicalSubagentDescription,
  canonicalSubagentSchema,
  canonicalToolName,
  translateHostSubagentCall,
  type PiSubagentVocabulary,
  type PiToolInputVocabulary,
} from "./subagent.js"

/** Resolves a host `Tool`'s parameters (ArkType / TypeBox / JSON Schema) to JSON Schema. */
export type ToolSchemaFn = (tool: PiTool) => Record<string, unknown>

/** Provider-facing OpenCode edit contract; Pi's nested host schema is internal. */
const OPENCODE_EDIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    oldString: { type: "string", description: "Exact text to replace" },
    newString: { type: "string", description: "Replacement text" },
    replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
  },
  required: ["filePath", "oldString", "newString"],
  additionalProperties: false,
}

function providerToolSchema(
  tool: PiTool,
  toSchema: ToolSchemaFn,
  toolInputs: PiToolInputVocabulary | undefined,
): Record<string, unknown> {
  if (toolInputs?.[tool.name]?.inputShape === "pi-edit") return OPENCODE_EDIT_SCHEMA
  return toSchema(tool)
}

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

function assistantMessageToV3(
  message: PiAssistantMessage,
  vocabulary: PiSubagentVocabulary | undefined,
  toolInputs?: PiToolInputVocabulary,
) {
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
      const translated = translateHostSubagentCall(block.name, block.arguments, vocabulary)
      content.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: translated?.toolName ?? canonicalToolName(block.name, vocabulary, toolInputs),
        input: translated?.input ?? block.arguments,
      })
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
export function translateContextToPrompt(
  context: PiContextLike,
  vocabulary?: PiSubagentVocabulary,
  profile?: PiHostProfile,
  toolInputs?: PiToolInputVocabulary,
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []

  const systemText = normalizeSystemPrompt(context.systemPrompt)
  if (systemText) prompt.push({ role: "system", content: systemText })

  for (const message of context.messages) {
    if (message.role === "user") {
      prompt.push({ role: "user", content: flattenTextAndImages(message.content) })
    } else if (message.role === "developer") {
      // OMP converts custom messages to `developer` because Pi's message union
      // has no custom role, but retains their origin as `attribution: "agent"`.
      // Async subagent results use that shape to wake the parent. They must be
      // a new provider-facing turn: folding them into system context leaves the
      // original user request as the latest user message, so providers that
      // separate history from the live request execute the request again.
      const wake = profile?.messages?.agentDeveloperWake
      const wakeText = flattenToPlainText(message.content)
      const isAgentWake =
        message.attribution === "agent" &&
        wake !== undefined &&
        wakeText.startsWith(wake.startsWith) &&
        wake.includes.every(marker => wakeText.toLowerCase().includes(marker.toLowerCase()))
      if (isAgentWake) {
        prompt.push({ role: "user", content: flattenTextAndImages(message.content) })
        continue
      }

      // No `developer` role in AI-SDK V3 prompts; fold into `system` like most
      // non-OpenAI wire protocols do. Images have no `system` equivalent.
      const text = flattenToPlainText(message.content)
      if (text.length > 0) prompt.push({ role: "system", content: text })
    } else if (message.role === "assistant") {
      prompt.push(assistantMessageToV3(message, vocabulary, toolInputs))
    } else if (message.role === "toolResult") {
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: canonicalToolName(message.toolName, vocabulary, toolInputs),
            output: toolResultOutputFromPi(message),
          },
        ],
      })
    }
  }

  return prompt
}

/** Translate host tools into AI-SDK V3 function tools. */
export function translateTools(
  tools: PiTool[] | undefined,
  toSchema: ToolSchemaFn,
  vocabulary?: PiSubagentVocabulary,
  toolInputs?: PiToolInputVocabulary,
): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(tool =>
    vocabulary && tool.name === vocabulary.hostToolName
      ? {
          type: "function" as const,
          name: "task",
          description: canonicalSubagentDescription(vocabulary),
          inputSchema: canonicalSubagentSchema(vocabulary) as JSONSchema7,
        }
      : {
          type: "function" as const,
          name: canonicalToolName(tool.name, vocabulary, toolInputs),
          description: tool.description,
          inputSchema: providerToolSchema(tool, toSchema, toolInputs) as unknown as JSONSchema7,
        },
  )
}

/** Translate the host's `toolChoice` into AI-SDK V3's shape. */
export function translateToolChoice(
  choice: PiToolChoice | undefined,
  vocabulary?: PiSubagentVocabulary,
  toolInputs?: PiToolInputVocabulary,
): LanguageModelV3ToolChoice | undefined {
  if (choice === undefined || choice === "auto") return undefined
  if (choice === "none") return { type: "none" }
  if (choice === "any" || choice === "required") return { type: "required" }
  if (typeof choice === "object" && "name" in choice) {
    return { type: "tool", toolName: canonicalToolName(choice.name, vocabulary, toolInputs) }
  }
  return undefined
}
