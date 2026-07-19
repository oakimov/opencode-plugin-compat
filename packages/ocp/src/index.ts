/**
 * @opencode-compat/ocp — user-facing umbrella for the OCP bridge.
 *
 * Install this package, run `ocp setup`, then add consumer plugins via host
 * config. Bridge packages remain implementation detail / transitive deps.
 */
export const PKG = "@opencode-compat/ocp" as const
export const VERSION = "0.1.0" as const

export {
  doctor,
  main,
  mainAsync,
  matrix,
  setup,
  parseSetupArgs,
  type DoctorResult,
  type MatrixCell,
  type MatrixCliOptions,
  type SetupOptions,
  type SetupResult,
} from "@opencode-compat/cli"

export {
  detect,
  facadeOverrides,
  facadeOverrideSnippet,
  type DetectOptions,
  type DetectResult,
  type HostId,
  type HostProfile,
} from "@opencode-compat/profile"

export {
  createPromiseV2Host,
  definePromisePlugin,
  runPromisePlugin,
  wirePromiseV2,
  type LanguageModelInput,
  type LanguageModelV3Like,
  type PluginContext,
  type PromiseV2Host,
  type PromiseV2Plugin,
} from "@opencode-compat/adapter"