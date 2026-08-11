/**
 * OpenCode `config` hook → Pi-family model list.
 *
 * OpenCode plugins publish their catalog by mutating the shared config
 * (`config.provider[id].models = {…}`) using the models.dev entry shape. That
 * is a convention every OpenCode provider plugin already follows, so reading it
 * gives the bridge a model list for *any* plugin with no per-plugin adapter —
 * replacing what would otherwise be a hand-written `fetchDynamicModels`.
 */
import type { PiHostProfile } from "../host/profile.js"
import type { OpenCodeConfig, OpenCodeHooks, OpenCodeModelEntry } from "./types.js"
import { expandModelVariants, thinkingConfigFor, type ExpandedVariantModel, type ExpandOptions } from "./variants.js"

/** Pi `ProviderModelConfig` (common subset accepted by both hosts). */
export type PiModelConfig = {
  id: string
  name: string
  reasoning: boolean
  input: ("text" | "image")[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  /** Host-specific thinking-level declaration (`thinking` on omp, `thinkingLevelMap` on pi). */
  [key: string]: unknown
}

/**
 * Per-model-entry data the call path needs: the entry's own `options` plus the
 * variant table, so the right provider options can be sent for the selected
 * thinking level.
 */
export type ModelCallData = {
  /** The OpenCode entry's own `options`, forwarded on every call. */
  entryOptions: Record<string, unknown>
  variant: ExpandedVariantModel
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192

function modalityInputs(entry: OpenCodeModelEntry): ("text" | "image")[] {
  const declared = entry.modalities?.input
  if (Array.isArray(declared)) {
    const mapped = declared.filter((m): m is "text" | "image" => m === "text" || m === "image")
    if (mapped.length > 0) return mapped
  }
  // `attachment` is models.dev's older signal for non-text input.
  return entry.attachment ? ["text", "image"] : ["text"]
}

/** models.dev / OpenCode model entry → Pi model config. */
export function toPiModel(id: string, entry: OpenCodeModelEntry): PiModelConfig {
  const contextWindow = entry.limit?.context ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = entry.limit?.output ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS)
  return {
    id,
    name: entry.name ?? id,
    reasoning: entry.reasoning ?? false,
    input: modalityInputs(entry),
    cost: {
      input: entry.cost?.input ?? 0,
      output: entry.cost?.output ?? 0,
      cacheRead: entry.cost?.cache_read ?? 0,
      cacheWrite: entry.cost?.cache_write ?? 0,
    },
    contextWindow,
    maxTokens,
  }
}

/**
 * Expand a model entry into the host model(s) it should produce, attaching each
 * host's thinking-level declaration and recording what the call path must send.
 */
export function expandEntry(
  id: string,
  entry: OpenCodeModelEntry,
  profile: PiHostProfile,
  options: ExpandOptions = {},
): Array<{ model: PiModelConfig; call: ModelCallData }> {
  const base = toPiModel(id, entry)
  const entryOptions = (entry.options as Record<string, unknown> | undefined) ?? {}

  return expandModelVariants(id, entry, options).map(variant => {
    const model: PiModelConfig = {
      ...base,
      id: variant.id,
      name: `${base.name}${variant.nameSuffix}`,
    }
    // Only declare thinking levels when the model actually reasons; a host
    // offering a level picker for a non-reasoning model is worse than none.
    if (variant.levels.length > 0 && base.reasoning) {
      Object.assign(model, thinkingConfigFor(variant.levels, profile))
    }
    return { model, call: { entryOptions, variant } }
  })
}

export type ExtractModelsResult = {
  /** Provider id the plugin declared in config (may differ from the package name). */
  providerId?: string
  models: PiModelConfig[]
  /** Per host-model-id call data (entry options + selected-variant options). */
  callData: Map<string, ModelCallData>
}

/**
 * Run a plugin's `config` hook against an empty config and harvest whatever
 * provider/model catalog it published.
 *
 * `preferProviderId` (usually the auth hook's provider id) disambiguates a
 * plugin that declares more than one provider entry.
 */
export async function extractModelsFromConfigHook(
  hooks: OpenCodeHooks,
  preferProviderId?: string,
  profile?: PiHostProfile,
  expandOptions: ExpandOptions = {},
): Promise<ExtractModelsResult> {
  if (typeof hooks.config !== "function") return { models: [], callData: new Map() }

  const config: OpenCodeConfig = { provider: {} }
  await hooks.config(config)

  const providers = config.provider ?? {}
  const keys = Object.keys(providers)
  if (keys.length === 0) return { models: [], callData: new Map() }

  const providerId = (preferProviderId && keys.includes(preferProviderId) ? preferProviderId : keys[0]) as string
  const entry = providers[providerId]
  const entries = entry?.models ?? {}

  const models: PiModelConfig[] = []
  const callData = new Map<string, ModelCallData>()

  for (const [id, model] of Object.entries(entries)) {
    if (!profile) {
      models.push(toPiModel(id, model))
      continue
    }
    for (const { model: piModel, call } of expandEntry(id, model, profile, expandOptions)) {
      models.push(piModel)
      callData.set(piModel.id, call)
    }
  }

  return { providerId, models, callData }
}
