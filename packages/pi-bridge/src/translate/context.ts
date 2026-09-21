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
  isOpsTodoHostTool,
  originalTodoFanoutId,
  reconstructTodoSnapshotFromHostOps,
  translateHostSubagentCall,
  translateHostToolCallInput,
  type PiSubagentVocabulary,
  type PiTerminalResultVocabulary,
  type PiToolInputVocabulary,
} from "./subagent.js"
import {
  CANONICAL_QUESTION_TOOL,
  canonicalQuestionDescription,
  canonicalQuestionSchema,
  canonicalQuestionToolName,
  translateHostQuestionCall,
  type PiQuestionVocabulary,
} from "./question.js"

/** Resolves a host `Tool`'s parameters (ArkType / TypeBox / JSON Schema) to JSON Schema. */
export type ToolSchemaFn = (tool: PiTool) => Record<string, unknown>

/**
 * Provider-facing OpenCode edit contract; Pi's nested host schema is internal.
 *
 * No `replaceAll`: pi 0.84.1 `edit-diff.ts` `applyEditsToNormalizedContent`
 * rejects any `oldText` matching more than once, so replace-every-occurrence
 * has no host implementation to map onto. Advertising it under
 * `additionalProperties: false` would invite a call the bridge can only answer
 * with pi's confusing duplicate-match error, so the uniqueness requirement is
 * stated on `oldString` instead.
 */
const OPENCODE_EDIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    oldString: { type: "string", description: "Exact text to replace. Must match exactly once in the file." },
    newString: { type: "string", description: "Replacement text" },
  },
  required: ["filePath", "oldString", "newString"],
  additionalProperties: false,
}

const OPENCODE_REPLACE_EDIT_SCHEMA: Record<string, unknown> = {
  ...OPENCODE_EDIT_SCHEMA,
  properties: {
    ...(OPENCODE_EDIT_SCHEMA.properties as Record<string, unknown>),
    replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
  },
}

const OPENCODE_READ_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description:
        "Exactly one file location, relative or absolute. Never join multiple locations with ; , or |.",
    },
    offset: { type: "integer", minimum: 1, description: "1-indexed line number to start reading from" },
    limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
  },
  required: ["filePath"],
  additionalProperties: false,
}

/** Matches {@link OPENCODE_READ_SCHEMA}. Host read.md talks about `path` and inline selectors. */
const OPENCODE_READ_DESCRIPTION =
  "Read one file, directory, archive, image, document, or URL. " +
  "Pass filePath as exactly one location. Never join multiple locations with ; , or |. " +
  "For a line range set offset (1-indexed start) and limit (line count). " +
  "Do not encode the range inside filePath."

/**
 * Provider-facing OpenCode glob contract. omp's live tool only accepts a single
 * `path` that is itself the glob; the bridge folds `pattern` (+ optional search
 * root) into that field at call time. `gitignore` / `hidden` / `limit` are omp
 * extras kept on the advertised surface so models can still opt out of ignore.
 */
const OPENCODE_GLOB_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob pattern to match files (e.g. **/*.{ts,tsx})" },
    path: { type: "string", description: "Directory to search (relative or absolute)" },
    gitignore: { type: "boolean", description: "Respect gitignore (default true)" },
    hidden: { type: "boolean", description: "Include hidden files (default true)" },
    limit: { type: "number", description: "Maximum number of results" },
  },
  required: ["pattern"],
  additionalProperties: false,
}

/** Matches {@link OPENCODE_GLOB_SCHEMA}. Host glob.md treats `path` as the glob itself. */
const OPENCODE_GLOB_DESCRIPTION =
  "Find files by glob. Set pattern to the glob (for example **/*.{ts,tsx}). " +
  "Set path only as the directory to search, not as the glob. " +
  "gitignore defaults to true. hidden defaults to true. limit caps the result count."

/** Upstream OpenCode `todowrite` — full list replace; no host `op` fields. */
const OPENCODE_TODO_WRITE_DESCRIPTION =
  "Update the session task list. Every call replaces the whole list. Pass " +
  "todos as [{ content, status }] with status pending, in_progress, completed, " +
  "or cancelled. Do not send op/init/start/done fields."

const OPENCODE_TODO_READ_DESCRIPTION = "Read the current session task list. Takes no arguments."

/**
 * OpenCode/Cursor bash surface. Lead with `workdir` — host bash.md buries
 * "Set cwd instead of cd" and lists mkdir/`&&`, so models encode the directory
 * only in `command` and then think the tool ignored cwd.
 */
const OPENCODE_BASH_DESCRIPTION =
  "Run a shell command. To run outside the session root, set workdir to that " +
  "directory. Do not use cd. A path that appears only inside command " +
  "(including mkdir DIR && pwd) does not change the process working directory."

const OPENCODE_BASH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    workdir: {
      type: "string",
      description:
        "Process working directory for this command. Set this to leave the " +
        "session root. Paths inside command alone do not change process cwd.",
    },
    timeout: { type: "number", description: "Optional timeout" },
  },
  required: ["command"],
  additionalProperties: false,
}

