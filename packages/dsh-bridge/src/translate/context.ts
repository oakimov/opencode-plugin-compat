/**
 * DSH `GenerateOptions` (messages/system/tools) → AI-SDK V3 prompt/tools.
 * Oriented on `packages/pi-bridge/src/translate/context.ts` and
 * DSH `packages/llm/llm-pi-ai/src/context.ts` (tool results are user-role
 * messages with `source.kind === "tool"` / `tool-result` blocks).
 */
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { homedir } from "node:os"
import { dshProfile, dshToolInputs } from "../host/profile.js"
import { hostToolRenames, translatePromptToolNames } from "@opencode-compat/opencode-loader"
import {
  canonicalQuestionDescription,
  canonicalQuestionSchema,
  formatOpenCodeQuestionResult,
  questionPromptsFromInput,
} from "./question.js"
import { formatOpenCodeGrepResult } from "./grep.js"
import {
  canonicalToolName,
  compareCanonicalKeys,
  providerToolSchema,
  translateHostToolCallInput,
  type DshToolInputVocabulary,
} from "./tools.js"

export type DshToolSchema = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type DshMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: any[]
  source: { kind: string; callId?: unknown; [k: string]: unknown }
  toolCallId?: string
  isError?: boolean
}

export type DshGenerateOptions = {
  provider: string
  model: string
  reasoningEffort?: string
  messages: DshMessage[]
  system?: string
  tools?: DshToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: string
}

export function normalizeSystemPrompt(system?: string | string[]): string | undefined {
  if (!system) return undefined
  const text = Array.isArray(system) ? system.filter((s) => s.length > 0).join("\n\n") : system
  return text.length > 0 ? text : undefined
}

function flattenBlockText(blocks: unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ""
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    const rec = block as { type?: string; text?: unknown; content?: unknown; attachment?: { mediaType?: string; width?: number; height?: number } }
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text)
    else if (rec.type === "reasoning" && typeof rec.text === "string") parts.push(rec.text)
    else if (rec.type === "image") {
      const att = rec.attachment
      const media = typeof att?.mediaType === "string" ? att.mediaType : "image"
      const size = typeof att?.width === "number" && typeof att?.height === "number" ? ` ${att.width}x${att.height}` : ""
      parts.push(`[image ${media}${size}]`)
    } else if (rec.type === "tool-result" && Array.isArray(rec.content)) {
      parts.push(flattenBlockText(rec.content))
    }
  }
  return parts.join("\n")
}

function toolResultOutput(block: { content?: unknown; isError?: boolean }): { type: "text" | "error-text"; value: string } {
  const text = flattenBlockText(Array.isArray(block.content) ? block.content : undefined)
  const value = text.length > 0 ? text : "(no output)"
  return { type: block.isError ? "error-text" : "text", value }
}

/** DSH `source.kind` of its skill catalog reminder (`packages/skill/tool-skill`). */
export const SKILL_CATALOG_SOURCE = "skill-catalog"

function isSkillCatalog(message: DshMessage): boolean {
  return message.role === "user" && message.source?.kind === SKILL_CATALOG_SOURCE
}

/**
 * OpenCode and Pi put `<available_skills>` in the system prompt. DSH sends it
 * as a user-role reminder instead, so on the first turn its "call the `skill`
 * tool before taking task actions" reads as part of the user's request. A
 * later catalog replaces every earlier one, so only the latest is current.
 */
function latestSkillCatalog(messages: readonly DshMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (!isSkillCatalog(message)) continue
    const text = flattenBlockText(message.content)
    if (text) return text
  }
  return undefined
}

/**
 * Host file tools resolve `~` literally, so a request that offers them tells
 * the model the home directory instead of leaving it to guess one.
 */
export function homePathNote(
  tools: readonly { name: string }[] | undefined,
  profile = dshProfile(),
  home: string = process.env.HOME || homedir(),
): string | undefined {
  if (profile.fileToolsExpandTilde || !home) return undefined
  if (!tools?.some(tool => profile.existingPaths?.[tool.name])) return undefined
  return `Host file tools do not expand "~". The home directory is "${home}"; use absolute paths.`
}

