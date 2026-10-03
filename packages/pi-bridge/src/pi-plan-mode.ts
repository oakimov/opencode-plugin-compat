/**
 * Optional plain-pi plan-mode bridge via `@pify/plan-mode`.
 *
 * Cursor advertises OpenCode names `plan_enter` / `plan_exit` /
 * `cursor_plan_stage`. `@pify/plan-mode` registers different names
 * (`enter_plan_mode` / `write_plan` / `exit_plan_mode`) and leaves without
 * approval through `/plan off`.
 *
 * Pi gives each extension its own ExtensionAPI: wrapping `registerTool` on
 * pi-bridge never sees pify's registrations. Production enter/stage therefore
 * call nested tools through `ctx.executeTool` (same session catalog + hooks).
 * Same-API capture remains for unit tests; `/plan` / `/plan off` via
 * `sendUserMessage` is the last-resort enter/leave path.
 *
 * Filename is deliberately `pi-plan-mode` (not `pify-*`): OCP owns the bridge;
 * the package name is only a detection token.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { PiExtensionApi, PiRegisterToolDefinition } from "./pi-provider-types.js"

export const PIFY_ENTER_TOOL = "enter_plan_mode"
export const PIFY_WRITE_TOOL = "write_plan"
export const PIFY_EXIT_TOOL = "exit_plan_mode"
export const PIFY_PLAN_COMMAND = "plan"
export const PIFY_PLAN_STEP_TOOL = "plan_step_done"

export const PIFY_PACKAGE_SPEC = "npm:@pify/plan-mode"
export const PIFY_PACKAGE_DIR = "@pify/plan-mode"

export const PI_PLAN_MISSING_REASON =
 "Plan mode is unavailable: install `@pify/plan-mode` " +
 "(`pi install npm:@pify/plan-mode` or `pify install plan-mode`) and restart pi. " +
 "Without it, Cursor SwitchMode/CreatePlan cannot use a host plan review."

export const PI_PLAN_NOT_CAPTURED_REASON =
 "Plan mode package is installed, but its tools are not callable from pi-bridge. " +
 "Ensure `@pify/plan-mode` is loaded and the host tool context exposes executeTool " +
 "(or list `@opencode-compat/pi-bridge` before `npm:@pify/plan-mode` when relying on " +
 "same-API capture in tests)."

export type CapturedPlanTool = {
 name: string
 execute: PiRegisterToolDefinition["execute"]
}

export type CapturedPlanCommand = {
 name: string
 handler: (args: string | undefined, ctx: Record<string, unknown>) => unknown | Promise<unknown>
}

export type PiPlanModeCapture = {
 tools: Map<string, CapturedPlanTool>
 commands: Map<string, CapturedPlanCommand>
}

export type PiPlanModeBridge = {
 installed: boolean
 capture: PiPlanModeCapture
}

/** Nested-tool context pi passes into registerTool execute handlers. */
export type PiPlanToolContext = {
 executeTool?: (
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
 ) => Promise<{
  isError: boolean
  result: { content?: Array<{ type?: string; text?: string }>; details?: unknown }
 }>
} & Record<string, unknown>

/** Agent dirs searched for settings + npm installs (mirrors config search roots). */
export function agentDirsForPlanDetection(env: NodeJS.ProcessEnv = process.env): string[] {
 const home = env.HOME || env.USERPROFILE || homedir()
 const coding = env.PI_CODING_AGENT_DIR?.trim()
 const config = env.PI_CONFIG_DIR?.trim()
 const dirs = [
  coding,
  config ? path.join(config, "agent") : undefined,
  path.join(home, ".pi", "agent"),
 ].filter((d): d is string => typeof d === "string" && d.length > 0)
 return [...new Set(dirs)]
}

function settingsListsPify(settingsPath: string): boolean {
 try {
  const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown }
  const packages = Array.isArray(raw.packages) ? raw.packages : []
  return packages.some(entry => {
   if (typeof entry !== "string") return false
   const trimmed = entry.trim()
   return trimmed === PIFY_PACKAGE_SPEC
    || trimmed === PIFY_PACKAGE_DIR
    || trimmed.endsWith("/@pify/plan-mode")
    || trimmed.includes("@pify/plan-mode@")
  })
 } catch {
  return false
 }
}

/**
 * True when `@pify/plan-mode` appears in agent settings packages or is present
 * under that agent's `npm/node_modules`.
 */
