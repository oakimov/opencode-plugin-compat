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
  /** ZCode marketplace ABI — not OCP */
  marketplacePlugins?: boolean
}

export type HostPaths = {
  configDir: string
  dataDir: string
  cacheDir: string
  /** Project dirs the host actually scans today */
  projectDirs: string[]
  /** Recommended compat project dirs for matrix/doctor (e.g. `.opencode`); not an upstream dual-scan PR */
  compatProjectDirs?: string[]
  /** npm plugin install cache, when distinct from cacheDir */
  pluginInstallDir?: string
  /** Absolute home root when the host uses a non-XDG layout (ZCode) */
  home?: string
}

export type HostHooks = {
  /** Portable classic hooks implemented (or accepted via facade) */
  core: readonly string[]
  /** Core hooks absent on this host (compat gaps) */
  missing: readonly string[]
  /** Host-only hooks — never required for portable plugins */
  extensions: readonly string[]
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
  capabilities: HostCapabilities
  hooks: HostHooks
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
