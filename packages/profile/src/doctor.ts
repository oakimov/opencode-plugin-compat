import { join } from "node:path"

/** T0 doctor copy for ZCode — marketplace ABI ≠ OCP. */
export function zcodeDoctorMessage(): string {
  return [
    "OCP: host detected as zcode (T0).",
    "ZCode Agent Mode marketplace (.zcode-plugin / Claude-/Codex-style hooks) is not the OpenCode npm plugin ABI (@opencode-ai/plugin).",
    "External OpenCode agent tiles that spawn the OpenCode CLI are also not OCP plugin compatibility.",
    "Public marketplace examples (glm-hammer, zcode-glm-fleet) use .zcode-plugin/plugin.json — a different protocol.",
    "Until Z.AI ships an OpenCode-plugin loader, OCP will not load plugins on this host.",
    "Companion (not OCP): pack plugin-package skills/commands/manifests with `compat migrate-zcode` (does not migrate host MCP; see docs/plans/zcode-asset-migrator-plan.md).",
  ].join(" ")
}

/** Doctor copy when no cooperating host can be identified. */
export function unknownDoctorMessage(): string {
  return [
    "OCP: could not detect a cooperating host (opencode, mimo, or kilo).",
    "Set OPENCODE_COMPAT_HOST=opencode|mimo|kilo to force detection,",
    "or run inside a supported CLI so binary/config heuristics can resolve the host.",
    "ZCode is T0 only — see docs/ocp/0.1.md §9.",
  ].join(" ")
}

/**
 * Optional companion privacy pointer for doctor output.
 * Docs only — OCP never mutates telemetry env/config/firewall.
 */
export function privacyGuideHint(hostId: string): string | undefined {
  switch (hostId) {
    case "kilo":
      return "privacy: Kilo PostHog opt-out — docs/guides/kilocode-telemetry-disable.md (not an OCP kill)"
    case "mimo":
      return "privacy: MiMo analysis opt-out — docs/guides/mimocode-telemetry-disable.md (MIMOCODE_ENABLE_ANALYSIS=false; not an OCP kill)"
    case "zcode":
      return "privacy: ZCode telemetry is docs-only firewall/DNS — docs/guides/zcode-telemetry-block.md (no in-app opt-out; not an OCP kill)"
    default:
      return undefined
  }
}

/** Short capability summary for CLI doctor. */
export function profileSummaryLines(profile: {
  id: string
  ocpVersion: string
  nativePlugin: string
  envPrefix: string
  capabilities: {
    classicHooks: boolean
    promiseV2: boolean
    effectV2: boolean
    aisdkProviderHooks: boolean
    scansDotOpencode: boolean
    marketplacePlugins?: boolean
  }
  hooks: { missing: readonly string[]; extensions: readonly string[] }
  paths: {
    configDir: string
    projectDirs: string[]
    compatProjectDirs?: string[]
  }
}): string[] {
  const caps = profile.capabilities
  return [
    `host: ${profile.id}`,
    `ocp: ${profile.ocpVersion}`,
    `nativePlugin: ${profile.nativePlugin}`,
    `envPrefix: ${profile.envPrefix || "(none)"}`,
    `configDir: ${profile.paths.configDir}`,
    `projectDirs: ${profile.paths.projectDirs.join(", ") || "(none)"}`,
    profile.paths.compatProjectDirs?.length
      ? `compatProjectDirs: ${profile.paths.compatProjectDirs.join(", ")}`
      : undefined,
    `classicHooks: ${caps.classicHooks}`,
    `promiseV2: ${caps.promiseV2}`,
    `effectV2: ${caps.effectV2}`,
    `aisdkProviderHooks: ${caps.aisdkProviderHooks}`,
    `scansDotOpencode: ${caps.scansDotOpencode}`,
    caps.marketplacePlugins ? "marketplacePlugins: true" : undefined,
    profile.hooks.missing.length
      ? `hooks.missing: ${profile.hooks.missing.join(", ")}`
      : "hooks.missing: (none)",
    profile.hooks.extensions.length
      ? `hooks.extensions: ${profile.hooks.extensions.join(", ")}`
      : undefined,
  ].filter((line): line is string => line !== undefined)
}

/** Join summary lines for printing. */
export function formatProfileSummary(
  profile: Parameters<typeof profileSummaryLines>[0],
): string {
  return profileSummaryLines(profile).join("\n")
}

/** Suggested override map snippet for plugin install trees / operator overrides. */
export function facadeOverrideSnippet(version = "0.1.x"): string {
  return JSON.stringify(
    {
      "@opencode-ai/plugin": `npm:@opencode-compat/facade-plugin@${version}`,
      "@opencode-ai/sdk": `npm:@opencode-compat/facade-sdk@${version}`,
    },
    null,
    2,
  )
}

/** Resolve a project-relative plugin dir candidate list for a profile. */
export function projectPluginCandidates(
  profile: { paths: { projectDirs: string[]; compatProjectDirs?: string[] } },
  cwd: string,
): string[] {
  const dirs = [
    ...profile.paths.projectDirs,
    ...(profile.paths.compatProjectDirs ?? []),
  ]
  return [...new Set(dirs)].map((d) => join(cwd, d, "plugins"))
}