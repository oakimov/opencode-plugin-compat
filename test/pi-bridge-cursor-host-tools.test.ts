import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  activateCursorHostTools,
  CURSOR_IMAGE_SAVE_TOOL,
  CURSOR_PLAN_STAGE_TOOL,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  registerCursorHostTools,
  USER_REJECTED_REASON,
} from "../packages/pi-bridge/src/cursor-host-tools.ts"
import {
  bindOmpPlanModeHostFromSession,
  type OmpPlanModeSession,
  type OmpPlanModeState,
  type OmpPlanProposalHandler,
} from "../packages/pi-bridge/src/plan-mode-host.ts"
import { maybeRegisterCursorHostTools } from "../packages/pi-bridge/src/extension.ts"
import { mapPlanModeError, PlanNotApprovedError } from "../packages/pi-bridge/src/cursor-host-tools.ts"
import type { PiExtensionApi, PiRegisterToolDefinition } from "../packages/pi-bridge/src/pi-provider-types.ts"

function fakeSession(options: { hasWrite?: boolean } = {}): OmpPlanModeSession & {
  proposalHandler: OmpPlanProposalHandler | null | undefined
  activeTools: string[]
  followUps: string[]
} {
  let state: OmpPlanModeState | undefined
  let tools = ["read", "bash", "edit"]
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-omp-plan-stage-"))
  const session = {
    sessionManager: {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => "test-session",
    },
    proposalHandler: undefined as OmpPlanProposalHandler | null | undefined,
    followUps: [] as string[],
    get activeTools() {
      return tools
    },
    getPlanModeState: () => state,
    setPlanModeState: (next: OmpPlanModeState | undefined) => {
      state = next
    },
    setPlanProposalHandler: (handler: OmpPlanProposalHandler | null) => {
      session.proposalHandler = handler
    },
    preparePlanForReview: async (title: string) => {
      const current = state
      return {
        content: [{ type: "text" as const, text: "Plan ready for review." }],
        details: {
          planFilePath: current?.planFilePath,
          title,
          planExists: true,
        },
      }
    },
    followUp: async (text: string) => {
      session.followUps.push(text)
    },
    sendPlanModeContext: async () => {},
    getEnabledToolNames: () => tools,
    setActiveToolsByName: async (names: string[]) => {
      tools = [...names]
    },
    hasBuiltInTool: (name: string) => name === "write" && options.hasWrite !== false,
    isStreaming: false,
  }
  return session
}

function fakePi(options: {
  planEnabled?: boolean
  tools?: string[]
} = {}): PiExtensionApi & {
  registered: PiRegisterToolDefinition[]
  sessionHandlers: Array<() => void | Promise<void>>
  active: string[]
} {
  let active = [...(options.tools ?? ["read", "bash", "edit", "write"])]
  const registered: PiRegisterToolDefinition[] = []
  const sessionHandlers: Array<() => void | Promise<void>> = []
  const pi: PiExtensionApi & {
    registered: PiRegisterToolDefinition[]
    sessionHandlers: Array<() => void | Promise<void>>
    active: string[]
  } = {
    registered,
    sessionHandlers,
    get active() {
      return active
    },
    registerProvider: () => {},
    registerTool: tool => {
      registered.push(tool)
      if (!active.includes(tool.name)) {
        // getAllTools below includes registered names once activated; seed catalog.
      }
    },
    on: (event, handler) => {
      if (event === "session_start") sessionHandlers.push(handler as () => void | Promise<void>)
    },
    getActiveTools: () => active,
    getAllTools: () => [
      ...active,
      ...registered.map(tool => tool.name).filter(name => !active.includes(name)),
    ],
    setActiveTools: async names => {
      active = [...names]
    },
    getSetting: key => (key === "plan.enabled" ? options.planEnabled !== false : undefined),
  }
  return pi
}

