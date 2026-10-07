import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CURSOR_PLAN_STAGE_TOOL,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  PlanNotApprovedError,
  registerCursorHostTools,
} from "../packages/pi-bridge/src/cursor-host-tools.ts"
import {
  createPiPlanModeCapture,
  detectPiPlanModeInstalled,
  enterPiPlanMode,
  installPiPlanModeCapture,
  leavePiPlanMode,
  PI_PLAN_MISSING_REASON,
  PIFY_ENTER_TOOL,
  PIFY_EXIT_TOOL,
  PIFY_PLAN_COMMAND,
  PIFY_WRITE_TOOL,
  PI_PLAN_QUEUED_HANDOFF,
  stagePiPlan,
  preparePiPlanModeLoadout,
  PIFY_CURSOR_HIDDEN_TOOLS,
  PI_PLAN_BASH_PIPE_NOTE,
  piPlanFileName,
  createPiPlanReopenSuppression,
  allowOpencodePlanToolsInPifyPlanMode,
  OPENCODE_PLAN_TOOLS_FOR_PIFY,
  PIFY_REMINDER_TYPE,
  canonicalPiPlanText,
  canonicalPifyReminders,
} from "../packages/pi-bridge/src/pi-plan-mode.ts"
import { isHiddenHostNote, resetHiddenHostNotes } from "../packages/pi-bridge/src/host-notes.ts"
import { piPlanStageRenderers } from "../packages/pi-bridge/src/pi-plan-render.ts"
import type { PiExtensionApi, PiRegisterToolDefinition } from "../packages/pi-bridge/src/pi-provider-types.ts"

function tmpPlansDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocp-pi-host-agent-")), "plans")
}

function fakePi(): PiExtensionApi & {
  registered: PiRegisterToolDefinition[]
  commands: Array<{ name: string; handler: Function }>
  messages: string[]
  active: string[]
} {
  const registered: PiRegisterToolDefinition[] = []
  const commands: Array<{ name: string; handler: Function }> = []
  const messages: string[] = []
  let active = ["read", "bash", "edit", "write"]
  const pi: PiExtensionApi & {
    registered: PiRegisterToolDefinition[]
    commands: Array<{ name: string; handler: Function }>
    messages: string[]
    active: string[]
  } = {
    registered,
    commands,
    messages,
    get active() {
      return active
    },
    registerProvider() { },
    registerTool(tool) {
      registered.push(tool)
    },
    registerCommand(name, def) {
      commands.push({ name, handler: def.handler as Function })
    },
    sendUserMessage(content) {
      messages.push(content)
    },
    getActiveTools: () => active,
    getAllTools: () => [...active, ...registered.map(t => t.name)],
    setActiveTools: async names => {
      active = [...names]
    },
  }
  return pi
}

describe("detectPiPlanModeInstalled", () => {
  test("reads settings packages and npm install tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-pi-plan-detect-"))
    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ packages: ["npm:@pify/plan-mode"] }),
    )
    expect(detectPiPlanModeInstalled({}, [root])).toBe(true)

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-pi-plan-bare-"))
    expect(detectPiPlanModeInstalled({}, [bare])).toBe(false)
    fs.mkdirSync(path.join(bare, "npm", "node_modules", "@pify", "plan-mode"), { recursive: true })
    fs.writeFileSync(
      path.join(bare, "npm", "node_modules", "@pify", "plan-mode", "package.json"),
      "{}",
    )
    expect(detectPiPlanModeInstalled({}, [bare])).toBe(true)
  })
})

