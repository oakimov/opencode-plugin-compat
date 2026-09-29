/** Cursor's binary image commit, exposed through DSH's native tool registry. */
import { statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type ImageSave = (args: { image_id?: unknown }, ctx: {
  worktree: string
  directory: string
  ask: (input: { permission: string; metadata: Record<string, unknown> }) => Promise<void>
}) => Promise<{ output: string }>

export type CursorImageToolContext = {
  tools: { get: (name: string) => unknown; register: (definition: Record<string, unknown>) => unknown }
  sandboxPolicy: { resolve: (input: { session: unknown }) => { mode: string; workspaceRoot: string } }
  approval: { request: (input: {
    agent: unknown; toolName: string; callId: unknown; reason: string; signal: AbortSignal
  }) => Promise<string> }
}

/** The provider subpath must come from the same installed package as its root. */
export async function loadCursorImageSave(packageSpecifier: string): Promise<ImageSave | undefined> {
  try {
    const local = packageSpecifier.startsWith("file:")
      ? fileURLToPath(packageSpecifier)
      : path.isAbsolute(packageSpecifier) ? packageSpecifier : undefined
    const isDirectory = local ? statSync(local).isDirectory() : false
    const specifier = local
      ? pathToFileURL(path.join(isDirectory ? local : path.dirname(local), isDirectory ? "dist/image-save.js" : "image-save.js")).href
      : `${packageSpecifier}/image-save`
    const module = await import(specifier) as { executeCursorImageSave?: ImageSave }
    return typeof module.executeCursorImageSave === "function" ? module.executeCursorImageSave : undefined
  } catch {
    return undefined
  }
}

export function registerCursorImageTool(ctx: CursorImageToolContext, save: ImageSave): void {
  if (ctx.tools.get("cursor_image_save")) return
  ctx.tools.register({
    name: "cursor_image_save",
    description: "Save a Cursor-generated image from its single-use opaque image ID. The provider calls this after generation; it cannot write arbitrary content.",
    parameters: {
      type: "object",
      properties: { image_id: { type: "string" } },
      required: ["image_id"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      render: (_args: unknown, value: { message: string }) => [{ type: "text", text: value.message }],
    },
    async execute(args: { image_id?: unknown }, exec: {
      agent?: { session: { header: { cwd?: string } } }
      callId: unknown
      signal: AbortSignal
    }) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error("Image save requires a calling agent")
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
      const workspace = exec.agent.session.header.cwd ?? policy.workspaceRoot
      let approved = false
      const result = await save(args, {
        worktree: workspace,
        directory: workspace,
        ask: async ({ permission, metadata }) => {
          exec.signal.throwIfAborted()
          const needsApproval = policy.mode === "read-only"
            || (policy.mode !== "danger-full-access" && permission === "external_directory")
          if (!needsApproval || approved) return
          const target = typeof metadata.filepath === "string" ? metadata.filepath : "the generated image"
          const outcome = await ctx.approval.request({
            agent: exec.agent,
            toolName: "cursor_image_save",
            callId: exec.callId,
            reason: `Save the generated image to ${target} outside the current ${policy.mode} sandbox`,
            signal: exec.signal,
          })
          if (outcome !== "allowed-once") throw new Error(`Image save approval ${outcome}`)
          approved = true
        },
      })
      exec.signal.throwIfAborted()
      return { message: result.output }
    },
  })
}
