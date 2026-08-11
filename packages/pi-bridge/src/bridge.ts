/**
 * Generic AI-SDK V3 → Pi-family provider bridge. Registers a `streamSimple`
 * against the host's custom-api registry (`pi.registerProvider`), which rides
 * the generic append-to-history tool loop — one `streamSimple` call per model
 * turn, tool results arriving as trailing `role:"toolResult"` history entries
 * on the next call. Verified against oh-my-pi 17.2.12
 * (`packages/coding-agent/src/.../agent-loop.ts`).
 *
 * This is a different shape from the in-stream exec-handler path some built-in
 * providers use (e.g. omp's native `cursor-agent` api, which holds one stream
 * open and drives tools in-band). That path is reserved for built-in apis and
 * is not available to custom providers on either host.
 *
 * Host differences (package scope, dynamic-model calling convention, required
 * oauth fields) come from {@link PiHostProfile} — see `host/profile.ts`.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { loadPiRuntime, type PiRuntime } from "./host/runtime.js"
import { renderApiKeyRef, type PiHostProfile } from "./host/profile.js"
import type { PiOAuthConfig } from "./opencode/auth.js"
import type { PiModelConfig } from "./opencode/models.js"
import { translateContextToPrompt, translateToolChoice, translateTools } from "./translate/context.js"
import { emptyUsage, runV3StreamToPi } from "./translate/stream.js"
import { buildPiSubagentVocabulary, buildPiTerminalResultVocabulary, buildPiToolInputVocabulary } from "./translate/subagent.js"
import type { PiContextLike, PiExtensionApi, PiModelLike, PiSimpleStreamOptions } from "./pi-provider-types.js"

export interface AiSdkProviderSpec {
  /** Provider id passed to `pi.registerProvider` (also `model.provider`). */
  name: string
  /** Custom wire-protocol id registered in the host's api registry. */
  api: string
  /** Required by both hosts whenever models are populated; never used for network calls by a custom provider. */
  baseUrl: string
  /** Resolve the underlying AI-SDK `LanguageModelV3` for a model id. */
  getLanguageModel: (modelId: string, apiKey: string | undefined) => LanguageModelV3 | Promise<LanguageModelV3>
  /** Final adjustment of the V3 call options before `doStream`. */
  buildCallOptions?: (args: {
    model: PiModelLike
    context: PiContextLike
    options: PiSimpleStreamOptions | undefined
    base: LanguageModelV3CallOptions
  }) => LanguageModelV3CallOptions | Promise<LanguageModelV3CallOptions>
  models?: readonly PiModelConfig[]
  /** Host-neutral dynamic model list; adapted to each host's calling convention below. */
  fetchModels?: (apiKey: string | undefined) => Promise<readonly PiModelConfig[]>
  oauth?: PiOAuthConfig
  headers?: Record<string, string>
  apiKey?: string
  authHeader?: boolean
}

async function resolveApiKey(apiKey: unknown, signal: AbortSignal | undefined): Promise<string | undefined> {
  if (apiKey === undefined || apiKey === null) return undefined
  if (typeof apiKey === "function") return (apiKey as (s?: AbortSignal) => Promise<string>)(signal)
  return String(apiKey)
}

const SESSION_AFFINITY_HEADERS = new Set(["x-session-id", "x-session-affinity", "x-opencode-session"])

/**
 * Preserve the Pi host's provider-session identity on the AI-SDK call.
 * OpenCode providers commonly use one of these headers to retain opaque
 * conversation/checkpoint state across tool loops and asynchronous wake-ups.
 */
export function aiSdkHeadersFromPi(options: PiSimpleStreamOptions | undefined): Record<string, string> | undefined {
  const headers = options?.headers ? { ...options.headers } : {}
  const hasExplicitAffinity = Object.keys(headers).some(name => SESSION_AFFINITY_HEADERS.has(name.toLowerCase()))
  // Use OCP's namespaced header by default. It is understood by cooperating
  // OpenCode providers and is less likely than the generic x-session-id to be
  // forwarded to an unrelated upstream API with provider-specific semantics.
  if (!hasExplicitAffinity && options?.sessionId) headers["x-opencode-session"] = options.sessionId
  return Object.keys(headers).length > 0 ? headers : undefined
}

function errorAssistantMessage(model: PiModelLike, err: unknown) {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "error" as const,
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  }
}