describe("installPiPlanModeCapture", () => {
  test("captures later-registered pify tools and /plan command", async () => {
    const pi = fakePi()
    const capture = installPiPlanModeCapture(pi)
    pi.registerTool!({
      name: PIFY_ENTER_TOOL,
      label: "Enter",
      description: "enter",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "entered" }] }),
    })
    pi.registerTool!({
      name: PIFY_WRITE_TOOL,
      label: "Write",
      description: "write",
      parameters: {},
      execute: async (_id, params) => ({ content: [{ type: "text", text: `wrote ${(params as { title: string }).title}` }] }),
    })
    pi.registerTool!({
      name: PIFY_EXIT_TOOL,
      label: "Exit",
      description: "exit",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: "Approved. Implementation instructions were queued — plan mode is off." }],
      }),
    })
    pi.registerCommand!(PIFY_PLAN_COMMAND, {
      handler: async (args) => ({ off: args === "off" }),
    })
    // write_plan is never driven: it writes into <cwd>/.pi/plans.
    expect([...capture.tools.keys()].sort()).toEqual([
      PIFY_ENTER_TOOL,
      PIFY_EXIT_TOOL,
    ])
    expect(capture.commands.has(PIFY_PLAN_COMMAND)).toBe(true)
    const entered = await enterPiPlanMode(capture, {})
    expect(entered.details.action).toBe("plan_enter")
    const left = await leavePiPlanMode(capture, {})
    expect(left.details.action).toBe("plan_exit")
    const plansDir = tmpPlansDir()
    const staged = await stagePiPlan(
      capture,
      { plan_uri: "local://demo.md", title: "demo", content: "# demo\n\n- step" },
      {},
      { plansDir, now: () => 1700 },
    )
    expect(staged.details.action).toBe("plan_approved")
    expect(staged.details.planFilePath).toBe(path.join(plansDir, "1700-demo.md"))
    expect(fs.readFileSync(path.join(plansDir, "1700-demo.md"), "utf8")).toBe("# demo\n\n- step\n")
    // pify queues the implementation as the next message: the model must stop now.
    expect(staged.content[0]!.text).toBe(
      `Approved. Implementation instructions were queued — plan mode is off.\n\n${PI_PLAN_QUEUED_HANDOFF}`,
    )
  })
})

