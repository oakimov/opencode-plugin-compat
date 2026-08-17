/**
 * ACP-shaped plan-mode enter/exit helpers for omp.
 *
 * Extension tools receive `ExtensionContext`, which has no plan-mode setters.
 * The live main `AgentSession` is reachable via omp's process-global
 * `AgentRegistry` (`MAIN_AGENT_ID = "Main"`), the same handle ACP uses.
 *
 * Enter/exit mirror `AcpAgent.#applyModeChange` plus InteractiveMode's
 * built-in `write` augmentation — not InteractiveMode's private UI/model path.
 */

export const DEFAULT_PLAN_FILE_URL = "local://PLAN.md"

export type OmpPlanModeState = {
  enabled: boolean
  planFilePath: string
  workflow?: "parallel" | "iterative"
  reentry?: boolean
  /** Tool set omp restores when its native review approves this bridged plan. */
  previousTools?: string[]
}

export type OmpPlanProposalHandler = (title: string) => Promise<unknown>

/** Minimal session surface the binder needs — satisfied by AgentSession. */
export type OmpPlanModeSession = {
  getPlanModeState(): OmpPlanModeState | undefined
  setPlanModeState(state: OmpPlanModeState | undefined): void
  sessionManager?: {
    getArtifactsDir?(): string | null
    getSessionId?(): string | null
  }
  setPlanProposalHandler?(handler: OmpPlanProposalHandler | null): void
  preparePlanForReview?(title: string): Promise<unknown>
  setPlanReferencePath?(path: string): void
  followUp?(
    text: string,
    images?: unknown[],
    options?: { synthetic?: boolean },
  ): void | Promise<void>
  sendPlanModeContext?(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>
  getEnabledToolNames?(): string[]
  setActiveToolsByName?(names: string[]): void | Promise<void>
  hasBuiltInTool?(name: string): boolean
  getToolByName?(name: string): { execute?: (...args: unknown[]) => Promise<unknown> } | undefined
  isStreaming?: boolean
}

export type OmpPlanModeHost = {
  getSession(): OmpPlanModeSession | undefined
  getPlanModeState(): OmpPlanModeState | undefined
  setPlanModeState(state: OmpPlanModeState | undefined): void
  sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>
  setPlanProposalHandler(handler: OmpPlanProposalHandler | null): void
  preparePlanForReview(title: string): Promise<unknown>
  getEnabledToolNames(): string[]
  setActiveToolsByName(names: string[]): Promise<void>
  hasBuiltInTool(name: string): boolean
  isStreaming(): boolean
}

type AgentRefLike = {
  id: string
  kind?: string
  session: OmpPlanModeSession | null
}

type AgentRegistryLike = {
  get(id: string): AgentRefLike | undefined
  list(): AgentRefLike[]
}

type AgentRegistryModule = {
  AgentRegistry?: { global(): AgentRegistryLike }
  MAIN_AGENT_ID?: string
}

export type ResolveOmpPlanModeHostOptions = {
  /** Soft-import target; defaults to `@oh-my-pi/pi-coding-agent`. */
  codingAgentPackage?: string
  /** Injected registry for unit tests — skips dynamic import. */
  registry?: AgentRegistryLike
  mainAgentId?: string
  /** omp's ExtensionAPI.pi self-reference, which owns the live singleton. */
  hostPi?: { AgentRegistry?: { global(): unknown }; MAIN_AGENT_ID?: string }
  /** Soft import used when `registry` is omitted. */
  importModule?: (specifier: string) => Promise<unknown>
  /**
   * Host CLI entry (`process.argv[1]`) used to resolve the coding-agent package
   * that owns the live `AgentRegistry` singleton. Tests may override.
   */
  hostCliEntry?: string
}

const DEFAULT_CODING_AGENT = "@oh-my-pi/pi-coding-agent"
const DEFAULT_MAIN_AGENT_ID = "Main"

/**
 * Walk up from a host CLI entry (e.g. `…/pi-coding-agent/dist/cli.js`) to the
 * package root whose `package.json` `name` matches `specifier`.
 */
export function findHostCodingAgentPackageRoot(
  hostCliEntry: string,
  specifier: string,
  fs: {
    existsSync: (path: string) => boolean
    readFileSync: (path: string, encoding: "utf8") => string
    realpathSync: (path: string) => string
  },
  path: {
    dirname: (path: string) => string
    join: (...parts: string[]) => string
  },
): string | undefined {
  let dir: string
  try {
    dir = path.dirname(fs.realpathSync(hostCliEntry))
  } catch {
    dir = path.dirname(hostCliEntry)
  }

  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json")
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string }
        if (pkg.name === specifier) return dir
      } catch {
        // ignore malformed package.json and keep walking
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Import the host's own coding-agent `AgentRegistry` module so
 * `AgentRegistry.global()` is the same singleton the running omp process
 * registered into.
 *
 * Bare `import("@oh-my-pi/pi-coding-agent")` from a checkout/plugin path fails
 * (coding-agent is not a pi-bridge dependency). `createRequire(cli).resolve`
 * also fails because the CLI cannot self-resolve its own package name. Walk
 * from `process.argv[1]` to the host package root and import
 * `src/registry/agent-registry.ts` by absolute file URL instead.
 */
export async function importHostCodingAgentModule(
  specifier: string,
  options: {
    hostCliEntry?: string
    importModule?: (id: string) => Promise<unknown>
  } = {},
): Promise<AgentRegistryModule | undefined> {
  const importModule = options.importModule ?? ((id: string) => import(id))
  const tried = new Set<string>()

  const tryImport = async (id: string): Promise<AgentRegistryModule | undefined> => {
    if (tried.has(id)) return undefined
    tried.add(id)
    try {
      return (await importModule(id)) as AgentRegistryModule
    } catch {
      return undefined
    }
  }

  const entry = options.hostCliEntry ?? process.argv[1]
  if (typeof entry === "string" && entry.length > 0) {
    try {
      const nodeFs = await import("node:fs")
      const path = await import("node:path")
      const { pathToFileURL } = await import("node:url")
      const fs = {
        existsSync: (p: string) => nodeFs.existsSync(p),
        readFileSync: (p: string, encoding: "utf8") => nodeFs.readFileSync(p, encoding),
        realpathSync: (p: string) => nodeFs.realpathSync(p),
      }
      const root = findHostCodingAgentPackageRoot(entry, specifier, fs, path)
      if (root) {
        // Prefer the registry module itself — that is the singleton omp uses.
        const registryPath = path.join(root, "src", "registry", "agent-registry.ts")
        const viaRegistry = await tryImport(pathToFileURL(registryPath).href)
        if (viaRegistry?.AgentRegistry?.global) return viaRegistry

        // Fall back to the package main (re-exports AgentRegistry).
        const viaIndex = await tryImport(pathToFileURL(path.join(root, "src", "index.ts")).href)
        if (viaIndex?.AgentRegistry?.global) return viaIndex
      }
    } catch {
      // Fall through to bare import.
    }
  }

  const bare = await tryImport(specifier)
  if (bare?.AgentRegistry?.global) return bare
  return undefined
}

function wrapSession(session: OmpPlanModeSession): OmpPlanModeHost {
  return {
    getSession: () => session,
    getPlanModeState: () => session.getPlanModeState(),
    setPlanModeState: state => session.setPlanModeState(state),
    sendPlanModeContext: async options => {
      await session.sendPlanModeContext?.(options)
    },
    setPlanProposalHandler: handler => {
      session.setPlanProposalHandler?.(handler)
    },
    preparePlanForReview: async title => {
      if (!session.preparePlanForReview) {
        throw new Error("omp plan mode: preparePlanForReview is not available on the live session")
      }
      return session.preparePlanForReview(title)
    },
    getEnabledToolNames: () => session.getEnabledToolNames?.() ?? [],
    setActiveToolsByName: async names => {
      await session.setActiveToolsByName?.(names)
    },
    hasBuiltInTool: name => session.hasBuiltInTool?.(name) ?? false,
    isStreaming: () => session.isStreaming === true,
  }
}

function sessionFromRegistry(registry: AgentRegistryLike, mainAgentId: string): OmpPlanModeSession | undefined {
  const main = registry.get(mainAgentId)?.session
  if (main) return main
  // Fall back to the first live main-kind (or any live) session — useful if the
  // registry id differs slightly across omp builds.
  for (const ref of registry.list()) {
    if (ref.session && (ref.kind === "main" || ref.id === mainAgentId)) return ref.session
  }
  for (const ref of registry.list()) {
    if (ref.session) return ref.session
  }
  return undefined
}

/**
 * Resolve an omp plan-mode host from `AgentRegistry.global()`, or return
 * `undefined` when the coding-agent package / registry / live session is absent
 * (plain pi, tests without a fake, or pre-session extension load).
 */
export async function bindOmpPlanModeHost(
  options: ResolveOmpPlanModeHostOptions = {},
): Promise<OmpPlanModeHost | undefined> {
  let mainAgentId = options.mainAgentId ?? DEFAULT_MAIN_AGENT_ID
  let registry = options.registry

  if (!registry && options.hostPi?.AgentRegistry?.global) {
    registry = options.hostPi.AgentRegistry.global() as AgentRegistryLike
    if (typeof options.hostPi.MAIN_AGENT_ID === "string" && !options.mainAgentId) {
      mainAgentId = options.hostPi.MAIN_AGENT_ID
    }
  }

  if (!registry) {
    const specifier = options.codingAgentPackage ?? DEFAULT_CODING_AGENT
    const mod = await importHostCodingAgentModule(specifier, {
      hostCliEntry: options.hostCliEntry,
      importModule: options.importModule,
    })
    if (!mod?.AgentRegistry?.global) return undefined
    registry = mod.AgentRegistry.global()
    if (typeof mod.MAIN_AGENT_ID === "string" && !options.mainAgentId) {
      // Prefer the package's own constant when present.
      return bindOmpPlanModeHost({ ...options, registry, mainAgentId: mod.MAIN_AGENT_ID })
    }
  }

  const session = sessionFromRegistry(registry, mainAgentId)
  if (!session) return undefined
  return wrapSession(session)
}

/** Wrap an already-held session (unit tests / injected hosts). */
export function bindOmpPlanModeHostFromSession(session: OmpPlanModeSession): OmpPlanModeHost {
  return wrapSession(session)
}

export type PlanModeToolResult = {
  content: Array<{ type: "text"; text: string }>
  details: {
    action: "plan_enter" | "plan_exit"
    already?: boolean
    planFilePath?: string
  }
}

/** Mutable binder state for write-tool restore across enter/exit. */
export type PlanModeBinderState = {
  previousTools?: string[]
  hasEntered: boolean
}

export function createPlanModeBinderState(): PlanModeBinderState {
  return { hasEntered: false }
}

/**
 * ACP-shaped enter: enable plan mode, install `preparePlanForReview` as the
 * proposal handler, and optionally activate built-in `write`.
 *
 * Do not inject omp's native plan context here. This bridge is invoked as an
 * OpenCode tool while the provider's Run is held for a Cursor InteractionQuery;
 * steering a custom message at this point starts a fresh provider Run before the
 * bridged tool result can be delivered, superseding the held Run and replaying
 * the original SwitchMode request. The Cursor provider adds its own mode
 * reminder after the approved continuation, so the native context is redundant
 * for this path.
 */
export async function enterOmpPlanMode(
  host: OmpPlanModeHost,
  state: PlanModeBinderState = createPlanModeBinderState(),
): Promise<PlanModeToolResult> {
  const previous = host.getPlanModeState()
  if (previous?.enabled) {
    const currentTools = host.getEnabledToolNames()
    if (currentTools.includes("plan_enter")) {
      const planModeTools = currentTools.filter(name => name !== "plan_enter")
      state.previousTools = currentTools
      host.setPlanModeState({ ...previous, previousTools: currentTools })
      await host.setActiveToolsByName(planModeTools)
    }
    return {
      content: [{ type: "text", text: "Already in plan mode." }],
      details: { action: "plan_enter", already: true, planFilePath: previous.planFilePath },
    }
  }

  const previousTools = host.getEnabledToolNames()
  const augmentations: string[] = []
  if (host.hasBuiltInTool("write")) augmentations.push("write")

  // `plan_enter` is a bridge-only tool used to satisfy Cursor's SwitchMode
  // request. Once native omp plan mode is enabled, leaving it active gives
  // omp's plan-mode enforcement another arbitrary "required" tool to choose;
  // the model then calls plan_enter again instead of the intended ask/write
  // decision tool. Native omp plan mode does not expose a plan-enter tool, so
  // mirror that active set while retaining plan_exit for Cursor's next switch.
  const planModeTools = previousTools.filter(name => name !== "plan_enter")
  const nextTools = [...new Set([...planModeTools, ...augmentations])]
  if (nextTools.length !== previousTools.length || nextTools.some((name, i) => name !== previousTools[i])) {
    state.previousTools = previousTools
    await host.setActiveToolsByName(nextTools)
  }

  const planFilePath = previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL
  host.setPlanModeState({
    enabled: true,
    planFilePath,
    workflow: previous?.workflow ?? "parallel",
    reentry: previous !== undefined || state.hasEntered,
    previousTools,
  })
  host.setPlanProposalHandler(title => host.preparePlanForReview(title))

  state.hasEntered = true
  return {
    content: [{ type: "text", text: `Plan mode enabled. Plan file: ${planFilePath}` }],
    details: { action: "plan_enter", planFilePath },
  }
}

/** Clear proposal handler, restore prior tools, and drop plan-mode state. */
export async function exitOmpPlanMode(
  host: OmpPlanModeHost,
  state: PlanModeBinderState = createPlanModeBinderState(),
): Promise<PlanModeToolResult> {
  const previous = host.getPlanModeState()
  if (!previous?.enabled) {
    return {
      content: [{ type: "text", text: "Already out of plan mode." }],
      details: { action: "plan_exit", already: true },
    }
  }

  host.setPlanProposalHandler(null)
  host.setPlanModeState(undefined)

  if (state.previousTools !== undefined) {
    await host.setActiveToolsByName(state.previousTools)
    state.previousTools = undefined
  }

  return {
    content: [{ type: "text", text: "Plan mode disabled." }],
    details: { action: "plan_exit" },
  }
}
