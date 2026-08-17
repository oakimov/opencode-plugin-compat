/**
 * Advertise Cursor-provider bridge tools on Pi-family hosts:
 *   - omp: `plan_enter` / `plan_exit` (native plan mode via AgentRegistry)
 *   - omp + pi: `cursor_image_save` (commit staged Cursor image bytes)
 *
 * The Cursor provider gates SwitchMode / GenerateImage on these exact names
 * being present in the live LanguageModel tool catalog.
 */
import {
  bindOmpPlanModeHost,
  createPlanModeBinderState,
  enterOmpPlanMode,
  exitOmpPlanMode,
  type OmpPlanModeHost,
  type PlanModeBinderState,
} from "./plan-mode-host.js"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PiHostId } from "./host/profile.js"
import type { PiExtensionApi, PiRegisterToolDefinition } from "./pi-provider-types.js"

export const PLAN_ENTER_TOOL = "plan_enter"
export const PLAN_EXIT_TOOL = "plan_exit"
export const CURSOR_IMAGE_SAVE_TOOL = "cursor_image_save"
export const CURSOR_PLAN_STAGE_TOOL = "cursor_plan_stage"

export const USER_REJECTED_REASON = "Mode switch rejected by user"

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const PLAN_STAGE_SCHEMA = {
  type: "object",
  properties: {
    plan_uri: { type: "string", description: "Session-local omp plan URI" },
    content: { type: "string", description: "Complete plan markdown" },
    title: { type: "string", description: "Plan slug/title" },
  },
  required: ["plan_uri", "content", "title"],
  additionalProperties: false,
} as const

const IMAGE_ID_SCHEMA = {
  type: "object",
  properties: {
    image_id: {
      type: "string",
      description: "Id of the pending Cursor-generated image to save",
    },
  },
  required: ["image_id"],
  additionalProperties: false,
} as const

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>
  details?: Record<string, unknown>
}

type OmpExtensionContext = {
  hasUI?: boolean
  ui?: {
    select?: (
      title: string,
      options: Array<string | { value: string; label?: string; description?: string }>,
    ) => Promise<string | undefined>
  }
}

type ImageSaveAsk = (input: {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}) => Promise<void>

type ImageSaveContext = {
  worktree: string
  directory: string
  ask: ImageSaveAsk
}

type ImageSaveExecute = (
  args: { image_id?: unknown },
  ctx: ImageSaveContext,
) => Promise<string | { title: string; output: string }>

function textResult(text: string, details?: Record<string, unknown>): TextToolResult {
  return { content: [{ type: "text", text }], details }
}

function isPlanEnabled(pi: PiExtensionApi): boolean {
  // Prefer an explicit host setting when ExtensionAPI exposes one; default true
  // matches omp's `plan.enabled` schema default.
  const getter = pi.getSetting
  if (typeof getter !== "function") return true
  try {
    return getter.call(pi, "plan.enabled") !== false
  } catch {
    return true
  }
}

async function resolvePlanHost(
  resolveHost: () => Promise<OmpPlanModeHost | undefined>,
): Promise<OmpPlanModeHost> {
  const host = await resolveHost()
  if (!host) {
    throw new Error(
      "omp plan mode is unavailable: no live AgentSession is registered yet. " +
        "Retry after the session has started.",
    )
  }
  return host
}

/**
 * The user reviewed the plan and asked for changes. Not a failure of the tool
 * and not a mode-switch rejection: the plan exists, it just was not approved
 * for execution, so its own message must reach the model verbatim.
 */
export class PlanNotApprovedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanNotApprovedError"
  }
}

export function mapPlanModeError(error: unknown): never {
  if (error instanceof PlanNotApprovedError) throw error
  const message = error instanceof Error ? error.message : String(error)
  // Host approval denials should surface as Cursor's user-reject reason so the
  // provider's SwitchMode bridge maps them to rejected{}, not a generic failure.
  if (/denied|reject|blocked|not allowed|cancelled|canceled/i.test(message)) {
    throw new Error(USER_REJECTED_REASON)
  }
  throw error instanceof Error ? error : new Error(message)
}

export type RegisterCursorHostToolsOptions = {
  hostId: PiHostId
  /** omp's ExtensionAPI.pi namespace, passed through to the plan binder. */
  hostPi?: { AgentRegistry?: { global(): unknown }; MAIN_AGENT_ID?: string }
  /** Override AgentRegistry binding (tests). */
  resolvePlanHost?: () => Promise<OmpPlanModeHost | undefined>
  /** Override image-save execute (tests / when provider package is absent). */
  executeImageSave?: ImageSaveExecute
}

async function loadExecuteCursorImageSave(): Promise<ImageSaveExecute | undefined> {
  try {
    // Runtime specifier so tsc does not require the optional peer at compile time.
    const spec: string = "cursor-opencode-provider/image-save"
    const mod = (await import(spec)) as {
      executeCursorImageSave?: ImageSaveExecute
    }
    if (typeof mod.executeCursorImageSave === "function") return mod.executeCursorImageSave
  } catch {
    // Dedicated subpath missing — fall through.
  }
  return undefined
}