const OPENCODE_TODO_WRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The complete task list after this update",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Brief description of the task" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "cancelled"],
            description: "Current status of the task",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Priority level of the task",
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
}

function providerToolSchema(
  tool: PiTool,
  toSchema: ToolSchemaFn,
  toolInputs: PiToolInputVocabulary | undefined,
): Record<string, unknown> {
  const shape = toolInputs?.[tool.name]?.inputShape
  if (shape === "opencode-edit") return OPENCODE_REPLACE_EDIT_SCHEMA
  if (shape === "pi-edit") return OPENCODE_EDIT_SCHEMA
  if (shape === "opencode-read") return OPENCODE_READ_SCHEMA
  if (shape === "opencode-todo") return OPENCODE_TODO_WRITE_SCHEMA
  if (shape === "opencode-glob") return OPENCODE_GLOB_SCHEMA
  if (shape === "opencode-bash") {
    // Keep host-only optional flags (pty/async) so those capabilities stay
    // callable; directory field is always the OpenCode `workdir` name.
    const host = toSchema(tool)
    const hostProps = (host.properties ?? {}) as Record<string, unknown>
    const properties: Record<string, unknown> = {
      ...(OPENCODE_BASH_SCHEMA.properties as Record<string, unknown>),
    }
    if (hostProps.pty !== undefined) properties.pty = hostProps.pty
    if (hostProps.async !== undefined) properties.async = hostProps.async
    if (hostProps.timeout !== undefined) properties.timeout = hostProps.timeout
    return {
      ...OPENCODE_BASH_SCHEMA,
      properties,
    }
  }
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
  question?: PiQuestionVocabulary,
  excludedToolNames?: ReadonlySet<string>,
  excludedToolCallIds?: Set<string>,
) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "file"; data: string; mediaType: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = []
  // Fanned-out todo ops share one canonical todowrite id; emit it once.
  // Other fan-outs (e.g. multi-path read) keep every host call as its own
  // history entry so paths/results are not collapsed into an empty snapshot.
  const foldedTodoFanouts = new Set<string>()
  const todoOpsByOriginal = new Map<string, Record<string, unknown>[]>()
  for (const block of message.content) {
    if (block.type !== "toolCall") continue
    const original = originalTodoFanoutId(block.id)
    if (!original || !isOpsTodoHostTool(block.name, toolInputs)) continue
    const operations = todoOpsByOriginal.get(original) ?? []
    operations.push(block.arguments)
    todoOpsByOriginal.set(original, operations)
  }
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
    else if (block.type === "thinking") content.push({ type: "reasoning", text: block.thinking })
    else if (block.type === "image") content.push({ type: "file", data: block.data, mediaType: block.mimeType })
    else if (block.type === "toolCall") {
      if (excludedToolNames?.has(block.name)) {
        excludedToolCallIds?.add(block.id)
        continue
      }
      const fanoutOriginal = originalTodoFanoutId(block.id)
      if (fanoutOriginal && isOpsTodoHostTool(block.name, toolInputs)) {
        if (foldedTodoFanouts.has(fanoutOriginal)) continue
        foldedTodoFanouts.add(fanoutOriginal)
        const snapshot = reconstructTodoSnapshotFromHostOps(
          todoOpsByOriginal.get(fanoutOriginal) ?? [],
        ) ?? { todos: [] }
        content.push({
          type: "tool-call",
          toolCallId: fanoutOriginal,
          toolName: canonicalToolName(block.name, vocabulary, toolInputs, { op: "init" }),
          input: snapshot,
        })
        continue
      }
      const translated =
        translateHostSubagentCall(block.name, block.arguments, vocabulary) ??
        translateHostQuestionCall(block.name, block.arguments, question)
      content.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName:
          translated?.toolName ??
          canonicalToolName(
            canonicalQuestionToolName(block.name, question),
            vocabulary,
            toolInputs,
            block.arguments,
          ),
        input: translated?.input ?? translateHostToolCallInput(block.name, block.arguments, toolInputs),
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
  question?: PiQuestionVocabulary,
  excludedToolNames?: ReadonlySet<string>,
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []
  const excludedToolCallIds = new Set<string>()

  const systemText = normalizeSystemPrompt(context.systemPrompt)
  if (systemText) prompt.push({ role: "system", content: systemText })

  // Fanned-out todo results collapse into the first message for their canonical id.
  // Multi-path read fan-outs are left as separate results (matched by call id).
  const foldedTodoResults = new Map<
    string,
    { toolName: string; texts: string[]; isError: boolean; promptIndex: number }
  >()

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
      const translated = assistantMessageToV3(
        message,
        vocabulary,
        toolInputs,
        question,
        excludedToolNames,
        excludedToolCallIds,
      )
      if (translated.content.length > 0) prompt.push(translated)
    } else if (message.role === "toolResult") {
      if (excludedToolNames?.has(message.toolName) || excludedToolCallIds.has(message.toolCallId)) continue
      const fanoutOriginal = originalTodoFanoutId(message.toolCallId)
      if (fanoutOriginal && isOpsTodoHostTool(message.toolName, toolInputs)) {
        const text = flattenToPlainText(message.content)
        const existing = foldedTodoResults.get(fanoutOriginal)
        if (existing) {
          if (text.length > 0) existing.texts.push(text)
          if (message.isError) existing.isError = true
          continue
        }
        const toolName = canonicalToolName(
          canonicalQuestionToolName(message.toolName, question),
          vocabulary,
          toolInputs,
          { op: "init" },
        )
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: fanoutOriginal,
              toolName,
              output: { type: "text", value: "" },
            },
          ],
        })
        foldedTodoResults.set(fanoutOriginal, {
          toolName,
          texts: text.length > 0 ? [text] : [],
          isError: message.isError === true,
          promptIndex: prompt.length - 1,
        })
        continue
      }
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: canonicalToolName(
              canonicalQuestionToolName(message.toolName, question),
              vocabulary,
              toolInputs,
            ),
            output: toolResultOutputFromPi(message),
          },
        ],
      })
    }
  }

  // Fill folded fan-out tool results with concatenated host text.
  for (const folded of foldedTodoResults.values()) {
    const entry = prompt[folded.promptIndex]
    if (!entry || entry.role !== "tool" || !Array.isArray(entry.content) || !entry.content[0]) continue
    const part = entry.content[0] as LanguageModelV3ToolResultPart
    const value = folded.texts.join("\n") || "Todo list updated."
    part.output = { type: folded.isError ? "error-text" : "text", value }
  }

  return prompt
}

