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
  stagePiPlan,
  preparePiPlanModeLoadout,
  PIFY_CURSOR_HIDDEN_TOOLS,
  PI_PLAN_BASH_PIPE_NOTE,
} from "../packages/pi-bridge/src/pi-plan-mode.ts"
import type { PiExtensionApi, PiRegisterToolDefinition } from "../packages/pi-bridge/src/pi-provider-types.ts"

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
    expect([...capture.tools.keys()].sort()).toEqual([
      PIFY_ENTER_TOOL,
      PIFY_EXIT_TOOL,
      PIFY_WRITE_TOOL,
    ])
    expect(capture.commands.has(PIFY_PLAN_COMMAND)).toBe(true)
    const entered = await enterPiPlanMode(capture, {})
    expect(entered.details.action).toBe("plan_enter")
    const left = await leavePiPlanMode(capture, {})
    expect(left.details.action).toBe("plan_exit")
    const staged = await stagePiPlan(
      capture,
      { plan_uri: "local://demo.md", title: "demo", content: "# demo\n\n- step" },
      {},
    )
    expect(staged.details.action).toBe("plan_approved")
  })
})

describe("registerCursorHostTools pi plan mode", () => {

  test("pi plan tools attach prepareLoadout that hides pify names", () => {
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture: createPiPlanModeCapture() },
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    expect(typeof stage.prepareLoadout).toBe("function")
    const out = stage.prepareLoadout!({
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
    pi.registerCommand!(PIFY_PLAN_COMMAND, {
      handler: async (args) => {
        if (args === "off") planActive = false
      },
    })
    pi.registerTool!({
      name: PIFY_WRITE_TOOL,
      label: "Write",
      description: "write",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "written" }] }),
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

    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture },
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
        if (name === PIFY_WRITE_TOOL) {
          return { isError: false, result: { content: [{ type: "text", text: "written" }] } }
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
    registerCursorHostTools(pi, {
      hostId: "pi",
      // Empty capture: production never sees pify registrations on this API object.
      piPlanMode: { installed: true, capture: createPiPlanModeCapture() },
      executeImageSave: async () => ({ title: "x", output: "x" }),
    })
    const enter = pi.registered.find(t => t.name === PLAN_ENTER_TOOL)!
    await enter.execute("c1", {}, undefined, undefined, ctx)
    const stage = pi.registered.find(t => t.name === CURSOR_PLAN_STAGE_TOOL)!
    await stage.execute(
      "c2",
      { plan_uri: "local://t.md", title: "t", content: "# t\n" },
      undefined,
      undefined,
      ctx,
    )
    expect(calls.map(c => c.name)).toEqual([PIFY_ENTER_TOOL, PIFY_WRITE_TOOL, PIFY_EXIT_TOOL])
    expect(pi.messages).toEqual([])
  })

  test("stage revise/dismiss becomes PlanNotApprovedError", async () => {
    const pi = fakePi()
    const capture = installPiPlanModeCapture(pi)
    pi.registerTool!({
      name: PIFY_WRITE_TOOL,
      label: "Write",
      description: "write",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "written" }] }),
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
    registerCursorHostTools(pi, {
      hostId: "pi",
      piPlanMode: { installed: true, capture },
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
