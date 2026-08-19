import { withEditLock } from "./edit-lock.js"
import type { PiExtensionApi, PiRegisterToolDefinition } from "./pi-provider-types.js"

export const OPENCODE_EDIT_TOOL = "edit"

const OPENCODE_EDIT_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    oldString: { type: "string", description: "Exact text to replace. Must match exactly once in the file." },
    newString: { type: "string", description: "Replacement text" },
    replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
    path: { type: "string", description: "Alias of filePath" },
    old_string: { type: "string", description: "Alias of oldString" },
    new_string: { type: "string", description: "Alias of newString" },
    replace_all: { type: "boolean", description: "Alias of replaceAll" },
    i: { type: "string", description: "Optional caller intent; ignored by the executor" },
  },
  additionalProperties: false,
} as const

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>
}

type InvokeTool = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: unknown },
) => Promise<unknown>

export type SettingsLike = {
  override?(path: string, value: unknown): void
  clearOverride?(path: string): void
  get?(path: string): unknown
}

export type RegisterOpenCodeEditToolOptions = {
  hostPi?: { settings?: SettingsLike }
  executeReplace?: (args: Record<string, unknown>, ctx: Record<string, unknown> | undefined) => Promise<unknown>
}

function textResult(text: string): TextToolResult {
  return { content: [{ type: "text", text }] }
}

function firstString(input: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string") return value
  }
  return undefined
}

export function toReplaceArgs(params: unknown): Record<string, unknown> {
  const input = params && typeof params === "object" ? params as Record<string, unknown> : {}
  const path = firstString(input, ["path", "filePath", "file_path"])
  const oldString = firstString(input, ["old_string", "oldString", "oldText"])
  const newString = firstString(input, ["new_string", "newString", "newText"])
  if (!path || oldString === undefined || newString === undefined) {
    throw new Error("edit requires filePath, oldString, and newString")
  }
  const args: Record<string, unknown> = { path, old_string: oldString, new_string: newString }
  if (input.replaceAll === true || input.replace_all === true) args.replace_all = true
  return args
}

export function registerOpenCodeEditTool(
  pi: PiExtensionApi,
  options: RegisterOpenCodeEditToolOptions = {},
): string[] {
  if (!pi.registerTool) return []

  const edit: PiRegisterToolDefinition = {
    name: OPENCODE_EDIT_TOOL,
    label: "Edit file",
    description:
      "Replace exact text in a file. oldString must match once unless replaceAll is true. " +
      "This is OpenCode / Cursor StrReplace, not a hashline patch.",
    parameters: OPENCODE_EDIT_SCHEMA,
    loadMode: "essential",
    approval: "write",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params && typeof params === "object"
        ? (params as { input?: unknown }).input
        : undefined
      const invoke = (ctx as { invokeTool?: InvokeTool } | undefined)?.invokeTool
      if (typeof invoke !== "function") {
        throw new Error("edit is unavailable: omp did not expose native invokeTool for the built-in editor")
      }
      // The separate hashline tool calls this registered same-name wrapper so
      // omp supplies its native same-tool delegate. Do not switch modes here.
      if (typeof input === "string") return invoke({ input }, { signal, onUpdate })

      const replaceArgs = toReplaceArgs(params)
      return withEditLock(undefined, async () => {
        if (options.executeReplace) return options.executeReplace(replaceArgs, ctx)
        const settings = options.hostPi?.settings ?? pi.pi?.settings
        const previousMode = settings?.get?.("edit.mode")
        settings?.override?.("edit.mode", "replace")
        try {
          const result = await invoke(replaceArgs, { signal, onUpdate })
          if (typeof result === "string") return textResult(result)
          return result
        } finally {
          if (previousMode !== undefined) settings?.override?.("edit.mode", previousMode)
          else settings?.clearOverride?.("edit.mode")
        }
      })
    },
  }
  pi.registerTool(edit)
  return [OPENCODE_EDIT_TOOL]
}

async function applyOpenCodeEditTools(pi: PiExtensionApi, toolNames: readonly string[]): Promise<void> {
  if (toolNames.length === 0) return
  if (!pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return
  const available = new Set(
    pi.getAllTools().map(tool => (typeof tool === "string" ? tool : tool.name)),
  )
  const wanted = toolNames.filter(name => available.has(name))
  if (wanted.length === 0) return
  const active = pi.getActiveTools()
  const next = [...new Set([...active, ...wanted])]
  if (next.length === active.length && next.every((name, index) => name === active[index])) return
  await pi.setActiveTools(next)
}

export function openCodeEditToolActivator(
  pi: PiExtensionApi,
  toolNames: readonly string[] = [OPENCODE_EDIT_TOOL],
): () => Promise<void> {
  return () => applyOpenCodeEditTools(pi, toolNames)
}

export function activateOpenCodeEditTool(pi: PiExtensionApi, toolNames: readonly string[] = [OPENCODE_EDIT_TOOL]): void {
  pi.on?.("session_start", openCodeEditToolActivator(pi, toolNames))
}
