/**
 * @opencode-compat/profile — HostProfile types, drafts, and detect().
 * Contract: docs/ocp/0.1.md §5
 */
export const PKG = "@opencode-compat/profile" as const
export { VERSION, OCP_VERSION } from "./version"

export type {
  DetectOptions,
  DetectResult,
  DetectSource,
  HostCapabilities,
  HostHooks,
  HostHttp,
  HostId,
  HostPaths,
  HostProfile,
  HostToolRoles,
} from "./types"

export {
  DEFAULT_TOOL_ROLES,
  resolveToolRole,
  toolRolesOf,
} from "./tool-roles"

export {
  CORE_HOOKS,
  MIMO_EXTENSION_HOOKS,
  MIMO_MISSING_HOOKS,
  type CoreHook,
} from "./hooks"

export { expandHome, resolveXdgDirs } from "./paths"

export {
  DRAFTS,
  kiloProfile,
  mimoProfile,
  opencodeProfile,
  unknownProfile,
  zcodeProfile,
  type DraftOptions,
} from "./drafts"

export { detect } from "./detect"

export {
  facadeOverrides,
  facadeOverrideSnippet,
  formatProfileSummary,
  privacyGuideHint,
  profileSummaryLines,
  projectPluginCandidates,
  unknownDoctorMessage,
  zcodeDoctorMessage,
} from "./doctor"