function cwdFromContext(ctx: Record<string, unknown> | undefined): string {
  if (typeof ctx?.cwd === "string" && ctx.cwd) return ctx.cwd
  const session = ctx?.session as { cwd?: string } | undefined
  if (typeof session?.cwd === "string" && session.cwd) return session.cwd
  return process.cwd()
}

function safeSessionId(value: string | null | undefined): string {
  const normalized = (value || "session").replace(/[^a-zA-Z0-9_.-]/g, "_")
  return normalized || "session"
}

function localPlanPath(host: OmpPlanModeHost, planUri: string): string {
  if (!planUri.startsWith("local://")) {
    throw new Error("omp native plan URI must use local://")
  }
  const relative = decodeURIComponent(planUri.slice("local://".length))
  if (!relative || path.isAbsolute(relative) || relative.includes("..") || relative.includes("\\")) {
    throw new Error("omp native plan URI must name one session-local plan file")
  }
  const manager = host.getSession()?.sessionManager
  const artifactsDir = manager?.getArtifactsDir?.()
  const root = artifactsDir
    ? path.join(artifactsDir, "local")
    : path.join(tmpdir(), "omp-local", safeSessionId(manager?.getSessionId?.()))
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("omp native plan URI escapes the session-local root")
  }
  return resolved
}

async function stageNativeOmpPlan(
  host: OmpPlanModeHost,
  params: Record<string, unknown>,
): Promise<TextToolResult> {
  const planUri = typeof params.plan_uri === "string" ? params.plan_uri.trim() : ""
  const content = typeof params.content === "string" ? params.content : ""
  const title = typeof params.title === "string" ? params.title.trim() : ""
  if (!planUri || !content.trim() || !title) {
    throw new Error("cursor_plan_stage requires plan_uri, content, and title")
  }
  const state = host.getPlanModeState()
  if (!state?.enabled) throw new Error("omp plan mode is not active")

  // This bridge tool stages only the session-local artifact. The provider emits
  // a second ordinary `write xd://propose` in the same tool batch, so omp's own
  // resolution-device dispatcher and plan approval UI remain authoritative.
  const target = localPlanPath(host, planUri)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, "utf8")
  host.setPlanModeState({ ...state, planFilePath: planUri })
  return textResult(JSON.stringify({ plan_uri: planUri }), {
    action: CURSOR_PLAN_STAGE_TOOL,
    planFilePath: planUri,
    title,
    planExists: true,
  })
}

async function reviewNativeOmpPlan(
  host: OmpPlanModeHost,
  title: string,
  content: string,
  context: OmpExtensionContext | undefined,
  state: PlanModeBinderState,
): Promise<TextToolResult> {
  const prepared = await host.preparePlanForReview(title) as {
    details?: { planFilePath?: unknown; title?: unknown; planExists?: unknown }
  }
  const details = prepared.details
  const planFilePath = typeof details?.planFilePath === "string" ? details.planFilePath : ""
  const resolvedTitle = typeof details?.title === "string" ? details.title : title
  if (!planFilePath || details?.planExists !== true) {
    throw new Error("omp native plan proposal did not resolve a reviewable plan")
  }
  if (context?.hasUI !== true || typeof context.ui?.select !== "function") {
    throw new Error("omp native plan review requires an interactive TUI session")
  }

  const choice = await context.ui.select(
    `Review plan: ${resolvedTitle}\n\n${content}`,
    ["Approve and execute", "Refine plan"],
  )
  if (choice !== "Approve and execute") {
    // The provider's CreatePlan contract is success = the user approved
    // execution, error = the plan was written but not accepted. Returning a
    // success result here made Cursor treat a refinement request as approval
    // and start implementing the plan the user had just declined.
    // Distinguish a dismissed/cancelled prompt from an explicit "Refine plan"
    // choice so the model is not told the user asked for changes when they
    // simply closed the dialog.
    const message = choice === "Refine plan"
      ? `Plan refinement requested. Update ${planFilePath}, then propose it again when ready.`
      : `Plan review was cancelled. The plan at ${planFilePath} was not approved for execution.`
    throw new PlanNotApprovedError(message)
  }

  const session = host.getSession()
  session?.setPlanReferencePath?.(planFilePath)
  await exitOmpPlanMode(host, state)
  await session?.followUp?.(
    `The user approved the plan at ${planFilePath}. Execute the approved plan now.`,
  )
  return textResult(`Plan approved at ${planFilePath}. Plan mode exited; execution queued.`, {
    action: "plan_approved",
    planFilePath,
    title: resolvedTitle,
    planExists: true,
  })
}

/**
 * Register plan_enter / plan_exit (omp only) and cursor_image_save (omp+pi).
 * Returns the tool names that were registered.
 */
