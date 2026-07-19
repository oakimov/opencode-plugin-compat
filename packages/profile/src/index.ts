/**
 * @opencode-compat/profile — HostProfile types, drafts, and detect().
 * Contract: docs/ocp/0.1.md §5
 */
export const PKG = "@opencode-compat/profile" as const
export const VERSION = "0.1.0" as const
export const OCP_VERSION = "0.1.0" as const

export type {
  DetectOptions,
  DetectResult,
  DetectSource,
  HostCapabilities,
  HostHooks,
  HostId,
  HostPaths,
  HostProfile,
} from "./types"

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