describe("Cursor host tool registration", () => {
  test("omp registers plan enter/exit, native staging, and image save", async () => {
    const session = fakeSession({ hasWrite: true })
    const host = bindOmpPlanModeHostFromSession(session)
    const pi = fakePi()

    const names = registerCursorHostTools(pi, {
      hostId: "omp",
      resolvePlanHost: async () => host,
      executeImageSave: async () => "saved",
    })

    expect(names).toEqual([
      PLAN_ENTER_TOOL,
      PLAN_EXIT_TOOL,
      CURSOR_PLAN_STAGE_TOOL,
      CURSOR_IMAGE_SAVE_TOOL,
    ])
    expect(pi.registered.map(tool => tool.name)).toEqual(names)

    const enter = pi.registered.find(tool => tool.name === PLAN_ENTER_TOOL)!
    const enterResult = (await enter.execute("c1", {}, undefined, undefined, {})) as {
      details: { action: string }
    }
    expect(enterResult.details.action).toBe("plan_enter")
    expect(session.getPlanModeState()?.enabled).toBe(true)

    const stage = pi.registered.find(tool => tool.name === CURSOR_PLAN_STAGE_TOOL)!
    let reviewTitle = ""
    const stageResult = (await stage.execute(
      "c-stage",
      {
        plan_uri: "local://sample-plan.md",
        content: "# Sample\n\n- Inspect\n",
        title: "sample",
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          select: async (title: string) => {
            reviewTitle = title
            return "Approve and execute"
          },
        },
      },
    )) as { content: Array<{ text: string }>; details: { action: string; planFilePath: string } }
    expect(stageResult.details.action).toBe("plan_approved")
    expect(stageResult.details.planFilePath).toBe("local://sample-plan.md")
    expect(reviewTitle).toContain("# Sample")
    expect(session.getPlanModeState()).toBeUndefined()
    expect(session.followUps).toEqual([
      "The user approved the plan at local://sample-plan.md. Execute the approved plan now.",
    ])
    expect(fs.readFileSync(path.join(session.sessionManager!.getArtifactsDir!()!, "local", "sample-plan.md"), "utf8"))
      .toContain("# Sample")

    const exit = pi.registered.find(tool => tool.name === PLAN_EXIT_TOOL)!
    const exitResult = (await exit.execute("c2", {}, undefined, undefined, {})) as {
      details: { action: string; already?: boolean }
    }
    expect(exitResult.details).toEqual({ action: "plan_exit", already: true })
  })

  test("native staging keeps plan mode active when review requests refinement", async () => {
    const session = fakeSession({ hasWrite: true })
    const host = bindOmpPlanModeHostFromSession(session)
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "omp",
      resolvePlanHost: async () => host,
      executeImageSave: async () => "saved",
    })

    const enter = pi.registered.find(tool => tool.name === PLAN_ENTER_TOOL)!
    await enter.execute("c1", {}, undefined, undefined, {})
    const stage = pi.registered.find(tool => tool.name === CURSOR_PLAN_STAGE_TOOL)!

    // Refinement must surface as an error: the Cursor provider reads tool
    // success as "the user approved execution", so a success result here made
    // Cursor start implementing a plan the user had just asked to change.
    let error: Error | undefined
    try {
      await stage.execute(
        "c-stage",
        {
          plan_uri: "local://refine-plan.md",
          content: "# Refine\n\n- Add details\n",
          title: "refine",
        },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { select: async () => "Refine plan" },
        },
      )
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toBe(
      "Plan refinement requested. Update local://refine-plan.md, then propose it again when ready.",
    )
    expect(session.getPlanModeState()?.enabled).toBe(true)
    expect(session.getPlanModeState()?.planFilePath).toBe("local://refine-plan.md")
  })

  test("a cancelled review reports not-approved without claiming refinement", async () => {
    const session = fakeSession({ hasWrite: true })
    const host = bindOmpPlanModeHostFromSession(session)
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "omp",
      resolvePlanHost: async () => host,
      executeImageSave: async () => "saved",
    })
    const enter = pi.registered.find(tool => tool.name === PLAN_ENTER_TOOL)!
    await enter.execute("c1", {}, undefined, undefined, {})
    const stage = pi.registered.find(tool => tool.name === CURSOR_PLAN_STAGE_TOOL)!

    let error: Error | undefined
    try {
      await stage.execute(
        "c-dismiss",
        {
          plan_uri: "local://dismissed-plan.md",
          content: "# Dismiss\n\n- Nothing\n",
          title: "dismiss",
        },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { select: async () => undefined },
        },
      )
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toContain("was not approved")
    expect(error?.message).not.toContain("refinement requested")
    expect(session.getPlanModeState()?.enabled).toBe(true)
  })

  test("mapPlanModeError passes a not-approved reason through verbatim", () => {
    const notApproved = new PlanNotApprovedError("Please refine the plan")
    expect(() => mapPlanModeError(notApproved)).toThrow("Please refine the plan")
  })

  test("mapPlanModeError maps host denials to the Cursor user-reject reason", () => {
    for (const message of [
      "user denied the request",
      "permission rejected",
      "plan approval cancelled",
      "not allowed",
    ]) {
      expect(() => mapPlanModeError(new Error(message))).toThrow(USER_REJECTED_REASON)
    }
    expect(() => mapPlanModeError(new Error("boom"))).toThrow("boom")
  })

  test("plain pi registers cursor_image_save only", () => {
    const pi = fakePi()
    const names = registerCursorHostTools(pi, {
      hostId: "pi",
      executeImageSave: async () => "saved",
    })
    expect(names).toEqual([CURSOR_IMAGE_SAVE_TOOL])
    expect(pi.registered.map(tool => tool.name)).toEqual([CURSOR_IMAGE_SAVE_TOOL])
  })

  test("omp skips plan tools when plan.enabled is false", () => {
    const pi = fakePi({ planEnabled: false })
    const names = registerCursorHostTools(pi, {
      hostId: "omp",
      executeImageSave: async () => "saved",
    })
    expect(names).toEqual([CURSOR_IMAGE_SAVE_TOOL])
  })

  test("cursor_image_save accepts opaque image_id and commits via execute", async () => {
    const pi = fakePi()
    let seenId: unknown
    registerCursorHostTools(pi, {
      hostId: "pi",
      executeImageSave: async args => {
        seenId = args.image_id
        return { title: "saved.png", output: "Wrote saved.png" }
      },
    })
    const tool = pi.registered.find(entry => entry.name === CURSOR_IMAGE_SAVE_TOOL)!
    const result = (await tool.execute("img1", { image_id: "opaque-1" }, undefined, undefined, {
      cwd: "/tmp/project",
    })) as { content: Array<{ text: string }> }

    expect(seenId).toBe("opaque-1")
    expect(result.content[0]?.text).toBe("Wrote saved.png")
  })

  test("cursor_image_save reports missing id without inventing a write", async () => {
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "pi",
      executeImageSave: async () =>
        "No pending Cursor image matches that id. It may have already been saved or expired.",
    })
    const tool = pi.registered.find(entry => entry.name === CURSOR_IMAGE_SAVE_TOOL)!
    const result = (await tool.execute("img1", { image_id: "missing" }, undefined, undefined, {})) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0]?.text).toContain("No pending Cursor image")
  })

  test("plan tool denial maps to Mode switch rejected by user", async () => {
    const pi = fakePi()
    registerCursorHostTools(pi, {
      hostId: "omp",
      resolvePlanHost: async () => {
        throw new Error("Tool plan_enter is blocked by user policy")
      },
      executeImageSave: async () => "saved",
    })
    const enter = pi.registered.find(tool => tool.name === PLAN_ENTER_TOOL)!
    await expect(enter.execute("c1", {}, undefined, undefined, {})).rejects.toThrow(USER_REJECTED_REASON)
  })

  test("activateCursorHostTools adds registered names on session_start", async () => {
    const pi = fakePi({ tools: ["read", "bash"] })
    // Seed catalog with the tools we intend to activate.
    pi.registerTool?.({
      name: CURSOR_IMAGE_SAVE_TOOL,
      label: "Save",
      description: "d",
      parameters: {},
      execute: async () => ({ content: [] }),
    })
    activateCursorHostTools(pi, [CURSOR_IMAGE_SAVE_TOOL, PLAN_ENTER_TOOL])
    await pi.sessionHandlers[0]!()
    expect(pi.active).toContain(CURSOR_IMAGE_SAVE_TOOL)
    // plan_enter was not in getAllTools, so it stays out.
    expect(pi.active).not.toContain(PLAN_ENTER_TOOL)
  })

  test("activateCursorHostTools does not call tool actions during extension load", () => {
    const boom = () => {
      throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.")
    }
    const pi: PiExtensionApi = {
      registerProvider: () => {},
      on: () => {},
      getActiveTools: boom,
      getAllTools: boom,
      setActiveTools: async () => {
        boom()
      },
    }
    expect(() => activateCursorHostTools(pi, [CURSOR_IMAGE_SAVE_TOOL])).not.toThrow()
  })

  test("maybeRegisterCursorHostTools only fires when Cursor is configured", async () => {
    const pi = fakePi()
    expect(
      await maybeRegisterCursorHostTools(pi, "omp", {
        providers: [{ package: "some-other-provider" }],
      }),
    ).toEqual([])
    expect(
      await maybeRegisterCursorHostTools(pi, "omp", {
        providers: [{ package: "unrelated-cursor-tools", providerName: "cursor" }],
      }),
    ).toEqual([])
    const versioned = await maybeRegisterCursorHostTools(pi, "omp", {
      providers: [{ package: "cursor-opencode-provider@1.2.3" }],
    })
    expect(versioned).toContain(CURSOR_IMAGE_SAVE_TOOL)
    expect(versioned).toContain(PLAN_ENTER_TOOL)

    const names = await maybeRegisterCursorHostTools(pi, "omp", {
      providers: [{ package: "cursor-opencode-provider" }],
    })
    expect(names).toContain(CURSOR_IMAGE_SAVE_TOOL)
    expect(names).toContain(PLAN_ENTER_TOOL)
    expect(names).toContain(PLAN_EXIT_TOOL)
  })
})
