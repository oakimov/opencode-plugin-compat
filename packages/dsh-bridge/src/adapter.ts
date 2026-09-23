/**
 * DSH Cordis LlmAdapter per OpenCode provider.
 * One instance per `OpenCodePluginSpec.package`, wrapping the provider's
 * AI-SDK V3 `languageModel.doStream`.
 *
 * Mirrors `packages/pi-bridge/src/bridge.ts` `buildStreamSimple` but for
 * `LlmAdapter.stream(GenerateOptions)` → `StreamChunk`.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { optionsForLevel, type ModelCallData } from "@opencode-compat/opencode-loader"
import { translateGenerateOptionsToPrompt, translateTools, type DshGenerateOptions, type DshMessage } from "./translate/context.js"
import { v3StreamToDshChunks, type StreamChunk } from "./translate/stream.js"

export type DshLlmAdapterOptions = {
  providerName: string
  /** Optional provider integration selected by the registration layer. */
  skipGenerateReason?: (messages: readonly DshMessage[]) => string | undefined
  finishUsage?: (part: LanguageModelV3StreamPart & { type: "finish" }) => LanguageModelV3Usage | null | undefined
  api?: string
  getLanguageModel: (modelId: string, apiKey: string | undefined) => Promise<LanguageModelV3> | LanguageModelV3
  /** Resolve per-model variant + entry options */
  resolveCallData?: (modelId: string) => ModelCallData | undefined
  /** Provider id key under which variant options should be placed */
  providerOptionsKey?: string
  /** Native CredentialRef env name, resolved via ctx.credentials */
  credentialRef?: string
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
      const skipped = self.opts.skipGenerateReason?.(options.messages ?? [])
      if (skipped) {
        // eslint-disable-next-line no-console
        console.log(
          `dsh-bridge: skipped child-notice generate sessionId=${options.sessionId ?? "-"} kinds=${skipped}`,
        )
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
        yield { type: "finish", reason: { kind: "stop" } }
        return
      }
      const modelId = options.model
      const callData = self.opts.resolveCallData?.(modelId)
      const variantBaseId = callData?.variant.baseId ?? modelId

      // Resolve the configured CredentialRef. Registration runs the plugin
      // auth.loader and substitutes this value into the factory options.
      const apiKey = await resolveApiKeyFromResolve(self.opts.credentialRef, self.opts.resolveCredential, options.signal)

      const lm = await self.opts.getLanguageModel(variantBaseId, apiKey)

      // Translate DSH GenerateOptions → V3 call options
      const prompt = translateGenerateOptionsToPrompt(options)
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
        for await (const chunk of v3StreamToDshChunks(result.stream, undefined, {
          allowedProviderToolNames: new Set(tools?.map(tool => tool.name) ?? []),
          finishUsage: self.opts.finishUsage,
        })) {
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
