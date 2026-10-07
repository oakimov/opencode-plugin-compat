/**
 * DSH Cordis LlmAdapter per OpenCode provider.
 * One instance per `OpenCodePluginSpec.package`, wrapping the provider's
 * AI-SDK V3 `languageModel.doStream`.
 *
 * Mirrors `packages/pi-bridge/src/bridge.ts` `buildStreamSimple` but for
 * `LlmAdapter.stream(GenerateOptions)` → `StreamChunk`.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { optionsForLevel, type ModelCallData, type UsageContext } from "@opencode-compat/opencode-loader"
import { translateGenerateOptionsToPrompt, translateTools, type DshGenerateOptions, type DshMessage } from "./translate/context.js"
import { v3StreamToDshChunks, type StreamChunk } from "./translate/stream.js"
import { toolInputsForSchemas, type DshToolInputVocabulary } from "./translate/tools.js"

export type DshLlmAdapterOptions = {
  providerName: string
  toolInputs?: DshToolInputVocabulary
  /** Optional per-call vocabulary when a host tool's advertised schema varies. */
  toolInputsForCall?: (options: DshGenerateOptions) => DshToolInputVocabulary
  /** Optional package-selected adaptation of host guidance before translation. */
  prepareOptions?: (options: DshGenerateOptions) => DshGenerateOptions
  /** Tools installed for another configured provider are omitted from this adapter's catalog. */
  excludeToolNames?: ReadonlySet<string>
  /**
   * Optional provider integration selected by the registration layer.
   * A hit must not emit text: DSH records that text as another assistant
   * message. Stopping the step before it starts is what keeps the reply visible once.
   */
  skipGenerate?: (messages: readonly DshMessage[]) => { reason: string } | undefined
  finishUsage?: (part: LanguageModelV3StreamPart & { type: "finish" }) => LanguageModelV3Usage | null | undefined
  finishContext?: (part: LanguageModelV3StreamPart & { type: "finish" }) => UsageContext | undefined
  /** Package-selected terminal stream adaptation, after V3 tool-name translation. */
  reviewCompletedPlan?: (chunks: AsyncIterable<StreamChunk>, options: DshGenerateOptions) => AsyncIterable<StreamChunk>
  api?: string
  getLanguageModel: (modelId: string, apiKey: string | undefined) => Promise<LanguageModelV3> | LanguageModelV3
  /** Resolve per-model variant + entry options */
  resolveCallData?: (modelId: string) => ModelCallData | undefined
  /** Provider id key under which variant options should be placed */
  providerOptionsKey?: string
  /**
   * The plugin's OpenCode `chat.params` hook for a session request: receives the
   * model/variant options and returns the options the request carries.
   */
  chatParams?: (input: { sessionId: string; modelId: string; options: Record<string, unknown> }) => Promise<Record<string, unknown>>
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
  listModels(_provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
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
      const skipped = self.opts.skipGenerate?.(options.messages ?? [])
      if (skipped) {
        // eslint-disable-next-line no-console
        console.log(
          `dsh-bridge: skipped child-notice generate sessionId=${options.sessionId ?? "-"} kinds=${skipped.reason}`,
        )
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
        yield { type: "finish", reason: { kind: "stop" }, replayState: { response: { ocpContext: { carry: true } } } }
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
      const prepared = self.opts.prepareOptions?.(options) ?? options
      const toolInputs = toolInputsForSchemas(prepared.tools, self.opts.toolInputsForCall?.(prepared) ?? self.opts.toolInputs)
      const prompt = translateGenerateOptionsToPrompt(prepared, toolInputs, self.opts.excludeToolNames)
      const visibleTools = self.opts.excludeToolNames
        ? prepared.tools?.filter(tool => !self.opts.excludeToolNames!.has(tool.name))
        : prepared.tools
      const tools = translateTools(visibleTools, toolInputs)

      // Session affinity: DSH native sessionId → requesting-session header.
      // Skip on a zero-tool call: a provider may treat a session-keyed call
      // with tools=[] as a lifecycle signal that waits for a sibling call's
      // full catalog, and DSH generate is sequential.
      const headers: Record<string, string> = {}
      if (options.sessionId && (tools?.length ?? 0) > 0) {
        headers["x-opencode-session-id"] = options.sessionId
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
      if (self.opts.providerOptionsKey) {
        const level = typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined
        let merged: Record<string, unknown> = callData
          ? { ...callData.entryOptions, ...optionsForLevel(callData.variant, level) }
          : {}
        // OpenCode runs `chat.params` for every session turn; lifecycle
        // requests (`purpose`, e.g. titles) are not agent turns.
        if (self.opts.chatParams && options.sessionId && !options.purpose) {
          merged = await self.opts.chatParams({ sessionId: options.sessionId, modelId: variantBaseId, options: merged })
        }
        if (Object.keys(merged).length > 0) {
          callOptions = {
            ...base,
            providerOptions: { ...(base.providerOptions ?? {}), [self.opts.providerOptionsKey]: merged as never },
          }
        }
      }

      try {
        const result = await lm.doStream(callOptions as never)
        const translated = v3StreamToDshChunks(result.stream, toolInputs, {
          allowedProviderToolNames: new Set(tools?.map(tool => tool.name) ?? []),
          finishUsage: self.opts.finishUsage,
          finishContext: self.opts.finishContext,
        })
        const chunks = self.opts.reviewCompletedPlan?.(translated, prepared) ?? translated
        for await (const chunk of chunks) {
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
  override async listModels(_provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return []
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; [k: string]: unknown }> {
    return { provider, id: model, name: model }
  }
}
