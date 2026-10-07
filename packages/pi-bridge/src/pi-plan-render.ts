/**
 * Transcript rendering for plain pi's `cursor_plan_stage`: the staged plan is
 * shown as Markdown in the tool row before the approval dialog opens, and stays
 * one expand away afterwards.
 *
 * pi-tui components and theme helpers come from pi's own extension virtual
 * modules, injected by the pi manifest entry (`extension-pi.ts`). Without them
 * the tool registers no renderers and pi's default tool rendering applies.
 */
import type { PiRegisterToolDefinition } from "./pi-provider-types.js"

type PiComponent = { render(width: number): string[] }
type PiContainer = PiComponent & { addChild(component: PiComponent): void }

export type PiPlanRenderModules = {
  Container: new () => PiContainer
  Text: new (text?: string, paddingX?: number, paddingY?: number) => PiComponent
  Markdown: new (text: string, paddingX: number, paddingY: number, theme: unknown) => PiComponent
  getMarkdownTheme: () => unknown
  keyHint?: (keybinding: string, description: string) => string
}

type PiThemeLike = {
  fg(color: string, text: string): string
  bold(text: string): string
}

type PlanStageArgs = { content?: unknown; title?: unknown }

type RenderContextLike = {
  args?: PlanStageArgs
  isError?: boolean
}

type RenderResultOptions = { expanded: boolean; isPartial: boolean }

let installed: PiPlanRenderModules | undefined

/** Inject pi's `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` modules. */
export function installPiPlanRenderModules(
  tui: Record<string, unknown>,
  codingAgent: Record<string, unknown>,
): void {
  const { Container, Text, Markdown } = tui
  const { getMarkdownTheme, keyHint } = codingAgent
  if (
    typeof Container !== "function"
    || typeof Text !== "function"
    || typeof Markdown !== "function"
    || typeof getMarkdownTheme !== "function"
  ) {
    installed = undefined
    return
  }
  installed = {
    Container: Container as PiPlanRenderModules["Container"],
    Text: Text as PiPlanRenderModules["Text"],
    Markdown: Markdown as PiPlanRenderModules["Markdown"],
    getMarkdownTheme: getMarkdownTheme as PiPlanRenderModules["getMarkdownTheme"],
    ...(typeof keyHint === "function" ? { keyHint: keyHint as PiPlanRenderModules["keyHint"] } : {}),
  }
}

/** Test hook: forget injected modules. */
export function resetPiPlanRenderModules(): void {
  installed = undefined
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ""
  return content
    .map(block => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
      ? (block as { text: string }).text
      : ""))
    .filter(Boolean)
    .join("\n")
}

/**
 * `renderCall` / `renderResult` for `cursor_plan_stage`, or `{}` when pi's
 * render modules were not injected.
 */
export function piPlanStageRenderers(
  modules: PiPlanRenderModules | undefined = installed,
): Pick<PiRegisterToolDefinition, "renderCall" | "renderResult"> {
  if (!modules) return {}
  const { Container, Text, Markdown, getMarkdownTheme, keyHint } = modules
  return {
    renderCall(args, theme) {
      const t = theme as PiThemeLike
      const title = typeof (args as PlanStageArgs | undefined)?.title === "string"
        ? (args as { title: string }).title
        : ""
      return new Text(`${t.fg("toolTitle", t.bold("Plan"))}${title ? ` ${t.fg("accent", title)}` : ""}`, 0, 0)
    },
    renderResult(result, options, theme, context) {
      const t = theme as PiThemeLike
      const { expanded, isPartial } = options as RenderResultOptions
      const ctx = context as RenderContextLike | undefined
      const plan = typeof ctx?.args?.content === "string" ? ctx.args.content : ""
      const status = resultText(result)
      const container = new Container()
      // While the approval dialog is open (partial result) the plan is always
      // shown in full: that is what the user is approving.
      if (plan.trim() && (isPartial || expanded)) {
        container.addChild(new Markdown(plan.trim(), 0, 1, getMarkdownTheme()))
      }
      if (status) {
        container.addChild(new Text(t.fg(ctx?.isError ? "error" : "muted", status), 0, 0))
      }
      if (plan.trim() && !isPartial && !expanded) {
        const hint = keyHint
          ? keyHint("app.tools.expand", "to view the plan")
          : t.fg("muted", "expand to view the plan")
        container.addChild(new Text(`${t.fg("muted", "(")}${hint}${t.fg("muted", ")")}`, 0, 0))
      }
      return container
    },
  }
}
