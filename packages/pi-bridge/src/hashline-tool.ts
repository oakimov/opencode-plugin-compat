import { coalesceSameTagHashline } from "./hashline-coalesce.js"
import { withEditLock } from "./edit-lock.js"
import {
  claimHashlinePatch,
  hasHashlineTagMinted,
  parseHashlinePatch,
  recordHashlineTagMinted,
  releaseHashlinePatch,
  restateEvictedSessionHashlineError,
  restateEvictedSessionHashlineFailure,
  tagRejectedAsNotFromSession,
  type HashlinePatchMeta,
} from "./hashline-overlap.js"
import { bindOmpPlanModeHost } from "./plan-mode-host.js"
import type { PiExtensionApi, PiRegisterToolDefinition } from "./pi-provider-types.js"

export const HASHLINE_TOOL = "hashline"

const HASHLINE_SCHEMA = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description:
        "Hashline patch. Sections start with [path] or [path#tag]. Numbered lines are context; + inserts, - deletes.",
    },
  },
  required: ["input"],
  additionalProperties: false,
} as const

const TAG_HEADER = /\[([^\]#]+)#([0-9A-Fa-f]{4})\]/g

function textFromResult(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object") {
    const record = result as { content?: unknown; text?: unknown }
    if (typeof record.text === "string") return record.text
    if (Array.isArray(record.content)) {
      return record.content
        .map(block => (typeof block === "string" ? block : (block as { text?: unknown }).text ?? ""))
        .join("")
    }
  }
  return ""
}

/**
 * Record every `[path#TAG]` header a successful hashline apply returned, so a
 * later "hash is not from this session" rejection of one of those tags can be
 * recognized as an in-session snapshot eviction instead of a fabrication.
 */
function recordMintedTagsFromResult(result: unknown): void {
  for (const match of textFromResult(result).matchAll(TAG_HEADER)) {
    const path = match[1]
    const tag = match[2]
    if (!path || !tag) continue
    recordHashlineTagMinted(path.trim(), tag)
  }
}

/** Restate a non-throwing isError result whose text is a known in-session eviction. */
function restateEvictedSessionHashlineResult(
  meta: { path?: string; tag?: string },
  result: unknown,
): unknown {
  if (!result || typeof result !== "object") return result
  const record = result as { isError?: boolean }
  if (record.isError !== true) return result
  const text = textFromResult(result)
  const rejected = tagRejectedAsNotFromSession(text)
  const tag = rejected ?? meta.tag
  if (!rejected || !tag || !hasHashlineTagMinted(meta.path, tag)) return result
  return {
    ...record,
    content: [{ type: "text", text: restateEvictedSessionHashlineFailure(meta.path, tag, text) }],
  }
}

export type HostEditTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>
}

export type RegisterHashlineToolOptions = {
  resolveEdit?: () => Promise<HostEditTool | undefined>
  hostPi?: PiExtensionApi["pi"]
}

async function defaultResolveEdit(hostPi?: PiExtensionApi["pi"]): Promise<HostEditTool | undefined> {
  const host = await bindOmpPlanModeHost({ hostPi })
  const tool = host?.getSession()?.getToolByName?.("edit")
  if (!tool || typeof tool.execute !== "function") return undefined
  return tool as HostEditTool
}

export function registerHashlineTool(pi: PiExtensionApi, options: RegisterHashlineToolOptions = {}): string[] {
  if (!pi.registerTool) return []
  const z = pi.zod
  const parameters = z
    ? z.object({
        input: z.string().describe(
          "Hashline patch. Sections start with [path] or [path#tag]. Numbered lines are context; + inserts, - deletes.",
        ),
      })
    : HASHLINE_SCHEMA
  const resolveEdit = options.resolveEdit ?? (() => defaultResolveEdit(options.hostPi ?? pi.pi))
  const hashline: PiRegisterToolDefinition = {
    name: HASHLINE_TOOL,
    label: "Hashline edit",
    description:
      "Apply an omp hashline patch. Use this instead of OpenCode edit when the change is a hashline document, not oldString/newString.",
    parameters,
    loadMode: "essential",
    approval: "write",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = typeof (params as { input?: unknown })?.input === "string"
        ? (params as { input: string }).input
        : ""
      if (!input.trim()) throw new Error("hashline requires a non-empty input patch")
      const meta = parseHashlinePatch(input)
      return coalesceSameTagHashline({ input, meta, signal }, async (mergedInput, members) => {
        return withEditLock(undefined, async () => {
          const claimed: HashlinePatchMeta[] = []
          try {
            for (const member of members) {
              claimHashlinePatch(member.meta)
              claimed.push(member.meta)
            }
            const edit = await resolveEdit()
            if (!edit) throw new Error("hashline is unavailable: omp edit tool is not registered on the live session")
            const result = await edit.execute(toolCallId, { input: mergedInput }, signal, onUpdate, ctx)
            if (result && typeof result === "object" && (result as { isError?: boolean }).isError === true) {
              for (const memberMeta of claimed) releaseHashlinePatch(memberMeta)
              return restateEvictedSessionHashlineResult(meta, result)
            }
            recordMintedTagsFromResult(result)
            return result
          } catch (error) {
            for (const memberMeta of claimed) releaseHashlinePatch(memberMeta)
            throw restateEvictedSessionHashlineError(meta, error)
          }
        })
      })
    },
  }
  pi.registerTool(hashline)
  return [HASHLINE_TOOL]
}

export function activateHashlineTool(pi: PiExtensionApi, toolNames: readonly string[] = [HASHLINE_TOOL]): void {
  if (toolNames.length === 0) return
  if (!pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return
  const apply = async () => {
    const available = new Set(
      pi.getAllTools!().map(tool => (typeof tool === "string" ? tool : tool.name)),
    )
    const wanted = toolNames.filter(name => available.has(name))
    if (wanted.length === 0) return
    const active = pi.getActiveTools!()
    const next = [...new Set([...active, ...wanted])]
    if (next.length === active.length && next.every((name, index) => name === active[index])) return
    await pi.setActiveTools!(next)
  }
  pi.on?.("session_start", apply)
}
