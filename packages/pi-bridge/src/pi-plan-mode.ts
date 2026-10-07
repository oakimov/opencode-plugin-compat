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
 * Staging never calls pify `write_plan` (it writes into `<cwd>/.pi/plans`)
 * and never `/plan open` (that injects a hidden reopen reminder with the full
 * plan, which pi turns into a user turn after approval so the model implements
 * twice). OCP writes the plan under the host plans directory, shows it in the
 * transcript, then runs pify `exit_plan_mode` for approval.
 *
 * Filename is deliberately `pi-plan-mode` (not `pify-*`): OCP owns the bridge;
 * the package name is only a detection token.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
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

/**
 * OpenCode plan tools the model calls while `@pify/plan-mode` is active.
 * pify only allowlists its own names, so a `tool_call` rewrite maps these onto
 * those names for classification. Execution still uses the OpenCode tool.
 */
export const OPENCODE_PLAN_TOOLS_FOR_PIFY: Readonly<Record<string, string>> = {
 plan_enter: PIFY_ENTER_TOOL,
 plan_exit: PIFY_EXIT_TOOL,
 cursor_plan_stage: PIFY_WRITE_TOOL,
}

/**
 * pify's `tool_call` hook confirms unknown custom tools. Pi gives each
 * extension its own API, so wrapping `pi.on` here does not see pify; the
 * shared event object does. Rewrite OpenCode plan-tool names to pify's
 * allowlisted names so classification allows them. The agent still executes
 * the original registered tool (`toolCall.name`), not this event field.
 */
export function allowOpencodePlanToolsInPifyPlanMode(pi: PiExtensionApi): void {
 if (typeof pi.on !== "function") return
 pi.on("tool_call", (event: unknown) => {
  if (!event || typeof event !== "object") return undefined
  const record = event as { toolName?: unknown }
  if (typeof record.toolName !== "string") return undefined
  const alias = OPENCODE_PLAN_TOOLS_FOR_PIFY[record.toolName]
  if (alias) record.toolName = alias
  return undefined
 })
}

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
 const wantedTools = new Set([PIFY_ENTER_TOOL, PIFY_EXIT_TOOL])
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

/**
 * pify's own text (its `enter_plan_mode` result, its plan-mode reminder) names
 * `write_plan` / `exit_plan_mode`, which the model never sees. Both are done by
 * the advertised stage tool, so name that instead.
 */
export function canonicalPiPlanText(text: string, stageTool: string): string {
 return text.replace(/\b(?:write_plan|exit_plan_mode)\b/g, stageTool)
}

/**
 * pify's plan-mode reminders with {@link canonicalPiPlanText} applied, or
 * undefined when none named a hidden pify tool.
 */
export function canonicalPifyReminders(messages: readonly unknown[], stageTool: string): unknown[] | undefined {
 let changed = false
 const next = messages.map(message => {
  if (!message || typeof message !== "object") return message
  const m = message as { role?: unknown; customType?: unknown; content?: unknown }
  if (m.role !== "custom" || m.customType !== PIFY_REMINDER_TYPE) return message
  if (typeof m.content === "string") {
   const text = canonicalPiPlanText(m.content, stageTool)
   if (text === m.content) return message
   changed = true
   return { ...m, content: text }
  }
  if (!Array.isArray(m.content)) return message
  let blockChanged = false
  const content = m.content.map(block => {
   if (!block || typeof block !== "object") return block
   const text = (block as { text?: unknown }).text
   if (typeof text !== "string") return block
   const renamed = canonicalPiPlanText(text, stageTool)
   if (renamed === text) return block
   blockChanged = true
   return { ...block, text: renamed }
  })
  if (!blockChanged) return message
  changed = true
  return { ...m, content }
 })
 return changed ? next : undefined
}

