import { describe, expect, test } from "bun:test"
import {
  bindOmpPlanModeHost,
  bindOmpPlanModeHostFromSession,
  createPlanModeBinderState,
  DEFAULT_PLAN_FILE_URL,
  enterOmpPlanMode,
  exitOmpPlanMode,
  findHostCodingAgentPackageRoot,
  importHostCodingAgentModule,
  type OmpPlanModeSession,
  type OmpPlanModeState,
  type OmpPlanProposalHandler,
} from "../packages/pi-bridge/src/plan-mode-host.ts"

function fakeSession(options: {
  tools?: string[]
  hasWrite?: boolean
  streaming?: boolean
  initial?: OmpPlanModeState
} = {}): OmpPlanModeSession & {
  proposalHandler: OmpPlanProposalHandler | null | undefined
  contextCalls: Array<{ deliverAs?: string } | undefined>
  activeTools: string[]
} {
  let state = options.initial
  let tools = [...(options.tools ?? ["read", "bash", "edit"])]
  const session = {
    proposalHandler: undefined as OmpPlanProposalHandler | null | undefined,
    contextCalls: [] as Array<{ deliverAs?: string } | undefined>,
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
    preparePlanForReview: async (title: string) => ({
      content: [{ type: "text" as const, text: `ready:${title}` }],
      details: { title },
    }),
    sendPlanModeContext: async (opts?: { deliverAs?: "steer" | "followUp" | "nextTurn" }) => {
      session.contextCalls.push(opts)
    },
    getEnabledToolNames: () => tools,
    setActiveToolsByName: async (names: string[]) => {
      tools = [...names]
    },
    hasBuiltInTool: (name: string) => name === "write" && options.hasWrite !== false,
    isStreaming: options.streaming === true,
  }
  return session
}