function buildStreamSimple(spec: AiSdkProviderSpec, runtime: PiRuntime) {
  return (model: PiModelLike, context: PiContextLike, options?: PiSimpleStreamOptions) => {
    const piStream = runtime.createAssistantMessageEventStream()
    void (async () => {
      try {
        const apiKey = await resolveApiKey(options?.apiKey, options?.signal)
        const lm = await spec.getLanguageModel(model.id, apiKey)
        const vocabulary = buildPiSubagentVocabulary(context.tools, runtime.toolSchema, runtime.profile)
        const toolInputs = buildPiToolInputVocabulary(context.tools, runtime.profile)
        const terminalResult = buildPiTerminalResultVocabulary(context.tools, runtime.profile)
        const base: LanguageModelV3CallOptions = {
          prompt: translateContextToPrompt(context, vocabulary, runtime.profile),
          tools: translateTools(context.tools, runtime.toolSchema, vocabulary),
          toolChoice: translateToolChoice(options?.toolChoice, vocabulary),
          abortSignal: options?.signal,
          headers: aiSdkHeadersFromPi(options),
        }
        const callOptions = spec.buildCallOptions ? await spec.buildCallOptions({ model, context, options, base }) : base
        const result = await lm.doStream(callOptions)
        await runV3StreamToPi({ model, v3Stream: result.stream, piStream, vocabulary, toolInputs, terminalResult })
      } catch (err) {
        const message = errorAssistantMessage(model, err)
        piStream.push({ type: "start", partial: message })
        piStream.push({ type: "error", reason: "error", error: message })
      }
    })()
    return piStream
  }
}

/**
 * Adapt a host-neutral `fetchModels(apiKey)` to the host's own convention:
 *   • omp — `fetchDynamicModels(apiKey)` returns the list directly.
 *   • pi  — `refreshModels(ctx)` is transactional: the credential arrives on
 *     `ctx.credential`, and the result is published rather than returned.
 * Failures are non-fatal on both: a provider that can't list models right now
 * (usually: not logged in yet) must still register.
 */
function buildDynamicModels(spec: AiSdkProviderSpec, profile: PiHostProfile): Record<string, unknown> {
  const fetchModels = spec.fetchModels
  if (!fetchModels) return {}

  const safeFetch = async (apiKey: string | undefined): Promise<readonly PiModelConfig[]> => {
    try {
      return await fetchModels(apiKey)
    } catch (err) {
      console.error(`pi-bridge: model list failed for provider "${spec.name}" — ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  if (profile.capabilities.dynamicModels === "fetchDynamicModels") {
    return { fetchDynamicModels: (apiKey: string | undefined) => safeFetch(apiKey) }
  }

  return {
    async refreshModels(context: { credential?: { key?: string; access?: string }; allowNetwork?: boolean; signal?: AbortSignal }) {
      if (context?.allowNetwork === false) return []
      const credential = context?.credential
      const apiKey = credential?.access ?? credential?.key
      return safeFetch(apiKey)
    },
  }
}

/** Register an AI-SDK V3 provider with whichever Pi-family host is running. */
export async function registerAiSdkProvider(pi: PiExtensionApi, spec: AiSdkProviderSpec): Promise<PiHostProfile> {
  const runtime = await loadPiRuntime()
  const { profile } = runtime

  if (profile.reservedApis.includes(spec.api)) {
    throw new Error(`pi-bridge: api "${spec.api}" collides with a built-in ${profile.name} api id; choose a distinct id`)
  }

  const config: Record<string, unknown> = {
    baseUrl: spec.baseUrl,
    api: spec.api,
    streamSimple: buildStreamSimple(spec, runtime),
    ...buildDynamicModels(spec, profile),
  }
  // `apiKey` goes into host config, so it must use the host's own syntax:
  // pi parses it as a `$VAR` / `!cmd` template, omp takes a bare env-var name.
  if (spec.apiKey !== undefined) config.apiKey = renderApiKeyRef(spec.apiKey, profile)
  if (spec.headers !== undefined) config.headers = spec.headers
  if (spec.authHeader !== undefined) config.authHeader = spec.authHeader
  if (spec.models !== undefined) config.models = spec.models
  if (spec.oauth !== undefined) config.oauth = spec.oauth

  pi.registerProvider(spec.name, config)
  return profile
}