describe("registerCursorHostTools pi plan mode", () => {

  test("pi plan tools attach prepareLoadout that hides pify names", async () => {
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture: createPiPlanModeCapture() },
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    expect(typeof stage.prepareLoadout).toBe("function")
    expect(stage.annotations?.readOnlyHint).toBe(true)
    const out = await stage.prepareLoadout!({
      declared: [{ name: "bash", description: "shell" }, { name: "write_plan", description: "w" }],
    })
    expect(out?.hiddenDeclarations).toContain(PIFY_WRITE_TOOL)
  })
  test("refuses execute when @pify/plan-mode is not installed", async () => {
    const pi = fakePi()
    const names = registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: false, capture: createPiPlanModeCapture() },
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    expect(names).toEqual([PLAN_ENTER_TOOL, PLAN_EXIT_TOOL, CURSOR_PLAN_STAGE_TOOL, "cursor_image_save"])
    const enter = pi.registered.find(t => t.name === PLAN_ENTER_TOOL)!
    await expect(enter.execute("c1", {}, undefined, undefined, {})).rejects.toThrow(PI_PLAN_MISSING_REASON)
  })

  test("bridges enter/exit/stage through captured pify tools", async () => {
    const pi = fakePi()
    const capture = installPiPlanModeCapture(pi)
    let planActive = false
    pi.registerTool!({
      name: PIFY_ENTER_TOOL,
      label: "Enter",
      description: "enter",
      parameters: {},
      execute: async () => {
        planActive = true
        return { content: [{ type: "text", text: "Plan mode activated." }] }
      },
    })
    let pifyPlanFile: string | undefined
    pi.registerCommand!(PIFY_PLAN_COMMAND, {
      handler: async (args) => {
        if (args === "off") planActive = false
        if (typeof args === "string" && args.startsWith("open ")) pifyPlanFile = args.slice("open ".length)
      },
    })
    pi.registerTool!({
      name: PIFY_EXIT_TOOL,
      label: "Exit",
      description: "exit",
      parameters: {},
      execute: async () => {
        planActive = false
        return {
          content: [{ type: "text", text: "Approved. Implementation instructions were queued — plan mode is off." }],
        }
      },
    })

    const plansDir = tmpPlansDir()
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture },
      piPlansDir: () => plansDir,
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const enter = pi.registered.find(t => t.name === PLAN_ENTER_TOOL)!
    await enter.execute("c1", {}, undefined, undefined, {})
    expect(planActive).toBe(true)
    expect(pi.getActiveTools!()).not.toContain(PLAN_ENTER_TOOL)

    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    await stage.execute(
      "c2",
      { plan_uri: "local://t.md", title: "t", content: "# t\n" },
      undefined,
      undefined,
      {},
    )
    expect(planActive).toBe(false)
    expect(pifyPlanFile).toBeUndefined()

    // re-enter then leave without approval
    await enter.execute("c3", {}, undefined, undefined, {})
    const exit = pi.registered.find(t => t.name === PLAN_EXIT_TOOL)!
    await exit.execute("c4", {}, undefined, undefined, {})
    expect(planActive).toBe(false)
  })

  test("enter/stage prefer ctx.executeTool when capture is empty (cross-extension)", async () => {
    const pi = fakePi()
    const calls: Array<{ name: string; args: unknown }> = []
    const ctx = {
      executeTool: async (name: string, args: unknown) => {
        calls.push({ name, args })
        if (name === PIFY_ENTER_TOOL) {
          return { isError: false, result: { content: [{ type: "text", text: "Plan mode activated." }] } }
        }
        if (name === PIFY_EXIT_TOOL) {
          return {
            isError: false,
            result: { content: [{ type: "text", text: "Approved. Implementation instructions were queued — plan mode is off." }] },
          }
        }
        return { isError: true, result: { content: [{ type: "text", text: `unknown ${name}` }] } }
      },
    }
    const plansDir = tmpPlansDir()
    registerCursorHostTools(pi, {
      hostId: "pi",
      // Empty capture: production never sees pify registrations on this API object.
      piPlanMode: { installed: true, capture: createPiPlanModeCapture() },
      piPlansDir: () => plansDir,
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const enter = pi.registered.find(t => t.name === PLAN_ENTER_TOOL)!
    await enter.execute("c1", {}, undefined, undefined, ctx)
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    const order: string[] = []
    const updates: Array<{ details: Record<string, unknown> }> = []
    pi.sendUserMessage = content => {
      order.push(`message:${content}`)
      pi.messages.push(content)
    }
    const executeTool = ctx.executeTool
    const orderedCtx = {
      executeTool: async (name: string, args: unknown) => {
        order.push(`tool:${name}`)
        return executeTool(name, args)
      },
    }
    const result = (await stage.execute(
      "c2",
      { plan_uri: "local://t-plan.md", title: "t", content: "# t\n" },
      undefined,
      (partial: { details: Record<string, unknown> }) => {
        order.push("update")
        updates.push(partial)
      },
      orderedCtx,
    )) as { details: { planFilePath: string } }
    const file = result.details.planFilePath
    expect(path.dirname(file)).toBe(plansDir)
    expect(path.basename(file)).toMatch(/^\d+-t-plan\.md$/)
    expect(fs.readFileSync(file, "utf8")).toBe("# t\n")
    expect(calls.map(c => c.name)).toEqual([PIFY_ENTER_TOOL, PIFY_EXIT_TOOL])
    expect(order).toEqual(["update", `tool:${PIFY_EXIT_TOOL}`])
    expect(updates[0]?.details.planFilePath).toBe(file)
    expect(pi.messages).toEqual([])
  })

  test("stage revise/dismiss becomes PlanNotApprovedError", async () => {
    const pi = fakePi()
    const capture = installPiPlanModeCapture(pi)
    pi.registerCommand!(PIFY_PLAN_COMMAND, { handler: async () => { } })
    pi.registerTool!({
      name: PIFY_EXIT_TOOL,
      label: "Exit",
      description: "exit",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: "The user wants revisions. Stay in plan mode and refine the plan." }],
      }),
    })
    const plansDir = tmpPlansDir()
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture },
      piPlansDir: () => plansDir,
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    await expect(
      stage.execute(
        "c1",
        { plan_uri: "local://t.md", title: "t", content: "# t\n" },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toBeInstanceOf(PlanNotApprovedError)
    // The plan stays on disk for refinement.
    expect(fs.readdirSync(plansDir).filter(name => /^\d+-t\.md$/.test(name))).toHaveLength(1)
  })
})