describe("omp plan-mode host binder", () => {
  test("bindOmpPlanModeHost resolves main session from an injected registry", async () => {
    const session = fakeSession()
    const host = await bindOmpPlanModeHost({
      registry: {
        get: id => (id === "Main" ? { id: "Main", kind: "main", session } : undefined),
        list: () => [{ id: "Main", kind: "main", session }],
      },
    })
    expect(host?.getSession()).toBe(session)
  })

  test("bindOmpPlanModeHost resolves the host ExtensionAPI.pi registry singleton", async () => {
    const session = fakeSession()
    let requestedImport = false
    const host = await bindOmpPlanModeHost({
      hostPi: {
        MAIN_AGENT_ID: "Main",
        AgentRegistry: {
          global: () => ({
            get: id => (id === "Main" ? { id: "Main", kind: "main", session } : undefined),
            list: () => [{ id: "Main", kind: "main", session }],
          }),
        },
      },
      importModule: async () => {
        requestedImport = true
        throw new Error("must use host self-reference")
      },
    })
    expect(host?.getSession()).toBe(session)
    expect(requestedImport).toBe(false)
  })

  test("bindOmpPlanModeHost returns undefined when no live session exists", async () => {
    const host = await bindOmpPlanModeHost({
      registry: {
        get: () => undefined,
        list: () => [{ id: "Main", kind: "main", session: null }],
      },
    })
    expect(host).toBeUndefined()
  })

  test("bindOmpPlanModeHost returns undefined when coding-agent import fails", async () => {
    const host = await bindOmpPlanModeHost({
      importModule: async () => {
        throw new Error("not installed")
      },
    })
    expect(host).toBeUndefined()
  })

  test("findHostCodingAgentPackageRoot walks from CLI entry to matching package.json", () => {
    const files = new Map<string, string>([
      ["/host/pkg/package.json", JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" })],
      ["/host/pkg/dist/cli.js", ""],
    ])
    const root = findHostCodingAgentPackageRoot(
      "/host/pkg/dist/cli.js",
      "@oh-my-pi/pi-coding-agent",
      {
        existsSync: path => files.has(path),
        readFileSync: (path, _encoding) => files.get(path) ?? "",
        realpathSync: path => path,
      },
      {
        dirname: path => {
          const idx = path.lastIndexOf("/")
          return idx <= 0 ? path : path.slice(0, idx)
        },
        join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
      },
    )
    expect(root).toBe("/host/pkg")
  })

  test("findHostCodingAgentPackageRoot returns undefined for a mismatched package name", () => {
    const files = new Map<string, string>([
      ["/host/pkg/package.json", JSON.stringify({ name: "other" })],
    ])
    const root = findHostCodingAgentPackageRoot(
      "/host/pkg/dist/cli.js",
      "@oh-my-pi/pi-coding-agent",
      {
        existsSync: path => files.has(path),
        readFileSync: (path, _encoding) => files.get(path) ?? "",
        realpathSync: path => path,
      },
      {
        dirname: path => {
          const idx = path.lastIndexOf("/")
          return idx <= 0 ? path : path.slice(0, idx)
        },
        join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
      },
    )
    expect(root).toBeUndefined()
  })

  test("importHostCodingAgentModule prefers registry file URL from real omp CLI", async () => {
    const { realpathSync } = await import("node:fs")
    const { which } = await import("bun")
    const ompBin = which("omp")
    if (!ompBin) return
    const cliEntry = realpathSync(ompBin)
    const imported: string[] = []
    const mod = {
      AgentRegistry: { global: () => ({ get: () => undefined, list: () => [] }) },
      MAIN_AGENT_ID: "Main",
    }
    const result = await importHostCodingAgentModule("@oh-my-pi/pi-coding-agent", {
      hostCliEntry: cliEntry,
      importModule: async id => {
        imported.push(id)
        if (id.startsWith("file:") && id.includes("agent-registry")) return mod
        throw new Error(`unexpected import: ${id}`)
      },
    })
    expect(result?.AgentRegistry?.global).toBeDefined()
    expect(imported.some(id => id.startsWith("file:") && id.includes("agent-registry"))).toBe(true)
    expect(imported).not.toContain("@oh-my-pi/pi-coding-agent")
  })

  test("bindOmpPlanModeHost imports coding-agent via hostCliEntry before bare specifier", async () => {
    const session = fakeSession()
    const imported: string[] = []
    const host = await bindOmpPlanModeHost({
      hostCliEntry: "/does/not/exist/cli.js",
      importModule: async id => {
        imported.push(id)
        if (id === "@oh-my-pi/pi-coding-agent") {
          return {
            AgentRegistry: {
              global: () => ({
                get: (agentId: string) =>
                  agentId === "Main" ? { id: "Main", kind: "main", session } : undefined,
                list: () => [{ id: "Main", kind: "main", session }],
              }),
            },
            MAIN_AGENT_ID: "Main",
          }
        }
        throw new Error(`missing module: ${id}`)
      },
    })
    expect(host?.getSession()).toBe(session)
    expect(imported).toContain("@oh-my-pi/pi-coding-agent")
  })

  test("enter enables plan mode without installing omp's validation-only proposal handler", async () => {
    const session = fakeSession({
      tools: ["read", "bash", "edit", "plan_enter", "plan_exit"],
      hasWrite: true,
      streaming: true,
    })
    const host = bindOmpPlanModeHostFromSession(session)
    const binder = createPlanModeBinderState()

    const result = await enterOmpPlanMode(host, binder)

    expect(result.details.action).toBe("plan_enter")
    expect(result.details.already).toBeUndefined()
    expect(host.getPlanModeState()).toEqual({
      enabled: true,
      planFilePath: DEFAULT_PLAN_FILE_URL,
      workflow: "parallel",
      reentry: false,
      previousTools: ["read", "bash", "edit", "plan_enter", "plan_exit"],
    })
    expect(session.proposalHandler).toBeNull()
    expect(session.activeTools).toContain("write")
    expect(session.activeTools).not.toContain("plan_enter")
    // The provider's held Cursor Run owns the mode-switch continuation and
    // injects the Cursor reminder after approval; steering omp here would
    // supersede that Run and replay the SwitchMode request.
    expect(session.contextCalls).toEqual([])
    expect(binder.previousTools).toEqual(["read", "bash", "edit", "plan_enter", "plan_exit"])
    expect(binder.hasEntered).toBe(true)
  })

  test("adopts an existing native plan into the bridged tool lifecycle", async () => {
    const originalTools = ["read", "bash", "edit", "write", "plan_enter", "plan_exit"]
    const session = fakeSession({
      tools: originalTools,
      initial: {
        enabled: true,
        planFilePath: "local://existing.md",
        workflow: "iterative",
      },
    })
    const host = bindOmpPlanModeHostFromSession(session)
    const binder = createPlanModeBinderState()
    const result = await enterOmpPlanMode(host, binder)

    expect(result.details).toEqual({
      action: "plan_enter",
      already: true,
      planFilePath: "local://existing.md",
    })
    expect(host.getPlanModeState()?.previousTools).toEqual(originalTools)
    expect(session.activeTools).not.toContain("plan_enter")
    expect(binder.previousTools).toEqual(originalTools)
    expect(session.proposalHandler).toBeUndefined()
    expect(session.contextCalls).toEqual([])
  })

  test("enter does not activate a shadowing non-built-in write tool", async () => {
    const session = fakeSession({
      tools: ["read", "bash", "edit"],
      hasWrite: false,
    })
    const host = bindOmpPlanModeHostFromSession(session)
    await enterOmpPlanMode(host)
    expect(session.activeTools).toEqual(["read", "bash", "edit"])
  })

  test("exit clears handler, restores tools, and drops plan state", async () => {
    const session = fakeSession({ hasWrite: true })
    const host = bindOmpPlanModeHostFromSession(session)
    const binder = createPlanModeBinderState()

    await enterOmpPlanMode(host, binder)
    expect(host.getPlanModeState()?.enabled).toBe(true)

    const result = await exitOmpPlanMode(host, binder)

    expect(result.details).toEqual({ action: "plan_exit" })
    expect(host.getPlanModeState()).toBeUndefined()
    expect(session.proposalHandler).toBeNull()
    expect(session.activeTools).toEqual(["read", "bash", "edit"])
    expect(binder.previousTools).toBeUndefined()
  })

  test("exit is idempotent when already out of plan mode", async () => {
    const session = fakeSession()
    const host = bindOmpPlanModeHostFromSession(session)
    const result = await exitOmpPlanMode(host)
    expect(result.details).toEqual({ action: "plan_exit", already: true })
  })

  test("re-enter after exit marks reentry", async () => {
    const session = fakeSession({ hasWrite: true })
    const host = bindOmpPlanModeHostFromSession(session)
    const binder = createPlanModeBinderState()

    await enterOmpPlanMode(host, binder)
    await exitOmpPlanMode(host, binder)
    await enterOmpPlanMode(host, binder)

    expect(host.getPlanModeState()?.reentry).toBe(true)
  })
})