/** Translate host tools into AI-SDK V3 function tools. */
const TODO_READ_SCHEMA: JSONSchema7 = { type: "object", properties: {}, additionalProperties: false }

export function translateTools(
  tools: PiTool[] | undefined,
  toSchema: ToolSchemaFn,
  vocabulary?: PiSubagentVocabulary,
  toolInputs?: PiToolInputVocabulary,
  question?: PiQuestionVocabulary,
  terminalResult?: PiTerminalResultVocabulary,
): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const translated: LanguageModelV3FunctionTool[] = []
  for (const tool of tools) {
    // Host-only settle shim (omp `yield`). The stream injects it on stop;
    // advertising it makes catalogs look like subagent surfaces and confuses
    // models hunting for ask/todo tools.
    if (terminalResult && tool.name === terminalResult.hostToolName) continue
    if (vocabulary && tool.name === vocabulary.hostToolName) {
      translated.push({
        type: "function",
        name: "task",
        description: canonicalSubagentDescription(vocabulary),
        inputSchema: canonicalSubagentSchema(vocabulary) as JSONSchema7,
      })
      continue
    }
    if (question && tool.name === question.hostToolName) {
      translated.push({
        type: "function",
        name: CANONICAL_QUESTION_TOOL,
        description: canonicalQuestionDescription(question),
        inputSchema: canonicalQuestionSchema() as JSONSchema7,
      })
      continue
    }
    const shape = toolInputs?.[tool.name]?.inputShape
    // When we rewrite the schema to OpenCode, rewrite the description too —
    // leaving host prose (ops-based todo, buried cwd bullets) beside a different
    // schema confuses models into the wrong call shape.
    const description =
      shape === "opencode-todo"
        ? OPENCODE_TODO_WRITE_DESCRIPTION
        : shape === "opencode-bash"
          ? OPENCODE_BASH_DESCRIPTION
          : shape === "opencode-read"
            ? OPENCODE_READ_DESCRIPTION
            : shape === "opencode-glob"
              ? OPENCODE_GLOB_DESCRIPTION
              : tool.description
    translated.push({
      type: "function",
      name: canonicalToolName(tool.name, vocabulary, toolInputs),
      description,
      inputSchema: providerToolSchema(tool, toSchema, toolInputs) as unknown as JSONSchema7,
    })
    for (const extra of toolInputs?.[tool.name]?.extraProviderNames ?? []) {
      translated.push({
        type: "function",
        name: extra,
        description: extra === "todoread" ? OPENCODE_TODO_READ_DESCRIPTION : description,
        inputSchema: extra === "todoread" ? TODO_READ_SCHEMA : providerToolSchema(tool, toSchema, toolInputs) as unknown as JSONSchema7,
      })
    }
  }
  return translated.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** Translate the host's `toolChoice` into AI-SDK V3's shape. */
export function translateToolChoice(
  choice: PiToolChoice | undefined,
  vocabulary?: PiSubagentVocabulary,
  toolInputs?: PiToolInputVocabulary,
  question?: PiQuestionVocabulary,
): LanguageModelV3ToolChoice | undefined {
  if (choice === undefined || choice === "auto") return undefined
  if (choice === "none") return { type: "none" }
  if (choice === "any" || choice === "required") return { type: "required" }
  if (typeof choice === "object" && "name" in choice) {
    return {
      type: "tool",
      toolName: canonicalToolName(
        canonicalQuestionToolName(choice.name, question),
        vocabulary,
        toolInputs,
      ),
    }
  }
  return undefined
}
