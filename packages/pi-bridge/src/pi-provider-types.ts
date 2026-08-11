/**
 * Host-neutral structural types for the Pi-family provider surface.
 *
 * Deliberately *not* imported from either host's `pi-ai` package: both are
 * optional peers that only exist inside a real host, and their types differ in
 * small but real ways. Structural typing means the host's own (larger) objects
 * satisfy these at runtime without this package depending on either.
 *
 * Verified deltas encoded here as unions rather than assumed away:
 *   • `Context.systemPrompt` — `string[]` on oh-my-pi, `string` on pi.
 *   • `AssistantMessageEvent` — pi adds a `deferred` done-reason, omp adds an
 *     `image_end` event. The emitter only ever produces the shared subset.
 *   • `Tool.parameters` — ArkType on oh-my-pi, TypeBox on pi; both are resolved
 *     to JSON Schema through the host runtime's tool-schema function.
 */

// ── Content blocks ──

export type PiTextContent = { type: "text"; text: string; textSignature?: string }
export type PiThinkingContent = { type: "thinking"; thinking: string; thinkingSignature?: string; itemId?: string }
export type PiRedactedThinkingContent = { type: "redactedThinking"; data: string }
export type PiImageContent = { type: "image"; data: string; mimeType: string; detail?: string }
export type PiToolCall = {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
  [key: string]: unknown
}

export type PiTextOrImageContent = PiTextContent | PiImageContent
export type PiAssistantContent =
  | PiTextContent
  | PiThinkingContent
  | PiRedactedThinkingContent
  | PiImageContent
  | PiToolCall

// ── Usage / messages ──

export type PiUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  reasoningTokens?: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"

export type PiUserMessage = {
  role: "user"
  content: string | PiTextOrImageContent[]
  timestamp?: number
  [key: string]: unknown
}

export type PiDeveloperMessage = {
  role: "developer"
  content: string | PiTextOrImageContent[]
  /**
   * OMP preserves the origin of custom messages here. In particular,
   * background-job completions arrive as `attribution: "agent"` even though
   * the host's LLM-facing role is `developer`.
   */
  attribution?: "user" | "agent"
  timestamp?: number
  [key: string]: unknown
}

export type PiAssistantMessage = {
  role: "assistant"
  content: PiAssistantContent[]
  api: string
  provider: string
  model: string
  usage: PiUsage
  stopReason: PiStopReason
  errorMessage?: string
  timestamp: number
  [key: string]: unknown
}

export type PiToolResultMessage = {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: PiTextOrImageContent[]
  isError: boolean
  timestamp?: number
  [key: string]: unknown
}

export type PiMessage = PiUserMessage | PiDeveloperMessage | PiAssistantMessage | PiToolResultMessage

// ── Tools / context ──

export type PiTool = {
  name: string
  description: string
  /** ArkType (omp) or TypeBox (pi); resolved via the host runtime's tool-schema fn. */
  parameters: unknown
  [key: string]: unknown
}

export type PiContextLike = {
  /** `string[]` on oh-my-pi, `string` on pi. */
  systemPrompt?: string | string[]
  messages: PiMessage[]
  tools?: PiTool[]
}

export type PiToolChoice =
  | "auto"
  | "none"
  | "any"
  | "required"
  | { type: "function"; name: string }
  | { type: "tool"; name: string }

export type PiSimpleStreamOptions = {
  apiKey?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  toolChoice?: PiToolChoice
  reasoning?: string
  sessionId?: string
  [key: string]: unknown
}

export type PiModelLike = {
  id: string
  name?: string
  api: string
  provider: string
  baseUrl?: string
  reasoning?: boolean
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number | null
  maxTokens?: number | null
  [key: string]: unknown
}

// ── Events ──

export type PiAssistantMessageEvent =
  | { type: "start"; partial: PiAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCall; partial: PiAssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: PiAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessage }

export type PiEventStream = {
  push(event: PiAssistantMessageEvent): void
  end(result?: PiAssistantMessage): void
  fail(err: unknown): void
  result(): Promise<unknown>
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

/** The minimal slice of the host's `ExtensionAPI` this bridge depends on. */
export type PiExtensionApi = {
  registerProvider(name: string, config: Record<string, unknown>): void
}
