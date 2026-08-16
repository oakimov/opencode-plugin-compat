/** OCP host identifiers — see docs/ocp/0.1.md §5 */
export type HostId = "opencode" | "mimo" | "kilo" | "zcode" | "unknown"

export type HostCapabilities = {
  classicHooks: boolean
  /** Exports AND host wiring for Promise v2 */
  promiseV2: boolean
  effectV2: boolean
  aisdkProviderHooks: boolean
  localPluginScan: boolean
  scansDotOpencode: boolean
  /**
   * Host SessionProcessor lazily creates tool parts on bare `tool-call`
   * (OpenCode / Kilo `ensureToolCall`). When false (MiMo), OCP must emit
   * `tool-input-start` before `tool-call` for custom LanguageModel streams.
   */
  streamToolCallEnsure: boolean
  /**
   * Host `bash` tool schema requires a string `description`. When true (MiMo),
   * OCP may fill a missing description on bash tool-call inputs only.
   */
  bashDescriptionRequired: boolean
  /** ZCode marketplace ABI — not OCP */
  marketplacePlugins?: boolean
}

export type HostPaths = {
  configDir: string
  dataDir: string
  cacheDir: string
  /** Project dirs the host actually scans today */
  projectDirs: string[]
  /** Recommended compat project dirs for matrix/doctor (e.g. `.opencode`) */
  compatProjectDirs?: string[]
  /** npm plugin install cache, when distinct from cacheDir */
  pluginInstallDir?: string
  /** Absolute home root when the host uses a non-XDG layout (ZCode) */
  home?: string
}

/**
 * Host builtin tool identities, keyed by role rather than by name.
 *
 * Forks rotate builtin names while keeping the vocabulary: MiMo moved
 * OpenCode's subagent spawner from `task` to `actor`, then reused the freed
 * `task` name for its work-item tracker (OpenCode's `todowrite`/`todoread`).
 * A consumer that hardcodes `"task"` therefore means "spawn a subagent" on
 * OpenCode/Kilo and "record a todo" on MiMo — silently, with no type error.
 *
 * Resolve by role; never by literal name.
 */
export type HostToolRoles = {
  /** Spawns a subagent. Default `task`; MiMo: `actor`. */
  subagent: string
  /** Records work items / todos. Default `todowrite`; MiMo: `task`. */
  todoWrite: string
  /** Reads work items / todos. Default `todoread`; MiMo: `task`. */
  todoRead: string
  /**
   * Interactive multi-choice prompt. Default `question`.
   * Pi-family omp advertises this role as `ask` (translated in pi-bridge, not
   * via HostToolRoles — HostId does not include pi/omp).
   */
  question: string
  /** Enter plan mode. Default `plan_enter`. Absent on many forks until advertised. */
  planEnter: string
  /** Exit plan mode / return to build. Default `plan_exit`. */
  planExit: string
}

export type HostHooks = {
  /** Portable classic hooks implemented (or accepted via facade) */
  core: readonly string[]
  /** Core hooks absent on this host (compat gaps) */
  missing: readonly string[]
  /** Host-only hooks — never required for portable plugins */
  extensions: readonly string[]
}

/**
 * Host HTTP location headers used by native SDK client factories.
 *
 * Unmodified OpenCode plugins may construct `@opencode-ai/sdk/v2/client` and
 * set `x-opencode-directory`. OCP’s facade-sdk must rewrite to the host’s
 * header names so `/api/*` LocationMiddleware accepts the request.
 */
export type HostHttp = {
  /** Directory header (value is typically URL-encoded). */
  directoryHeader: string
  /** Experimental workspace header. */
  workspaceHeader: string
}

export type HostProfile = {
  id: HostId
  /** OCP semver this profile targets, or `"none"` for T0 hosts */
  ocpVersion: string
  nativePlugin: string
  nativeSdk: string
  /** Observed native plugin package version at research time */
  pluginVersionObserved?: string
  upstreamPin?: string
  paths: HostPaths
  configFiles: readonly string[]
  /** Env prefix without trailing underscore, e.g. `OPENCODE` */
  envPrefix: string
  /** Location headers for SDK client bridging (facade-sdk). */
  http: HostHttp
  capabilities: HostCapabilities
  hooks: HostHooks
  /**
   * Sparse override for hosts that rotated builtin names. Omit entirely when
   * the host matches upstream OpenCode — `toolRolesOf()` supplies the defaults.
   * Advisory: consumers must intersect the result with the tools the host
   * actually advertises at runtime, since a user may disable a builtin.
   */
  tools?: Partial<HostToolRoles>
  agents?: { builtins: string[]; aliases?: Record<string, string> }
  /** Free-form research notes */
  note?: string
}

export type DetectSource =
  | "env"
  | "binary"
  | "package"
  | "config"
  | "fallback"

export type DetectResult = {
  id: HostId
  profile: HostProfile
  source: DetectSource
  /**
   * Whether OCP plugin load is allowed.
   * `false` for `zcode` (T0) and `unknown`.
   */
  supported: boolean
  /** Doctor / refusal text when `supported` is false */
  message?: string
}

export type DetectOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  argv?: readonly string[]
  execPath?: string
  /** Injectable for tests */
  existsSync?: (path: string) => boolean
  /**
   * Injectable package-presence probe (e.g. try resolve native plugin).
   * Return the HostId when a native package is detectable.
   */
  resolveNative?: () => HostId | undefined
}