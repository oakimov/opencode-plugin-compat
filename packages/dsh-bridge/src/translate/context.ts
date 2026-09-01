/**
 * DSH `GenerateOptions` (messages/system/tools) → AI-SDK V3 prompt/tools.
 * Oriented on `packages/pi-bridge/src/translate/context.ts` and
 * DSH `packages/llm/llm-pi-ai/src/context.ts` (tool results are user-role
 * messages with `source.kind === "tool"` / `tool-result` blocks).
 */
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"

export type DshToolSchema = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type DshMessage = {
  role: "system" | "user" | "assistant"
  content: any[]
  source: { kind: string; callId?: unknown; [k: string]: unknown }
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

export function translateGenerateOptionsToPrompt(options: DshGenerateOptions): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []
  const system = normalizeSystemPrompt(options.system)
  if (system) prompt.push({ role: "system", content: system })

  const toolNames = new Map<string, string>()

  for (const msg of options.messages) {
    if (msg.role === "system") {
      const text = flattenBlockText(msg.content)
      if (text) prompt.push({ role: "system", content: text })
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
          if (name.length > 0) toolNames.set(block.id, name)
          items.push({ type: "tool-call", toolCallId: block.id, toolName: name, input })
        }
      }
      if (items.length > 0) prompt.push({ role: "assistant", content: items })
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
      prompt.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName: toolNames.get(id) ?? "unknown",
          output: toolResultOutput(result),
        }],
      })
    }
  }
  return prompt
}

export function translateTools(tools?: DshToolSchema[]): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as any,
  }))
}
