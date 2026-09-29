import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
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

type InvokeTool = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: unknown },
) => Promise<unknown>

export type RegisterOpenCodeEditToolOptions = {
  resolveWrite?: (ctx: Record<string, unknown> | undefined) => Promise<{
    execute: (toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<unknown>
  } | undefined>
}

const MAX_EDIT_SOURCE_BYTES = 50 * 1024 * 1024

async function replaceThroughWrite(
  args: Record<string, unknown>,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  cwd: string | undefined,
  ctx: Record<string, unknown> | undefined,
  resolveWrite: NonNullable<RegisterOpenCodeEditToolOptions["resolveWrite"]> | undefined,
): Promise<unknown> {
  signal?.throwIfAborted()
  const requestedPath = args.path as string
  if (!isAbsolute(requestedPath) && !cwd) {
    throw new Error("edit is unavailable: omp did not expose the active workspace directory")
  }
  const target = resolve(cwd ?? "/", requestedPath)
  const before = await stat(target, { bigint: true })
  if (!before.isFile() || before.size > BigInt(MAX_EDIT_SOURCE_BYTES)) {
    throw new Error(`edit requires a regular file no larger than 50 MB: ${target}`)
  }
  const bytes = await readFile(target)
  if (bytes.byteLength > MAX_EDIT_SOURCE_BYTES) {
    throw new Error(`edit source grew beyond 50 MB while reading: ${target}`)
  }
  if (bytes.includes(0)) throw new Error(`edit refuses binary file: ${target}`)
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  const oldString = args.old_string as string
  const newString = args.new_string as string
  if (!oldString) throw new Error("edit requires a non-empty oldString")
  const first = source.indexOf(oldString)
  if (first < 0) throw new Error(`oldString not found in ${target}`)
  const second = source.indexOf(oldString, first + oldString.length)
  if (second >= 0 && args.replace_all !== true) {
    throw new Error(`oldString matches more than once in ${target}; use replaceAll or a more specific oldString`)
  }
  const content = args.replace_all === true
    ? source.split(oldString).join(newString)
    : source.slice(0, first) + newString + source.slice(first + oldString.length)
  const write = await resolveWrite?.(ctx)
  if (!write) throw new Error("edit is unavailable: omp did not expose an active write tool")
  const now = await stat(target, { bigint: true })
  if (before.dev !== now.dev || before.ino !== now.ino || before.size !== now.size || before.mtimeNs !== now.mtimeNs) {
    throw new Error(`edit target changed while preparing replacement: ${target}`)
  }
  signal?.throwIfAborted()
  return write.execute(toolCallId, { path: target, content }, signal, onUpdate)
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
      // The separate hashline tool calls this registered same-name wrapper so
      // omp supplies its native same-tool delegate.
      if (typeof input === "string") {
        if (typeof invoke !== "function") {
          throw new Error("hashline edit is unavailable: omp did not expose native invokeTool")
        }
        return invoke({ input }, { signal, onUpdate })
      }

      const replaceArgs = toReplaceArgs(params)
      return withEditLock(undefined, async () => replaceThroughWrite(
        replaceArgs, _toolCallId, signal, onUpdate,
        typeof ctx?.cwd === "string" ? ctx.cwd : undefined,
        ctx,
        options.resolveWrite,
      ))
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