describe("pify reopen reminder suppression", () => {
  test("drops staged-file reminders from the stage tool call through its result", () => {
    const suppression = createPiPlanReopenSuppression(CURSOR_PLAN_STAGE_TOOL)
    const file = "/agent/plans/t-plan.md"
    const reminder = (text: string) => ({ role: "custom", customType: PIFY_REMINDER_TYPE, content: text })
    const stageResult = { role: "toolResult", toolName: CURSOR_PLAN_STAGE_TOOL, content: [] }
    const readResult = { role: "toolResult", toolName: "read", content: [] }
    const assistant = { role: "assistant", content: [] }
    const reopened = reminder(`<system-reminder>\nThe user reopened a saved plan: ${file}\n</system-reminder>`)
    const exitReminder = reminder("<system-reminder>\nPlan mode is OFF.\n</system-reminder>")
    const other = reminder("The user reopened a saved plan: /elsewhere.md")
    const manual = reminder(`The user reopened a saved plan: ${file}`)
    const user = { role: "user", content: `/plan open ${file}` }

    expect(suppression.filter([assistant, stageResult, reopened])).toBeUndefined()
    const stageCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c-stage", name: CURSOR_PLAN_STAGE_TOOL, arguments: {} }],
    }
    suppression.staged(file)
    expect(suppression.filter([stageCall, reopened, stageResult])).toEqual([stageCall, stageResult])
    expect(suppression.filter([
      assistant,
      stageResult,
      readResult,
      reopened,
      exitReminder,
      other,
      assistant,
      user,
      manual,
    ])).toEqual([assistant, stageResult, readResult, exitReminder, other, assistant, user, manual])
    expect(suppression.filter([assistant, stageResult, exitReminder])).toBeUndefined()
  })

  test("staging does not /plan open, so pify never injects a reopen reminder", async () => {
    const pi = fakePi()
    const capture = installPiPlanModeCapture(pi)
    const session: unknown[] = []
    pi.registerCommand!(PIFY_PLAN_COMMAND, {
      handler: async (args) => {
        const file = String(args).slice("open ".length)
        session.push({
          role: "custom",
          customType: PIFY_REMINDER_TYPE,
          content: `<system-reminder>\nThe user reopened a saved plan: ${file}\nIt is the plan to follow now.\n</system-reminder>`,
        })
      },
    })
    pi.registerTool!({
      name: PIFY_EXIT_TOOL,
      label: "Exit",
      description: "exit",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: "The user wants revisions. Stay in plan mode and refine the plan." }],
      }),
    })
    const plansDir = tmpPlansDir()
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture },
      piPlansDir: () => plansDir,
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    await expect(
      stage.execute("c1", { plan_uri: "local://t-plan.md", title: "t", content: "# t\n" }, undefined, undefined, {}),
    ).rejects.toBeInstanceOf(PlanNotApprovedError)
    expect(session).toHaveLength(0)
    expect(pi.messages).toEqual([])
  })
})

