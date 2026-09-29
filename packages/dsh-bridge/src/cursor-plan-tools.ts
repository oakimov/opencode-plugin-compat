/** Optional Cursor plan contracts backed by DSH's native plan service/review. */
import { dshToolInputs } from "./host/profile.js"
import type { DshGenerateOptions } from "./translate/context.js"
import type { DshToolInputVocabulary } from "./translate/tools.js"
import type { StreamChunk } from "./translate/stream.js"

const STAGE = "cursor_plan_stage"
export const CURSOR_PLAN_ENTRY = "plan_enter"

/** A completed prose plan still needs the host's native review gate. */
export async function* reviewCompletedCursorPlan(
  chunks: AsyncIterable<StreamChunk>,
  planActive: () => boolean,
): AsyncGenerator<StreamChunk> {
  let text = ""
  let calledTool = false
  let usage: StreamChunk | undefined
  let nextIndex = 0
  for await (const chunk of chunks) {
    if (chunk.type === "block-start") nextIndex = Math.max(nextIndex, chunk.index + 1)
    if (chunk.type === "text-delta") text += chunk.text
    if (chunk.type === "block-end" && chunk.block.type === "tool-call") calledTool = true
    if (chunk.type === "usage") {
      usage = chunk
      continue
    }
    if (chunk.type !== "finish") {
      yield chunk
      continue
    }
    const markdown = chunk.reason.kind === "stop" && !calledTool && planActive()
      ? completedPlanMarkdown(text)
      : undefined
    if (markdown) {
      calledTool = true
      const id = `host_plan_stage_${crypto.randomUUID()}`
      const index = nextIndex
      const args = JSON.stringify({ plan: markdown })
      yield { type: "block-start", index, blockType: "tool-call" }
      yield { type: "tool-call-delta", index, id, name: "exit_plan_mode", argumentsDelta: args }
      yield { type: "block-end", index, block: { type: "tool-call", id, name: "exit_plan_mode", arguments: args } }
      if (usage) yield usage
      yield { ...chunk, reason: { kind: "tool-calls" } }
    } else {
      if (usage) yield usage
      yield chunk
    }
    usage = undefined
  }
  if (usage) yield usage
}

/** A markdown title and body distinguish a submitted plan from planning chatter. */
export function completedPlanMarkdown(text: string): string | undefined {
  const heading = /(?:^|\n|[.!?])\s*(#{1,6})\s+([^\n]+)/m.exec(text)
  if (!heading?.[0] || !heading[1] || !heading[2]) return undefined
  const body = text.slice(heading.index + heading[0].indexOf(heading[1]))
  const firstLineEnd = body.indexOf("\n")
  if (firstLineEnd < 0) return undefined
  const remainder = body.slice(firstLineEnd + 1).trim()
  if (remainder.length < 60) return undefined
  const title = heading[2].trim().replace(/\s*#+\s*$/, "")
  if (!title) return undefined
  return heading[1] === "#" ? body.trim() : `# ${title}\n\n${remainder}`
}

// Route the actual call to DSH's registered exit tool: its full runtime pipeline,
// review UI, cancellation, feedback, and next-step transition remain authoritative.
export const cursorPlanToolInputs: DshToolInputVocabulary = {
  ...dshToolInputs(),
  exit_plan_mode: {
    providerName: STAGE,
    inputAliases: {},
    providerKeys: {},
    providerDescription: "Present the complete markdown plan for user review. Enter plan mode with plan_enter first. "
      + "Wait for this tool's result: success approves execution; an error keeps planning. "
      + "The host retains the submitted plan in its session. Do not substitute a question for this review.",
    providerSchema: {
      type: "object",
      properties: {
        plan_uri: { type: "string", description: "Plan artifact reference; the host retains the review content in its session." },
        title: { type: "string", description: "Short plan title" },
        content: { type: "string", description: "Complete markdown plan starting with a # heading" },
      },
      required: ["plan_uri", "title", "content"],
      additionalProperties: false,
    },
    toHostInput: input => ({ plan: input.content }),
    toProviderInput: input => ({
      plan_uri: "session:plan-review",
      title: typeof input.plan === "string" ? /^#\s+(.+)/m.exec(input.plan)?.[1] ?? "Plan" : "Plan",
      content: input.plan,
    }),
  },
}

/** Keep deployment guidance consistent with the canonical catalog name. */
export function prepareCursorPlanOptions(options: DshGenerateOptions): DshGenerateOptions {
  if (!options.tools?.some(tool => tool.name === "exit_plan_mode")) return options
  const rewrite = (text: string) => text.replace(/\bexit_plan_mode\b/g, STAGE)
  const reviewGuidance = "DSH plan review for Cursor: cursor_plan_stage is already an advertised tool in this request. "
    + "When in plan mode and your plan is complete, call cursor_plan_stage directly with "
    + "plan_uri (use 'session:plan-review'), title, and content (the complete markdown plan starting with #). "
    + "Do not look up a CreatePlan schema, paste the completed plan as prose, or ask a generic approval question. "
    + "Do not call cursor_plan_stage outside plan mode. Wait for its result before implementing."
  return {
    ...options,
    system: [options.system ? rewrite(options.system) : "", reviewGuidance].filter(Boolean).join("\n\n"),
    messages: options.messages.map(message => message.role !== "system" ? message : {
      ...message,
      content: message.content.map(block => block?.type === "text" && typeof block.text === "string"
        ? { ...block, text: rewrite(block.text) } : block),
    }),
  }
}

type PlanAgent = {
  session: { requestHeader?: () => { config?: { provider?: string } } | undefined }
}
export type PlanToolContext = {
  tools: {
    get: (name: string, scope?: unknown) => unknown
    register: (definition: Record<string, unknown>) => unknown
  }
  commands: {
    find: (agent: PlanAgent, name: string) => unknown
    execute: (agent: PlanAgent, line: string, attachments: unknown[], signal: AbortSignal) => Promise<{ result: { kind: string; text?: string } } | undefined>
  }
}

/** Global registration; execution invokes the calling agent's native plan command. */
export function registerCursorPlanEntry(ctx: PlanToolContext, cursorProviders: ReadonlySet<string>): void {
  if (ctx.tools.get(CURSOR_PLAN_ENTRY)) return
  ctx.tools.register({
    name: CURSOR_PLAN_ENTRY,
    description: "Enter the host's plan mode before designing a plan. Submit the completed plan for review before implementing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "object", properties: { selected: { type: "boolean", const: true } }, required: ["selected"], additionalProperties: false },
      render: () => [{ type: "text", text: "Plan mode selected; the host applies it before the next step. Present the completed plan for review before implementation." }],
    },
    async execute(_args: unknown, exec: { agent?: PlanAgent; signal: AbortSignal }) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error("Plan entry requires a calling agent")
      const provider = exec.agent.session.requestHeader?.()?.config?.provider
      if (!provider || !cursorProviders.has(provider)) throw new Error("Plan entry is unavailable for this provider")
      if (!ctx.tools.get("exit_plan_mode", exec.agent)) throw new Error("Native plan review is unavailable to this agent")
      if (!ctx.commands.find(exec.agent, "plan")) throw new Error("Native plan mode is unavailable to this agent")
      const selection = await ctx.commands.execute(exec.agent, "/plan", [], exec.signal)
      if (selection?.result.kind !== "success") {
        throw new Error(selection?.result.text ?? "The host did not select plan mode")
      }
      return { selected: true }
    },
  })
}
