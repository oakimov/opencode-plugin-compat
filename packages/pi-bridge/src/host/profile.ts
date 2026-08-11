/**
 * Pi-family host profiles. Two hosts share a common ancestor (oh-my-pi is a
 * fork of Pi), so their provider-registration surfaces are structurally alike
 * but not identical. Following OCP's own principle for OpenCode forks, host
 * variance lives here as **data** plus narrow dispatch — never a forked
 * package per host.
 *
 * Every delta below was read from host source, not inferred:
 *   • oh-my-pi 17.2.12 — packages/coding-agent/src/config/model-registry.ts,
 *     packages/coding-agent/src/extensibility/extensions/types.ts
 *   • pi (earendil-works) 0.84.1 — packages/coding-agent/src/core/provider-composer.ts,
 *     packages/ai/src/models.ts
 */

export type PiHostId = "omp" | "pi"

export type PiHostProfile = {
  id: PiHostId
  /** Display name for diagnostics. */
  name: string
  /** Package scope providing Context/AssistantMessageEvent/event-stream. */
  aiPackage: string
  /** Package providing ExtensionAPI (types only; never imported at runtime). */
  codingAgentPackage: string
  capabilities: {
    /**
     * How a provider supplies a dynamic model list.
     *   omp: `fetchDynamicModels(apiKey) => Promise<ProviderModelConfig[]>`
     *   pi:  `refreshModels(ctx: RefreshModelsContext) => Promise<models>`
     *        — transactional; ctx carries credential/stored/publish/signal.
     */
    dynamicModels: "fetchDynamicModels" | "refreshModels"
    /** Fields Pi's own `ProviderConfig.oauth` marks required (we always supply both regardless). */
    oauthRequires: readonly ("refreshToken" | "getApiKey")[]
    /** `oauth.refreshToken` receives an AbortSignal second arg. */
    oauthRefreshTakesSignal: boolean
    /**
     * `apiKey` string is a template mini-language (`$VAR` env reference,
     * `!cmd` shell-command) rather than a bare env-var name / literal.
     * pi: resolve-config-value.ts `parseConfigValueReference`.
     */
    apiKeyTemplateSyntax: boolean
    /** `done` event accepts a `deferred` reason (pi only). Emitter never uses it; recorded for parity checks. */
    deferredStopReason: boolean
    /** `image_end` event exists (omp only). Emitter never uses it; recorded for parity checks. */
    imageEndEvent: boolean
  }
  /** Wire-protocol ids already taken by the host; a custom `api` must not collide. */
  reservedApis: readonly string[]
  /**
   * Provider ids the host already ships natively. An OpenCode plugin declares
   * its own provider id (e.g. `cursor-opencode-provider` says `"cursor"`),
   * which can collide with a host built-in of the same name — and
   * `registerProvider` has no collision guard, so the plugin would silently
   * shadow the host's own provider. Colliding ids get suffixed instead.
   */
  reservedProviderIds: readonly string[]
}

/** Built-in oh-my-pi wire-protocol ids (17.2.12, `packages/catalog/src/types.ts` `KnownApi`). */
const OMP_RESERVED_APIS = [
  "openai-completions",
  "openai-responses",
  "openrouter",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "ollama-chat",
  "cursor-agent",
  "gitlab-duo-agent",
  "devin-agent",
] as const

/**
 * pi's built-in api ids. Narrower than omp's (omp added several provider
 * integrations after the fork). Kept as a superset-safe list: reserving a few
 * extra names only costs a clearer error message on collision.
 */
const PI_RESERVED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "ollama-chat",
] as const

/**
 * Native provider ids likely to collide with a plugin's own declared id.
 * Not exhaustive (both hosts ship long provider catalogs that change): this is
 * a safety net for the common cases, and an explicit `providerName` always
 * wins. oh-my-pi's `"cursor"` is the motivating case — verified in
 * `packages/catalog/src/provider-models/descriptors.ts`.
 */
const COMMON_RESERVED_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "ollama",
  "cursor",
  "github-copilot",
] as const

export function ompProfile(): PiHostProfile {
  return {
    id: "omp",
    name: "oh-my-pi (omp)",
    aiPackage: "@oh-my-pi/pi-ai",
    codingAgentPackage: "@oh-my-pi/pi-coding-agent",
    capabilities: {
      dynamicModels: "fetchDynamicModels",
      oauthRequires: [],
      oauthRefreshTakesSignal: false,
      apiKeyTemplateSyntax: false,
      deferredStopReason: false,
      imageEndEvent: true,
    },
    reservedApis: OMP_RESERVED_APIS,
    reservedProviderIds: COMMON_RESERVED_PROVIDER_IDS,
  }
}

export function piProfile(): PiHostProfile {
  return {
    id: "pi",
    name: "pi (earendil-works)",
    aiPackage: "@earendil-works/pi-ai",
    codingAgentPackage: "@earendil-works/pi-coding-agent",
    capabilities: {
      dynamicModels: "refreshModels",
      oauthRequires: ["refreshToken", "getApiKey"],
      oauthRefreshTakesSignal: true,
      apiKeyTemplateSyntax: true,
      deferredStopReason: true,
      imageEndEvent: false,
    },
    reservedApis: PI_RESERVED_APIS,
    reservedProviderIds: COMMON_RESERVED_PROVIDER_IDS,
  }
}

export const PI_HOST_PROFILES: Record<PiHostId, () => PiHostProfile> = {
  omp: ompProfile,
  pi: piProfile,
}

export function profileFor(id: PiHostId): PiHostProfile {
  return PI_HOST_PROFILES[id]()
}

/**
 * Pick a provider id that will not shadow one of the host's own providers.
 * Returns the id unchanged when there's no clash.
 */
export function avoidProviderIdCollision(providerId: string, profile: PiHostProfile, suffix = "-opencode"): string {
  return profile.reservedProviderIds.includes(providerId) ? `${providerId}${suffix}` : providerId
}

/**
 * Render an `apiKey` config value for the host. omp takes a bare env-var name;
 * pi takes a `$VAR` template reference. Values that already carry the host's
 * own syntax (or a literal secret) pass through untouched.
 */
export function renderApiKeyRef(envVarName: string, profile: PiHostProfile): string {
  if (!profile.capabilities.apiKeyTemplateSyntax) return envVarName
  if (envVarName.startsWith("$") || envVarName.startsWith("!")) return envVarName
  return /^[A-Z0-9_]+$/.test(envVarName) ? `$${envVarName}` : envVarName
}
