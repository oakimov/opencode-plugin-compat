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

export type PiCoordinationToolProfile = {
  /** Host-native coordination tool name. */
  name: string
  /** Provider-emitted argument name → host argument name. */
  inputAliases?: Readonly<Record<string, string>>
}

export type PiSubagentToolProfile = {
  /** Tool name the host advertises when its subagent executor is active. */
  name: string
  /**
   * OpenCode agent type → host agent type. `null` means omit the field and let
   * the host apply its session-specific default spawn policy.
   */
  agentAliases: Readonly<Record<string, string | null>>
  /** Built-in coordination tool used for status and follow-up, when present. */
  coordinationTool?: PiCoordinationToolProfile
  /**
   * Host argument that disables an agent definition's structured-output
   * contract. OpenCode's canonical task result is unstructured text.
   */
  unstructuredOutput?: { field: string; value: unknown }
}

export type PiTerminalResultToolProfile = {
  /** Tool name a host subagent must call to submit its terminal result. */
  name: string
  /** Arguments that submit the current assistant text as the result. */
  input: Readonly<Record<string, unknown>>
}

export type PiToolInputProfile = {
  /** Provider-emitted argument name -> host argument name. */
  inputAliases: Readonly<Record<string, string>>
}

/**
 * OpenCode plugins emit camelCase tool args (`filePath`, `oldString`, `workdir`).
 * Pi-family hosts validate against `path`/`cwd`/snake_case schemas and drop
 * unrecognized keys when more than one string field is required -- so a write
 * of `{ filePath, content }` arrives as `{ content }` and fails. Activated only
 * when the named tool is live in the current catalog.
 *
 * The hosts' own schemas diverge here, so each gets its own map rather than a
 * shared one. omp 17.2.12: tools/{write,read,bash}.ts, edit/modes/replace.ts.
 */
const OMP_ESSENTIAL_TOOL_INPUTS: Readonly<Record<string, PiToolInputProfile>> = {
  read: { inputAliases: { filePath: "path", file_path: "path" } },
  write: { inputAliases: { filePath: "path", file_path: "path" } },
  edit: {
    inputAliases: {
      filePath: "path",
      file_path: "path",
      oldString: "old_string",
      newString: "new_string",
      replaceAll: "replace_all",
    },
  },
  bash: { inputAliases: { workdir: "cwd", working_directory: "cwd" } },
}

/**
 * pi 0.84.1 (`core/tools/{read,write,edit,bash}.ts`) is narrower than omp:
 * `bash` accepts only `{command, timeout}` with no working-directory argument,
 * and `edit` is `{path, edits: [{oldText, …}]}` rather than flat replacement
 * fields. A nested batch shape cannot be produced by renaming keys, so `edit`
 * carries only its verified `path` rename and `bash` is left alone instead of
 * being aliased onto arguments that host does not define.
 */
const PI_ESSENTIAL_TOOL_INPUTS: Readonly<Record<string, PiToolInputProfile>> = {
  read: { inputAliases: { filePath: "path", file_path: "path" } },
  write: { inputAliases: { filePath: "path", file_path: "path" } },
  edit: { inputAliases: { filePath: "path", file_path: "path" } },
}

export type PiHostProfile = {
  id: PiHostId
  /** Display name for diagnostics. */
  name: string
  /** Package scope providing Context/AssistantMessageEvent/event-stream. */
  aiPackage: string
  /** Package providing ExtensionAPI (types only; never imported at runtime). */
  codingAgentPackage: string
  tools?: {
    /**
     * Pi-family subagents do not use OpenCode's `task` wire schema. The bridge
     * activates this mapping only when the named tool is advertised live.
     */
    subagent?: PiSubagentToolProfile
    /**
     * Some hosts require a terminal tool call instead of accepting a normal
     * assistant stop. The bridge activates this only when the tool is live.
     */
    terminalResult?: PiTerminalResultToolProfile
    /**
     * Strict host-tool argument aliases keyed by live tool name. Used for
     * OpenCode camelCase → Pi-family path/cwd/snake_case remaps.
     */
    toolInputs?: Readonly<Record<string, PiToolInputProfile>>
  }
  messages?: {
    /**
     * OMP renders async job delivery as an agent-attributed developer message.
     * Only messages matching this envelope become provider-facing user turns;
     * other developer messages retain developer/system priority.
     */
    agentDeveloperWake?: {
      startsWith: string
      includes: readonly string[]
    }
  }
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
    tools: {
      subagent: {
        name: "task",
        // omp's generic worker follows the live session spawn policy; its
        // bundled read-only equivalent of OpenCode's `explore` is `scout`.
        agentAliases: { general: null, explore: "scout" },
        coordinationTool: {
          name: "hub",
          // OpenCode-oriented models commonly say `action`; OMP's strict hub
          // schema calls the discriminator `op`.
          inputAliases: { action: "op" },
        },
        // OMP's scout/reviewer definitions impose structured schemas, while
        // OpenCode's task contract returns plain text to the parent.
        unstructuredOutput: { field: "outputSchema", value: true },
      },
      // OMP subagents do not settle on a plain assistant response. `yield`
      // with an empty typed result tells the host to use that response text.
      terminalResult: { name: "yield", input: { type: "result", result: {} } },
      toolInputs: OMP_ESSENTIAL_TOOL_INPUTS,
    },
    messages: {
      agentDeveloperWake: {
        startsWith: "<system-notice>",
        includes: ["background job", "resume your work using"],
      },
    },
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
    tools: {
      subagent: {
        name: "subagent",
        // These are the reference extension's bundled sample agent names. A
        // user-defined name not present here still passes through unchanged.
        agentAliases: { general: "worker", explore: "scout" },
      },
      toolInputs: PI_ESSENTIAL_TOOL_INPUTS,
    },
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
