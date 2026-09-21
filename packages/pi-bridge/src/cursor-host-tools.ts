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
  findHostCodingAgentPackageRoot,
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
  /**
   * Override the host plan-review prompt (tests). Production waits on omp's
   * plan-review overlay and does not return until the user chooses.
   */
  reviewPlan?: (input: { content: string; title: string; planUri: string }) => Promise<string | undefined>
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

const PLAN_REVIEW_APPROVE = "Approve and execute"
const PLAN_REVIEW_REFINE = "Refine plan"
const PLAN_REVIEW_TITLE = "Plan mode - next step"

type PlanReviewOverlayCtor = new (
  planContent: string,
  options: { promptTitle?: string; options: string[]; helpText?: string },
  callbacks: { onPick: (label: string) => void; onCancel: () => void },
) => unknown

type HostReviewUi = {
  custom?: (
    factory: (
      tui: { setFocus?: (component: unknown) => void },
      theme: unknown,
      keybindings: unknown,
      done: (result: string | undefined) => void,
    ) => unknown,
    options?: {
      overlay?: boolean
      overlayOptions?: {
        anchor?: string
        width?: string
        maxHeight?: string
        margin?: number
        fullscreen?: boolean
      }
    },
  ) => Promise<string | undefined>
}

async function loadPlanReviewOverlay(): Promise<PlanReviewOverlayCtor | undefined> {
  const { existsSync, readFileSync, realpathSync } = await import("node:fs")
  const { pathToFileURL } = await import("node:url")
  const entry = process.argv[1]
  if (!entry) return undefined
  const root = findHostCodingAgentPackageRoot(
    entry,
    "@oh-my-pi/pi-coding-agent",
    { existsSync, readFileSync, realpathSync },
    path,
  )
  if (!root) return undefined
  const overlayPath = path.join(path.dirname(root), "pi-tui", "src", "overlays", "plan-review-overlay.ts")
  if (!existsSync(overlayPath)) return undefined
  try {
    const mod = (await import(pathToFileURL(overlayPath).href)) as { PlanReviewOverlay?: PlanReviewOverlayCtor }
    return mod.PlanReviewOverlay
  } catch {
    return undefined
  }
}

/**
 * Block on omp's plan-review overlay. Returning before this choice is what let
 * the model call `plan_exit` ("Plan mode disabled.") and skip approval.
 */
async function presentHostPlanReview(
  ctx: unknown,
  content: string,
  title: string,
): Promise<string | undefined> {
  const ui = (ctx as { ui?: HostReviewUi } | undefined)?.ui
  if (typeof ui?.custom !== "function") {
    throw new Error("omp native plan review requires an interactive TUI session")
  }
  const Overlay = await loadPlanReviewOverlay()
  if (!Overlay) {
    throw new Error("omp plan review overlay is not available in this host")
  }
  return ui.custom(
    (_tui, _theme, _keybindings, done) => new Overlay(
      content,
      {
        promptTitle: PLAN_REVIEW_TITLE,
        options: [PLAN_REVIEW_APPROVE, PLAN_REVIEW_REFINE],
        helpText: "esc cancel",
      },
      {
        onPick: choice => done(choice),
        onCancel: () => done(undefined),
      },
    ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
        fullscreen: true,
      },
    },
  )
}

function assertPlanReviewChoice(choice: string | undefined, planUri: string): void {
  if (choice === PLAN_REVIEW_APPROVE || (typeof choice === "string" && choice.startsWith("Approve and "))) return
  if (choice === PLAN_REVIEW_REFINE) {
    throw new PlanNotApprovedError(
      `Plan refinement requested. Update ${planUri}, then stage it again when ready. Stay in plan mode.`,
    )
  }
  throw new PlanNotApprovedError(
    `Plan review was dismissed. The plan at ${planUri} was not approved for execution. Stay in plan mode.`,
  )
}

async function stageNativeOmpPlan(
  host: OmpPlanModeHost,
  params: Record<string, unknown>,
): Promise<{ planUri: string; title: string }> {
  const planUri = typeof params.plan_uri === "string" ? params.plan_uri.trim() : ""
  const content = typeof params.content === "string" ? params.content : ""
  const title = typeof params.title === "string" ? params.title.trim() : ""
  if (!planUri || !content.trim() || !title) {
    throw new Error("cursor_plan_stage requires plan_uri, content, and title")
  }
  const state = host.getPlanModeState()
  if (!state?.enabled) throw new Error("omp plan mode is not active")

  // The file is only the artifact. The caller waits on the host review
  // before this tool returns, so the model cannot skip it with plan_exit.
  const target = localPlanPath(host, planUri)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, "utf8")
  host.setPlanModeState({ ...state, planFilePath: planUri })
  return { planUri, title }
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
        "Leave omp plan mode without approving a plan, and restore normal build tools. " +
        "This is not plan review. OpenCode / Cursor SwitchMode maps non-plan targets here.",
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
        "Stage Cursor CreatePlan markdown in omp's session-local plan artifact and " +
        "wait for the host plan review. Do not call plan_exit to submit or skip that review.",
      parameters: planStageParams,
      loadMode: "essential",
      approval: "read",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const host = await resolvePlanHost(resolveHost)
          const input = params as Record<string, unknown>
          const staged = await stageNativeOmpPlan(host, input)
          const content = typeof input.content === "string" ? input.content : ""
          const choice = options.reviewPlan
            ? await options.reviewPlan({ content, title: staged.title, planUri: staged.planUri })
            : await presentHostPlanReview(ctx, content, staged.title)
          assertPlanReviewChoice(choice, staged.planUri)
          const session = host.getSession()
          session?.setPlanReferencePath?.(staged.planUri)
          await exitOmpPlanMode(host, binderState)
          await session?.followUp?.(
            `The user approved the plan at ${staged.planUri}. Execute the approved plan now.`,
          )
          return textResult(`Plan approved at ${staged.planUri}. Plan mode exited; execution queued.`, {
            action: "plan_approved",
            planFilePath: staged.planUri,
            title: staged.title,
            planExists: true,
          })
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