export function registerCursorHostTools(
  pi: PiExtensionApi,
  options: RegisterCursorHostToolsOptions,
): string[] {
  if (!pi.registerTool) return []

  const registered: string[] = []
  const binderState: PlanModeBinderState = createPlanModeBinderState()
  const resolveHost = options.resolvePlanHost ?? (() => bindOmpPlanModeHost({ hostPi: options.hostPi }))

  const z = pi.zod
  const emptyParams = z ? z.object({}) : EMPTY_OBJECT_SCHEMA
  const imageParams = z
    ? z.object({
        image_id: z.string().describe("Id of the pending Cursor-generated image to save"),
      })
    : IMAGE_ID_SCHEMA
  const planStageParams = z
    ? z.object({
        plan_uri: z.string().describe("Session-local omp plan URI"),
        content: z.string().describe("Complete plan markdown"),
        title: z.string().describe("Plan slug/title"),
      })
    : PLAN_STAGE_SCHEMA

  if (options.hostId === "omp" && isPlanEnabled(pi)) {
    const planEnter: PiRegisterToolDefinition = {
      name: PLAN_ENTER_TOOL,
      label: "Enter plan mode",
      description:
        "Enter omp plan mode (read-only exploration and plan drafting). " +
        "OpenCode / Cursor SwitchMode maps plan/spec targets here.",
      parameters: emptyParams,
      loadMode: "essential",
      approval: "read",
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        try {
          const host = await resolvePlanHost(resolveHost)
          return await enterOmpPlanMode(host, binderState)
        } catch (error) {
          mapPlanModeError(error)
        }
      },
    }
    const planExit: PiRegisterToolDefinition = {
      name: PLAN_EXIT_TOOL,
      label: "Exit plan mode",
      description:
        "Leave omp plan mode and restore normal build tools. " +
        "OpenCode / Cursor SwitchMode maps non-plan targets here.",
      parameters: emptyParams,
      loadMode: "essential",
      approval: "read",
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        try {
          const host = await resolvePlanHost(resolveHost)
          return await exitOmpPlanMode(host, binderState)
        } catch (error) {
          mapPlanModeError(error)
        }
      },
    }
    const planStage: PiRegisterToolDefinition = {
      name: CURSOR_PLAN_STAGE_TOOL,
      label: "Stage Cursor plan",
      description:
        "Stage Cursor CreatePlan markdown in omp's session-local plan artifact. " +
        "The Cursor provider issues this immediately before native plan proposal.",
      parameters: planStageParams,
      loadMode: "essential",
      approval: "read",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const host = await resolvePlanHost(resolveHost)
          const input = params as Record<string, unknown>
          await stageNativeOmpPlan(host, input)
          return await reviewNativeOmpPlan(
            host,
            typeof input.title === "string" ? input.title : "",
            typeof input.content === "string" ? input.content : "",
            ctx as OmpExtensionContext | undefined,
            binderState,
          )
        } catch (error) {
          mapPlanModeError(error)
        }
      },
    }
    pi.registerTool(planEnter)
    pi.registerTool(planExit)
    pi.registerTool(planStage)
    registered.push(PLAN_ENTER_TOOL, PLAN_EXIT_TOOL, CURSOR_PLAN_STAGE_TOOL)
  }

  const imageSave: PiRegisterToolDefinition = {
    name: CURSOR_IMAGE_SAVE_TOOL,
    label: "Save Cursor image",
    description:
      "Save an image that Cursor generated during this session to its target path. " +
      "Takes only the id of an already-generated image — it cannot write arbitrary " +
      "files, and it is not a general-purpose file writer. You do not normally call " +
      "this: the Cursor provider issues it after an image is generated.",
    parameters: imageParams,
    loadMode: "essential",
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const execute = options.executeImageSave ?? (await loadExecuteCursorImageSave())
      if (!execute) {
        return textResult(
          "cursor_image_save is registered but cursor-opencode-provider/image-save " +
            "could not be imported in this process. Install the Cursor provider alongside pi-bridge.",
        )
      }

      const cwd = cwdFromContext(ctx)
      const result = await execute(
        { image_id: (params as { image_id?: unknown }).image_id },
        {
          worktree: cwd,
          directory: cwd,
          // Pi-family hosts gate writes through their own tool approval; the
          // provider's OpenCode-shaped `ask` is a no-op here so we don't invent
          // a second permission dialog. Containment still runs inside execute.
          ask: async () => {},
        },
      )

      if (typeof result === "string") return textResult(result)
      return textResult(result.output, { title: result.title })
    },
  }
  pi.registerTool(imageSave)
  registered.push(CURSOR_IMAGE_SAVE_TOOL)

  return registered
}

/**
 * Ensure registered Cursor host tools are in the active set once the session
 * runtime exists (same pattern as `activateOpenCodeSearchTools`).
 */
export function activateCursorHostTools(pi: PiExtensionApi, toolNames: readonly string[]): void {
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
