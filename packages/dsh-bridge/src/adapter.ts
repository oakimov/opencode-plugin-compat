/**
 * DSH Cordis LlmAdapter per OpenCode provider.
 * One instance per `OpenCodePluginSpec.package`, wrapping the provider's
 * AI-SDK V3 `languageModel.doStream`.
 *
 * Mirrors `packages/pi-bridge/src/bridge.ts` `buildStreamSimple` but for
 * `LlmAdapter.stream(GenerateOptions)` → `StreamChunk`.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { substituteApiKey } from "./opencode/index.js"
import { translateGenerateOptionsToPrompt, translateTools, type DshGenerateOptions } from "./translate/context.js"
import { v3StreamToDshChunks, type StreamChunk } from "./translate/stream.js"
import type { ModelCallData } from "./opencode/index.js"

export type DshLlmAdapterOptions = {
  providerName: string
  api?: string
  getLanguageModel: (modelId: string, apiKey: string | undefined) => Promise<LanguageModelV3> | LanguageModelV3
  /** Resolve per-model variant + entry options */
  resolveCallData?: (modelId: string) => ModelCallData | undefined
  /** Provider id key under which variant options should be placed */
  providerOptionsKey?: string
  /** Native CredentialRef env name, resolved via ctx.credentials */
  credentialRef?: string
  /** Base createOptions from spec (with "$apiKey" placeholder) */
  createOptionsTemplate?: Record<string, unknown>
  /** Resolve credential value from Cordis credentials service */
  resolveCredential?: (ref: string, signal?: AbortSignal) => Promise<string | undefined>
}

function resolveApiKeyFromResolve(credentialRef: string | undefined, resolveCredential: DshLlmAdapterOptions["resolveCredential"], signal?: AbortSignal): Promise<string | undefined> {
  if (!credentialRef || !resolveCredential) return Promise.resolve(undefined)
  return resolveCredential(credentialRef, signal).catch(() => undefined)
}

/** Minimal LlmAdapter base — structural, so we don't require runtime DSH dep for typecheck. */
export abstract class LlmAdapter {
  abstract stream(options: DshGenerateOptions): AsyncIterable<StreamChunk>
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }
  providerRetryPolicy(_provider: string): unknown {
    return undefined
  }
  imageRequestPricing(_provider: string, _model: string): unknown {
    return undefined
  }
  listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([])
  }
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<{ provider: string; id: string; name: string; [k: string]: unknown }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: { provider: string; id: string; name: string; [k: string]: unknown }
    stream: (options: DshGenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }
}

export class DshLlmAdapter extends LlmAdapter {
  constructor(private readonly opts: DshLlmAdapterOptions) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override providerRetryPolicy(_provider: string): unknown {
    return undefined
  }

  override imageRequestPricing(_provider: string, _model: string): unknown {
    return undefined
  }

  override stream(options: DshGenerateOptions): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      const modelId = options.model
      const callData = self.opts.resolveCallData?.(modelId)
      const variantBaseId = callData?.variant.baseId ?? modelId

      // Resolve credential (native ref like CURSOR_API_KEY)
      const apiKey = await resolveApiKeyFromResolve(self.opts.credentialRef, self.opts.resolveCredential, options.signal)

      // Build createOptions with $apiKey substitution (like pi-bridge register.ts:174)
      // (factory already bound with substituted options at registration; this is for per-request key)
      void (substituteApiKey(self.opts.createOptionsTemplate ?? { apiKey: "$apiKey" }, apiKey) as unknown as Record<string, unknown>)

      const lm = await self.opts.getLanguageModel(variantBaseId, apiKey)

      // Translate DSH GenerateOptions → V3 call options
      const prompt = translateGenerateOptionsToPrompt(options as DshGenerateOptions)
      const tools = translateTools(options.tools as never)

      // Session affinity: DSH native sessionId → V3 headers x-opencode-session (like pi-bridge bridge.ts:66)
      const headers: Record<string, string> = {}
      if (options.sessionId) {
        headers["x-opencode-session"] = options.sessionId
        headers["x-session-id"] = options.sessionId
      }

      const base: LanguageModelV3CallOptions = {
        prompt,
        ...(tools ? { tools } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stop ? { stopSequences: options.stop } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(options.signal ? { abortSignal: options.signal } : {}),
      }

      // Merge variant entryOptions + level options into providerOptions[providerOptionsKey]
      let callOptions = base
      if (callData && self.opts.providerOptionsKey) {
        const { optionsForLevel } = await import("./opencode/index.js")
        const level = typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined
        const merged = { ...callData.entryOptions, ...optionsForLevel(callData.variant, level) }
        if (Object.keys(merged).length > 0) {
          callOptions = {
            ...base,
            providerOptions: { ...(base.providerOptions ?? {}), [self.opts.providerOptionsKey]: merged as never },
          }
        }
      }

      try {
        const result = await lm.doStream(callOptions as never)
        for await (const chunk of v3StreamToDshChunks(result.stream)) {
          yield chunk
        }
      } catch (err) {
        if (options.signal?.aborted) throw err
        const message = err instanceof Error ? err.message : String(err)
        yield { type: "finish", reason: { kind: "error", failure: { message, code: "UNKNOWN" } } }
      }
    })()
  }

  // Advisory catalog — DSH runtime will call listModels/resolveModel for UI
  override async listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return []
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; [k: string]: unknown }> {
    return { provider, id: model, name: model }
  }
}