describe("allowOpencodePlanToolsInPifyPlanMode", () => {
  test("rewrites OpenCode plan tool names so pify's allowlist accepts them", async () => {
    const handlers: Array<(event: { toolName: string }) => unknown> = []
    const pi = {
      on: (_event: string, handler: (event: { toolName: string }) => unknown) => {
        handlers.push(handler)
      },
    }
    allowOpencodePlanToolsInPifyPlanMode(pi as never)
    const seen: string[] = []
    handlers.push((event) => {
      seen.push(event.toolName)
      if (
        event.toolName !== PIFY_ENTER_TOOL
        && event.toolName !== PIFY_EXIT_TOOL
        && event.toolName !== PIFY_WRITE_TOOL
      ) {
        return { block: true, reason: `custom tool '${event.toolName}' is not known to be read-only` }
      }
      return undefined
    })
    const classify = async (toolName: string) => {
      const event = { toolName }
      let result: unknown
      for (const handler of handlers) {
        const next = await handler(event)
        if (next && typeof next === "object" && "block" in next && (next as { block?: unknown }).block) {
          return next
        }
        result = next
      }
      return result
    }
    expect(await classify(CURSOR_PLAN_STAGE_TOOL)).toBeUndefined()
    expect(await classify(PLAN_ENTER_TOOL)).toBeUndefined()
    expect(await classify(PLAN_EXIT_TOOL)).toBeUndefined()
    expect(await classify("write")).toEqual({
      block: true,
      reason: "custom tool 'write' is not known to be read-only",
    })
    expect(seen).toEqual([
      OPENCODE_PLAN_TOOLS_FOR_PIFY[CURSOR_PLAN_STAGE_TOOL]!,
      OPENCODE_PLAN_TOOLS_FOR_PIFY[PLAN_ENTER_TOOL]!,
      OPENCODE_PLAN_TOOLS_FOR_PIFY[PLAN_EXIT_TOOL]!,
      "write",
    ])
  })
})

describe("piPlanFileName", () => {
  test("accepts one local:// markdown file name", () => {
    expect(piPlanFileName("local://brave-otter-plan.md")).toBe("brave-otter-plan.md")
  })

  test("rejects other schemes, nesting, traversal and non-markdown names", () => {
    for (const uri of [
      "file:///tmp/x.md",
      "local://a/b.md",
      "local://../x.md",
      "local://..%2Fx.md",
      "local://a%5Cb.md",
      "local://.md",
      "local://x.txt",
      "local:///abs.md",
      "local://100%.md",
    ]) {
      expect(() => piPlanFileName(uri)).toThrow()
    }
  })
})

describe("piPlanStageRenderers", () => {
  class FakeText {
    constructor(readonly text = "") { }
    render(): string[] {
      return this.text.split("\n")
    }
  }
  class FakeMarkdown {
    constructor(readonly text: string) { }
    render(): string[] {
      return [`md:${this.text}`]
    }
  }
  class FakeContainer {
    children: Array<{ render(width: number): string[] }> = []
    addChild(child: { render(width: number): string[] }) {
      this.children.push(child)
    }
    render(width: number): string[] {
      return this.children.flatMap(child => child.render(width))
    }
  }
  const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text }
  const modules = {
    Container: FakeContainer,
    Text: FakeText,
    Markdown: FakeMarkdown,
    getMarkdownTheme: () => ({}),
  }

  test("absent host modules register no renderers", () => {
    expect(piPlanStageRenderers(undefined)).toEqual({})
  })

  test("shows the full plan while awaiting approval, collapses it afterwards", () => {
    const { renderCall, renderResult } = piPlanStageRenderers(modules)
    const args = { plan_uri: "local://t-plan.md", title: "t", content: "# Plan\n\n1. step" }
    const call = renderCall!(args, theme, { args }) as FakeText
    expect(call.render()).toEqual(["Plan t"])

    const pending = renderResult!(
      { content: [{ type: "text", text: "Plan file: /agent/plans/t-plan.md — awaiting approval." }] },
      { expanded: false, isPartial: true },
      theme,
      { args, isError: false },
    ) as FakeContainer
    expect(pending.render(80)).toEqual([
      "md:# Plan\n\n1. step",
      "Plan file: /agent/plans/t-plan.md — awaiting approval.",
    ])

    const done = renderResult!(
      { content: [{ type: "text", text: "Approved." }] },
      { expanded: false, isPartial: false },
      theme,
      { args, isError: false },
    ) as FakeContainer
    expect(done.render(80)).toEqual(["Approved.", "(expand to view the plan)"])

    const expanded = renderResult!(
      { content: [{ type: "text", text: "Approved." }] },
      { expanded: true, isPartial: false },
      theme,
      { args, isError: false },
    ) as FakeContainer
    expect(expanded.render(80)).toEqual(["md:# Plan\n\n1. step", "Approved."])
  })
})

