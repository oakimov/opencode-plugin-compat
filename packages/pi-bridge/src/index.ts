/**
 * `@opencode-compat/pi-bridge` — run unmodified OpenCode `aisdk`-type plugins
 * as providers on either Pi-family host (oh-my-pi / pi).
 *
 * Nothing here knows about any specific plugin: providers are discovered
 * through the conventions OpenCode already standardizes (an AI-SDK
 * `createXxx()` factory, plus the `auth` and `config` plugin hooks).
 */
export { registerOpenCodePlugin, type OpenCodePluginSpec, type RegisterResult } from "./register.js"
export { registerAiSdkProvider, type AiSdkProviderSpec } from "./bridge.js"
export { configSearchPaths, loadConfig, registerProvidersFromConfig, resolveConfigPath, type PiBridgeConfig } from "./config.js"
export { activateOpenCodeSearchTools } from "./extension.js"

// Host layer
export { detectPiHost, resetPiHostDetection, type PiHostDetection } from "./host/detect.js"
export { ompProfile, piProfile, profileFor, renderApiKeyRef, PI_HOST_PROFILES, type PiCoordinationToolProfile, type PiHostId, type PiHostProfile, type PiSubagentToolProfile, type PiToolInputProfile } from "./host/profile.js"
export { fallbackToolSchema, loadPiRuntime, resetPiRuntime, type PiRuntime } from "./host/runtime.js"

// OpenCode plugin surface
export {
  derivePackageName,
  detectAiSdkFactory,
  detectPluginFactory,
  instantiateHooks,
  loadOpenCodePluginModule,
  substituteApiKey,
  type AiSdkFactory,
  type AiSdkLikeProvider,
  type LoadedOpenCodePlugin,
} from "./opencode/load.js"
export { buildPiOAuth, createLoaderRunner, toOpenCodeAuth, toPiCredentials, tokenExpiryMs, type PiOAuthConfig, type PiOAuthCredentials } from "./opencode/auth.js"
export { createMemoryAuthStore, createPluginInputStub, type AuthStore, type PluginInputStub } from "./opencode/host-stub.js"
export { extractModelsFromConfigHook, toPiModel, type PiModelConfig } from "./opencode/models.js"
export type * from "./opencode/types.js"

// Translation
export { normalizeSystemPrompt, translateContextToPrompt, translateToolChoice, translateTools, type ToolSchemaFn } from "./translate/context.js"
export { emptyUsage, runV3StreamToPi } from "./translate/stream.js"
export {
  buildPiSubagentVocabulary,
  buildPiTerminalResultVocabulary,
  buildPiToolInputVocabulary,
  canonicalSubagentDescription,
  canonicalSubagentSchema,
  canonicalToolName,
  translateCanonicalSubagentCall,
  translateCanonicalToolCall,
  translateHostSubagentCall,
  translateHostToolCallInput,
  CANONICAL_SUBAGENT_TOOL,
  type PiSubagentVocabulary,
  type PiTerminalResultVocabulary,
  type PiToolInputVocabulary,
  type SubagentToolSchemaFn,
  type TranslatedSubagentCall,
} from "./translate/subagent.js"
export type * from "./pi-provider-types.js"