export function detectPiPlanModeInstalled(
 env: NodeJS.ProcessEnv = process.env,
 dirs: readonly string[] = agentDirsForPlanDetection(env),
): boolean {
 for (const dir of dirs) {
  if (settingsListsPify(path.join(dir, "settings.json"))) return true
  if (existsSync(path.join(dir, "npm", "node_modules", PIFY_PACKAGE_DIR))) return true
 }
 return false
}


/** Pify tools Cursor must not see — drive them only via executeTool / OCP names. */
export const PIFY_CURSOR_HIDDEN_TOOLS = [
 PIFY_ENTER_TOOL,
 PIFY_WRITE_TOOL,
 PIFY_EXIT_TOOL,
 PIFY_PLAN_STEP_TOOL,
] as const

export const PI_PLAN_BASH_PIPE_NOTE =
 "Plan-mode shell note: this host splits bash on `|` even inside quotes, so " +
 "`rg -n 'a|b'` looks like an unknown command `b` and prompts " +
 "`Allow this while planning? unrecognized command: 'b'`. " +
 "While planning, prefer the grep/read tools, or bash without `|` alternation " +
 "(separate commands). That prompt is not plan review — use cursor_plan_stage " +
 "to show the plan approval UI."

/**
 * Hide raw `@pify/plan-mode` names from the model catalog (still callable via
 * ctx.executeTool) and warn about quote-blind `|` splitting on bash.
 */
export function preparePiPlanModeLoadout(
 loadout: { declared: ReadonlyArray<{ name: string; description?: string }> },
): {
 hiddenDeclarations: string[]
 descriptions?: Record<string, string>
} {
 const hiddenDeclarations = [...PIFY_CURSOR_HIDDEN_TOOLS]
 const bash = loadout.declared.find(tool => tool.name === "bash")
 const description = typeof bash?.description === "string" ? bash.description : ""
 if (!description || description.includes("splits bash on `|`")) {
  return { hiddenDeclarations }
 }
 return {
  hiddenDeclarations,
  descriptions: {
   bash: `${description.trim()}\n\n${PI_PLAN_BASH_PIPE_NOTE}`,
  },
 }
}

export function createPiPlanModeCapture(): PiPlanModeCapture {
 return { tools: new Map(), commands: new Map() }
}

/**
 * Wrap `registerTool` / `registerCommand` on this ExtensionAPI only.
 * Production pi gives each package a distinct API object, so this wrap does
 * not see `@pify/plan-mode`; prefer `ctx.executeTool` at call time. Kept for
 * same-API unit tests.
 */
export function installPiPlanModeCapture(
 pi: PiExtensionApi,
 capture: PiPlanModeCapture = createPiPlanModeCapture(),
): PiPlanModeCapture {
 const wantedTools = new Set([PIFY_ENTER_TOOL, PIFY_WRITE_TOOL, PIFY_EXIT_TOOL])
 if (typeof pi.registerTool === "function") {
  const original = pi.registerTool.bind(pi)
  pi.registerTool = (tool: PiRegisterToolDefinition) => {
   if (wantedTools.has(tool.name) && typeof tool.execute === "function") {
    capture.tools.set(tool.name, { name: tool.name, execute: tool.execute.bind(tool) })
   }
   return original(tool)
  }
 }
 if (typeof pi.registerCommand === "function") {
  const originalCmd = pi.registerCommand.bind(pi)
  pi.registerCommand = (name: string, def: { handler?: CapturedPlanCommand["handler"] } & Record<string, unknown>) => {
   if (name === PIFY_PLAN_COMMAND && typeof def.handler === "function") {
    capture.commands.set(name, { name, handler: def.handler.bind(def) })
   }
   return originalCmd(name, def)
  }
 }
 return capture
}

function textFromToolResult(result: unknown): string {
 if (typeof result === "string") return result
 if (!result || typeof result !== "object") return ""
 const content = (result as { content?: unknown }).content
 if (!Array.isArray(content)) return ""
 return content
  .map(block => {
   if (!block || typeof block !== "object") return ""
   const text = (block as { text?: unknown }).text
   return typeof text === "string" ? text : ""
  })
  .filter(Boolean)
  .join("\n")
}