describe("preparePiPlanModeLoadout", () => {
  test("hides pify plan tools and warns bash about quote-blind pipes", () => {
    const out = preparePiPlanModeLoadout({
      declared: [
        { name: "bash", description: "Run a shell command." },
        { name: "read", description: "Read a file." },
        { name: "enter_plan_mode", description: "pify enter" },
      ],
    })
    expect(out.hiddenDeclarations).toEqual([...PIFY_CURSOR_HIDDEN_TOOLS])
    expect(out.descriptions?.bash).toContain("Run a shell command.")
    expect(out.descriptions?.bash).toContain(PI_PLAN_BASH_PIPE_NOTE)
  })
})

describe("pify plan vocabulary", () => {
  const reminder = "When the plan is ready:\n1. Write it with write_plan.\n2. Call exit_plan_mode to submit it."

  test("names the advertised stage tool instead of hidden pify tools", () => {
    expect(canonicalPiPlanText(reminder, CURSOR_PLAN_STAGE_TOOL)).toBe(
      "When the plan is ready:\n1. Write it with cursor_plan_stage.\n2. Call cursor_plan_stage to submit it.",
    )
    expect(canonicalPiPlanText("rewrite_plans stays", CURSOR_PLAN_STAGE_TOOL)).toBe("rewrite_plans stays")
  })

  test("plan_enter reports pify's activation text in advertised names", async () => {
    const entered = await enterPiPlanMode(createPiPlanModeCapture(), {
      executeTool: async () => ({
        isError: false,
        result: { content: [{ type: "text", text: "Plan mode activated. Write with write_plan, submit with exit_plan_mode." }] },
      }),
    }, undefined, CURSOR_PLAN_STAGE_TOOL)
    expect(entered.content[0]!.text).toBe(
      "Plan mode activated. Write with cursor_plan_stage, submit with cursor_plan_stage.",
    )
  })

  test("renames pify reminders in context and keeps them recognizable as hidden notes", async () => {
    resetHiddenHostNotes()
    const pi = fakePi()
    const handlers: Array<(event: unknown) => unknown> = []
    pi.on = ((name: string, handler: (event: unknown) => unknown) => {
      if (name === "context") handlers.push(handler)
    }) as never
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture: createPiPlanModeCapture() },
      piPlansDir: () => tmpPlansDir(),
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const note = { role: "custom", customType: PIFY_REMINDER_TYPE, display: false, timestamp: 42, content: reminder }
    const user = { role: "user", content: "write_plan is just a word here", timestamp: 41 }
    let messages: unknown[] = [user, note]
    for (const handler of handlers) {
      const result = handler({ messages }) as { messages?: unknown[] } | undefined
      if (result?.messages) messages = result.messages
    }
    expect(messages[0]).toBe(user)
    const renamed = messages[1] as { content: string }
    expect(renamed.content).toContain("Write it with cursor_plan_stage")
    expect(isHiddenHostNote({ timestamp: 42, content: renamed.content })).toBe(true)
    expect(canonicalPifyReminders([user], CURSOR_PLAN_STAGE_TOOL)).toBeUndefined()
    resetHiddenHostNotes()
  })

  test("two plans with one title do not overwrite each other", async () => {
    const plansDir = tmpPlansDir()
    const ctx = {
      executeTool: async () => ({
        isError: false,
        result: { content: [{ type: "text", text: "Approved." }] },
      }),
    }
    let clock = 100
    const stage = (content: string) => stagePiPlan(
      createPiPlanModeCapture(),
      { plan_uri: "local://same-plan.md", title: "same", content },
      ctx,
      { plansDir, now: () => clock++ },
    )
    const first = await stage("# first\n")
    const second = await stage("# second\n")
    expect(first.details.planFilePath).not.toBe(second.details.planFilePath)
    expect(fs.readFileSync(first.details.planFilePath as string, "utf8")).toBe("# first\n")
    expect(fs.readFileSync(second.details.planFilePath as string, "utf8")).toBe("# second\n")
  })
})