export function translateGenerateOptionsToPrompt(
  options: DshGenerateOptions,
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
  excludedToolNames?: ReadonlySet<string>,
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []
  // The host prompt names tools in host vocabulary; restate the ones this call
  // renames so the prompt matches the canonical catalog.
  const renames = hostToolRenames((options.tools ?? []).map((tool) => tool.name), (name) => canonicalToolName(name, toolInputs))
  const system = [normalizeSystemPrompt(options.system), latestSkillCatalog(options.messages), homePathNote(options.tools)]
    .filter((part): part is string => !!part)
    .join("\n\n")
  if (system) prompt.push({ role: "system", content: translatePromptToolNames(system, renames) })

  const toolNames = new Map<string, string>()
  const excludedToolCallIds = new Set<string>()
  const questionPrompts = new Map<string, ReturnType<typeof questionPromptsFromInput>>()

  for (const msg of options.messages) {
    if (isSkillCatalog(msg)) continue
    if (msg.role === "system") {
      const text = flattenBlockText(msg.content)
      if (text) prompt.push({ role: "system", content: translatePromptToolNames(text, renames) })
      continue
    }

    if (msg.role === "assistant") {
      const items: any[] = []
      for (const block of msg.content ?? []) {
        if (!block || typeof block !== "object") continue
        if (block.type === "text" && typeof block.text === "string") items.push({ type: "text", text: block.text })
        else if (block.type === "reasoning" && typeof block.text === "string") items.push({ type: "reasoning", text: block.text })
        else if (block.type === "tool-call" && typeof block.id === "string") {
          let input: unknown = {}
          try { input = JSON.parse(block.arguments ?? "{}") } catch { input = {} }
          const name = typeof block.name === "string" ? block.name : ""
          if (excludedToolNames?.has(name)) {
            excludedToolCallIds.add(block.id)
            continue
          }
          const providerName = canonicalToolName(name, toolInputs)
          if (name.length > 0) toolNames.set(block.id, providerName)
          if (providerName === "question") {
            questionPrompts.set(block.id, questionPromptsFromInput(input))
          }
          if (input && typeof input === "object" && !Array.isArray(input)) {
            input = translateHostToolCallInput(name, input as Record<string, unknown>, toolInputs)
          }
          items.push({ type: "tool-call", toolCallId: block.id, toolName: providerName, input })
        }
      }
      if (items.length > 0) prompt.push({ role: "assistant", content: items })
      continue
    }

    // Current DSH stores tool results as first-class tool-role messages with
    // text content and the call id on the message, not a user-role block.
    // Preserve that role so the provider continues its held-open Cursor Run.
    if (msg.role === "tool") {
      const id = typeof msg.toolCallId === "string" ? msg.toolCallId
        : typeof msg.source?.callId === "string" ? msg.source.callId : ""
      // A result without its tool call (compacted/evicted history) cannot be
      // correlated by the provider; drop it rather than invent a tool name.
      const toolName = toolNames.get(id)
      if (!id || excludedToolCallIds.has(id) || !toolName) continue
      const value = flattenBlockText(msg.content)
      const prompts = questionPrompts.get(id)
      const formatted = msg.isError ? undefined
        : prompts && prompts.length > 0 ? formatOpenCodeQuestionResult(prompts, value)
        : toolName === "grep" ? formatOpenCodeGrepResult(value)
        : undefined
      prompt.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName,
          output: { type: msg.isError ? "error-text" : "text", value: formatted ?? (value || "(no output)") },
        }],
      })
      continue
    }

    const regular: any[] = []
    const results: any[] = []
    for (const block of msg.content ?? []) {
      if (!block || typeof block !== "object") continue
      if (block.type === "tool-result") results.push(block)
      else if (block.type === "text" && typeof block.text === "string") regular.push({ type: "text", text: block.text })
      else if (block.type === "image") {
        const text = flattenBlockText([block])
        if (text) regular.push({ type: "text", text })
      }
    }
    if (regular.length > 0 || results.length === 0) {
      if (regular.length > 0) prompt.push({ role: "user", content: regular })
    }
    for (const result of results) {
      const toolCallId = typeof result.toolCallId === "string" ? result.toolCallId : ""
      const sourceCallId = msg.source?.kind === "tool" && typeof msg.source.callId === "string" ? msg.source.callId : ""
      const id = sourceCallId || toolCallId
      const toolName = toolNames.get(id)
      if (excludedToolCallIds.has(id) || !toolName) continue
      const output = toolResultOutput(result)
      const prompts = questionPrompts.get(id)
      if (prompts && prompts.length > 0 && output.type === "text") {
        const formatted = formatOpenCodeQuestionResult(prompts, output.value)
        if (formatted) output.value = formatted
      } else if (toolName === "grep" && output.type === "text") {
        output.value = formatOpenCodeGrepResult(output.value)
      }
      prompt.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName,
          output,
        }],
      })
    }
  }
  return prompt
}

export function translateTools(
  tools?: DshToolSchema[],
  toolInputs: DshToolInputVocabulary = dshToolInputs(),
  excludedToolNames?: ReadonlySet<string>,
): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  // UTF-16 code-unit order (same as pi/clone/provider): host insertion
  // order must not reshuffle overlay bytes between turns (cache stability).
  const translated = tools.filter(t => !excludedToolNames?.has(t.name)).map((t) => {
    const providerName = canonicalToolName(t.name, toolInputs)
    const question = toolInputs[t.name]?.providerName === "question"
    return {
      type: "function" as const,
      name: providerName,
      description: question ? canonicalQuestionDescription() : (toolInputs[t.name]?.providerDescription ?? t.description),
      inputSchema: (question
        ? canonicalQuestionSchema(t.parameters)
        : providerToolSchema(t.parameters, t.name, toolInputs)) as any,
    }
  }).sort((left, right) => compareCanonicalKeys(left.name, right.name))
  return translated.length > 0 ? translated : undefined
}