export async function enterPiPlanMode(
 capture: PiPlanModeCapture,
 ctx: PiPlanToolContext | undefined,
 pi?: PiExtensionApi,
 stageTool?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { action: "plan_enter" } }> {
 try {
  const text = await callPifyTool(capture, ctx, PIFY_ENTER_TOOL, {}, "plan_enter")
  return {
   content: [{ type: "text", text: (stageTool ? canonicalPiPlanText(text, stageTool) : text) || "Plan mode activated." }],
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

/**
 * pify's approval queues the implementation instructions as the next user
 * message. Implementing in the current turn as well does the work twice.
 */
export const PI_PLAN_QUEUED_HANDOFF =
 "End this turn now. The implementation instructions arrive as a user message that names the plan file; " +
 "implement only then. A plan-mode reminder that arrives first is not that message: acknowledge it without " +
 "acting. Do not call plan_exit (plan mode is already off)."

function queuedImplementation(text: string): boolean {
 return /instructions were queued/i.test(text)
}

function isApprovedOutcome(text: string): boolean {
 const lower = text.toLowerCase()
 return lower.includes("approved") || lower.includes("implementation instructions were queued")
}

/** `local://<name>.md` → `<name>.md`; one plain file name, nothing else. */
export function piPlanFileName(planUri: string): string {
 if (!planUri.startsWith("local://")) {
  throw new Error("cursor_plan_stage plan_uri must use local://<name>.md")
 }
 let name: string
 try {
  name = decodeURIComponent(planUri.slice("local://".length))
 } catch {
  throw new Error("cursor_plan_stage plan_uri must name one plan file: local://<name>.md")
 }
 if (
  !name.endsWith(".md")
  || name.includes("/")
  || name.includes("\\")
  || name.startsWith(".")
  || path.isAbsolute(name)
 ) {
  throw new Error("cursor_plan_stage plan_uri must name one plan file: local://<name>.md")
 }
 return name
}

export const PIFY_REMINDER_TYPE = "plan-mode-reminder"
/** `@pify/plan-mode` session entry holding its plan state; the last one on the branch wins. */
export const PIFY_PLAN_STATE_TYPE = "plan-mode-state"

/** pify's plan state from a session branch, replayed the way pify replays it. */
export function pifyPlanActive(entries: unknown): boolean {
 if (!Array.isArray(entries)) return false
 let active = false
 for (const entry of entries) {
  if (!entry || typeof entry !== "object") continue
  const record = entry as { type?: unknown; customType?: unknown; data?: unknown }
  if (record.type !== "custom" || record.customType !== PIFY_PLAN_STATE_TYPE) continue
  const data = record.data as { active?: unknown } | undefined
  if (data && typeof data.active === "boolean") active = data.active
 }
 return active
}

type PiSessionContextLike = {
 sessionManager?: { getSessionId?: () => string; getBranch?: () => unknown }
}

/**
 * Track pify's plan state per session from pi's `context` event, which runs
 * before every model request. Returns the reader for {@link setPiHostPlanReader}.
 */
export function trackPifyPlanState(
 pi: PiExtensionApi,
 flags: { set(sessionId: string, active: boolean): void; get(sessionId: string): boolean | undefined },
): (sessionId: string) => boolean | undefined {
 if (typeof pi.on === "function") {
  pi.on("context", (_event: unknown, ctx: unknown) => {
   const manager = (ctx as PiSessionContextLike | undefined)?.sessionManager
   const sessionId = manager?.getSessionId?.()
   if (sessionId) flags.set(sessionId, pifyPlanActive(manager?.getBranch?.()))
   return undefined
  })
 }
 return sessionId => flags.get(sessionId)
}

/**
 * Keeps a leftover pify `/plan open` reminder for a file OCP staged out of the
 * model context. Staging no longer opens the file in pify; this remains for
 * a manual `/plan open` of that same path during the stage turn.
 */
export type PiPlanReopenSuppression = {
 /** Record a plan file OCP opened in pify. */
 staged(file: string): void
 /** Messages without suppressed reminders, or undefined when nothing matched. */
 filter(messages: readonly unknown[]): unknown[] | undefined
}

function messageText(content: unknown): string {
 if (typeof content === "string") return content
 return textFromToolResult({ content })
}

function assistantCalledTool(message: { content?: unknown }, toolName: string): boolean {
 if (!Array.isArray(message.content)) return false
 return message.content.some(block => {
  if (!block || typeof block !== "object") return false
  const record = block as { type?: unknown; name?: unknown }
  return record.type === "toolCall" && record.name === toolName
 })
}

export function createPiPlanReopenSuppression(stageToolName: string): PiPlanReopenSuppression {
 const files = new Set<string>()
 return {
  staged(file) {
   files.add(file)
  },
  filter(messages) {
   if (files.size === 0) return undefined
   let afterStage = false
   let removed = false
   const kept = messages.filter(message => {
    if (!message || typeof message !== "object") return true
    const m = message as { role?: unknown; toolName?: unknown; customType?: unknown; content?: unknown }
    if (m.role === "assistant") {
     afterStage = assistantCalledTool(m, stageToolName)
     return true
    }
    if (m.role === "toolResult") {
     if (m.toolName === stageToolName) afterStage = true
     return true
    }
    if (!afterStage || m.role !== "custom" || m.customType !== PIFY_REMINDER_TYPE) return true
    const text = messageText(m.content)
    for (const file of files) {
     if (text.includes(file)) {
      removed = true
      return false
     }
    }
    return true
   })
   return removed ? kept : undefined
  },
 }
}

export type StagePiPlanOptions = {
 /** Host plans directory (pi: `<getAgentDir()>/plans` via the path bridge). */
 plansDir: string
 /** Clock for the plan file's `<created>-` prefix (tests). */
 now?: () => number
 pi?: PiExtensionApi
 reopenSuppression?: PiPlanReopenSuppression
 /** Tool partial-result callback; the transcript renders the plan from it. */
 onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void
}

/**
 * Stage a Cursor plan for pify approval: write it under the host plans
 * directory, show it in the transcript, then run pify `exit_plan_mode`
 * (approval UI). Revise/dismiss/no-UI → throw.
 */
export async function stagePiPlan(
 capture: PiPlanModeCapture,
 params: { plan_uri?: unknown; content?: unknown; title?: unknown },
 ctx: PiPlanToolContext | undefined,
 options: StagePiPlanOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
 const content = typeof params.content === "string" ? params.content : ""
 const title = typeof params.title === "string" ? params.title.trim() : ""
 const planUri = typeof params.plan_uri === "string" ? params.plan_uri.trim() : ""
 if (!planUri || !content.trim() || !title) {
  throw new Error("cursor_plan_stage requires plan_uri, content, and title")
 }

 // The plans directory is shared by every session: name each plan the way
 // OpenCode names session plans, `<created>-<name>.md`, so two plans with one
 // title never overwrite each other.
 const file = path.join(options.plansDir, `${(options.now ?? Date.now)()}-${piPlanFileName(planUri)}`)
 await mkdir(options.plansDir, { recursive: true })
 await writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8")
 options.onUpdate?.({
  content: [{ type: "text", text: `Plan file: ${file} — awaiting approval.` }],
  details: { action: "plan_review", planFilePath: file, title },
 })

 options.reopenSuppression?.staged(file)
 const text = await callPifyTool(
  capture,
  ctx,
  PIFY_EXIT_TOOL,
  { summary: title },
  "cursor_plan_stage_exit",
 )
 if (isNotApprovedOutcome(text) || !isApprovedOutcome(text)) {
  const reason = text.trim()
   || `Plan at ${file} was not approved for execution. Stay in plan mode.`
  throw new Error(reason)
 }
 return {
  content: [{
   type: "text",
   text: queuedImplementation(text) ? `${text.trim()}\n\n${PI_PLAN_QUEUED_HANDOFF}` : (text || `Plan approved (${file}).`),
  }],
  details: {
   action: "plan_approved",
   planFilePath: file,
   title,
   planExists: true,
  },
 }
}

export function refusePiPlanMode(reason: string = PI_PLAN_MISSING_REASON): never {
 throw new Error(reason)
}
