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

type HostEditTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    onUpdate: unknown,
    ctx: unknown,
    signal?: AbortSignal,
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
      const edit = await resolveEdit()
      if (!edit) throw new Error("hashline is unavailable: omp edit tool is not registered on the live session")
      return edit.execute(toolCallId, { input }, onUpdate, ctx, signal)
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
