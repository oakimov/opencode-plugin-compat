/**
 * @opencode-compat/profile — HostProfile types, drafts, and detect().
 * Contract: docs/ocp/0.1.md §5
 */
export const PKG = "@opencode-compat/profile" as const
export { VERSION, OCP_VERSION } from "./version.js"

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
} from "./types.js"

export {
  DEFAULT_TOOL_ROLES,
  resolveToolRole,
  toolRolesOf,
} from "./tool-roles.js"

export {
  CORE_HOOKS,
  MIMO_EXTENSION_HOOKS,
  MIMO_MISSING_HOOKS,
  type CoreHook,
} from "./hooks.js"

export { expandHome, resolveXdgDirs } from "./paths.js"

export {
  DRAFTS,
  kiloProfile,
  mimoProfile,
  opencodeProfile,
  unknownProfile,
  zcodeProfile,
  type DraftOptions,
} from "./drafts.js"

export { detect } from "./detect.js"

export {
  facadeOverrides,
  facadeOverrideSnippet,
  formatProfileSummary,
  privacyGuideHint,
  profileSummaryLines,
  projectPluginCandidates,
  unknownDoctorMessage,
  zcodeDoctorMessage,
} from "./doctor.js"