async function callPifyTool(
 capture: PiPlanModeCapture,
 ctx: PiPlanToolContext | undefined,
 name: string,
 args: Record<string, unknown>,
 toolCallId: string,
): Promise<string> {
 if (typeof ctx?.executeTool === "function") {
  const outcome = await ctx.executeTool(name, args)
  const text = textFromToolResult(outcome.result)
  if (outcome.isError) {
   throw new Error(text.trim() || `${name} failed`)
  }
  return text
 }
 const tool = capture.tools.get(name)
 if (tool) {
  const result = await tool.execute(toolCallId, args, undefined, undefined, ctx)
  return textFromToolResult(result)
 }
 throw new Error(PI_PLAN_NOT_CAPTURED_REASON)
}

export async function enterPiPlanMode(
 capture: PiPlanModeCapture,
 ctx: PiPlanToolContext | undefined,
 pi?: PiExtensionApi,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { action: "plan_enter" } }> {
 try {
  const text = await callPifyTool(capture, ctx, PIFY_ENTER_TOOL, {}, "plan_enter")
  return {
   content: [{ type: "text", text: text || "Plan mode activated." }],
   details: { action: "plan_enter" },
  }
 } catch (error) {
  if (!(error instanceof Error) || error.message !== PI_PLAN_NOT_CAPTURED_REASON) throw error
 }
 if (pi?.sendUserMessage) {
  await pi.sendUserMessage("/plan", { expandPromptTemplates: true })
  return {
   content: [{ type: "text", text: "Plan mode activated via /plan." }],
   details: { action: "plan_enter" },
  }
 }
 throw new Error(PI_PLAN_NOT_CAPTURED_REASON)
}

export async function leavePiPlanMode(
 capture: PiPlanModeCapture,
 ctx: Record<string, unknown> | undefined,
 pi?: PiExtensionApi,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { action: "plan_exit" } }> {
 // Never call pify `exit_plan_mode` here — that submits for approval.
 const command = capture.commands.get(PIFY_PLAN_COMMAND)
 if (command) {
  await command.handler("off", ctx ?? {})
  return {
   content: [{ type: "text", text: "Left plan mode without approving a plan." }],
   details: { action: "plan_exit" },
  }
 }
 if (pi?.sendUserMessage) {
  await pi.sendUserMessage("/plan off", { expandPromptTemplates: true })
  return {
   content: [{ type: "text", text: "Left plan mode without approving a plan." }],
   details: { action: "plan_exit" },
  }
 }
 throw new Error(PI_PLAN_NOT_CAPTURED_REASON)
}

function isNotApprovedOutcome(text: string): boolean {
 const lower = text.toLowerCase()
 return (
  lower.includes("wants revisions")
  || lower.includes("discarded the plan")
  || lower.includes("stay in plan mode")
  || lower.includes("no ui available for the approval")
 )
}

function isApprovedOutcome(text: string): boolean {
 const lower = text.toLowerCase()
 return lower.includes("approved") || lower.includes("implementation instructions were queued")
}

/**
 * Stage a Cursor plan through pify write_plan + exit_plan_mode (approval UI).
 * Prefer ctx.executeTool (cross-extension). Revise/dismiss/no-UI → throw.
 */
export async function stagePiPlan(
 capture: PiPlanModeCapture,
 params: { plan_uri?: unknown; content?: unknown; title?: unknown },
 ctx: PiPlanToolContext | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
 const content = typeof params.content === "string" ? params.content : ""
 const title = typeof params.title === "string" ? params.title.trim() : ""
 const planUri = typeof params.plan_uri === "string" ? params.plan_uri.trim() : ""
 if (!content.trim() || !title) {
  throw new Error("cursor_plan_stage requires plan_uri, content, and title")
 }

 await callPifyTool(
  capture,
  ctx,
  PIFY_WRITE_TOOL,
  { title, content },
  "cursor_plan_stage_write",
 )
 const text = await callPifyTool(
  capture,
  ctx,
  PIFY_EXIT_TOOL,
  { summary: title },
  "cursor_plan_stage_exit",
 )
 if (isNotApprovedOutcome(text) || !isApprovedOutcome(text)) {
  const reason = text.trim()
   || `Plan at ${planUri || title} was not approved for execution. Stay in plan mode.`
  throw new Error(reason)
 }
 return {
  content: [{ type: "text", text: text || `Plan approved (${title}).` }],
  details: {
   action: "plan_approved",
   planFilePath: planUri || title,
   title,
   planExists: true,
  },
 }
}

export function refusePiPlanMode(reason: string = PI_PLAN_MISSING_REASON): never {
 throw new Error(reason)
}
