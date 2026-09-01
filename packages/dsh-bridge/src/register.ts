/**
 * Register an unmodified OpenCode plugin as a DSH LlmAdapter.
 * Oriented on `packages/pi-bridge/src/register.ts`.
 */
import { avoidProviderIdCollision, dshProfile } from "./host/profile.js"
import { createPluginInputStub } from "./opencode/index.js"
import { derivePackageName, inspectOpenCodePluginModule, instantiateHooks, loadOpenCodePluginModule, substituteApiKey } from "./opencode/index.js"
import { extractModelsFromConfigHook } from "./opencode/index.js"
import { DshLlmAdapter } from "./adapter.js"
import type { OpenCodePluginSpec } from "./config.js"
import { DSH_BRIDGE_SETTINGS_NS, settingsPathFor } from "./settings.js"
import type { OpenCodeHooks } from "./opencode/index.js"
import { expandModelVariants, thinkingConfigFor } from "./opencode/index.js"

// Minimal DSH Cordis types — structural
type DshContext = {
  llm: {
    registerAdapter: (providers: string[], adapter: unknown) => { (): void; replace: (next: string[]) => void }
    registerConfigurableProviders?: (entries: unknown[]) => unknown
    registerModelDiscovery?: (ns: string, fn: unknown) => () => void
  }
  credentials: {
    resolve: (ref: string) => Promise<{ value: string } | undefined>
    readRecord?: (key: string) => Promise<unknown>
    modifyRecord?: (key: string, fn: (cur: unknown) => Promise<unknown>) => Promise<unknown>
  }
  logger?: { warn: (msg: string) => void; info: (msg: string) => void }
}

// DSH model info shapes (advisory)
type LlmModelInfo = {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly ("text" | "image")[]
}

function toDshModelInfo(provider: string, id: string, entry: any, variantNameSuffix = ""): LlmModelInfo {
  const name = (entry.name as string | undefined) ?? id
  const modalities: ("text" | "image")[] = entry.attachment ? ["text", "image"] : ["text"]
  return {
    provider,
    id: `${id}${variantNameSuffix}`,
    name: `${name}${variantNameSuffix ? ` ${variantNameSuffix}` : ""}`,
    inputModalities: modalities,
  }
}

export type RegisterResult = {
  providerName: string
  modelCount: number
  hasOAuth: boolean
}

export async function registerDshPlugin(ctx: DshContext, spec: OpenCodePluginSpec): Promise<RegisterResult> {
  const loadSpec = {
    packageSpecifier: spec.package,
    ...(spec.factoryExport ? { factoryExport: spec.factoryExport } : {}),
    ...(spec.pluginExport ? { pluginExport: spec.pluginExport } : {}),
  }

  // DSH has no host-module-loader like pi-bridge's `loadModuleThroughHost`; dynamic import is the path
  const loaded = await loadOpenCodePluginModule(loadSpec as never)

  const stub = createPluginInputStub({ directory: spec.directory ?? process.cwd() })

  let hooks: OpenCodeHooks | undefined
  if (loaded.pluginFactory) {
    try {
      hooks = await instantiateHooks(loaded.pluginFactory as never, stub as never)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: "${spec.package}" plugin factory failed — continuing without auth/model hooks — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const authHook = spec.disableOAuth ? undefined : hooks?.auth
  const declaredProviderId = hooks?.auth?.provider ?? derivePackageName(spec.package)

  const profile = dshProfile()
  let providerName: string
  if (spec.providerName) providerName = spec.providerName
  else {
    providerName = avoidProviderIdCollision(declaredProviderId, profile)
    if (providerName !== declaredProviderId) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: "${spec.package}" declares provider "${declaredProviderId}" which is reserved — registering as "${providerName}"`)
    }
  }

  // Model harvesting — run config hook, expand variants
  const callData = new Map<string, { entryOptions: Record<string, unknown>; variant: any }>()
  const harvest = async (): Promise<LlmModelInfo[]> => {
    if (!hooks || !spec.models) {
      // Use loader's extractModels but adapt to DSH shapes
      const result = await extractModelsFromConfigHook(hooks as never, authHook?.provider, profile as never, { splitDimensions: spec.splitDimensions as never })
      const out: LlmModelInfo[] = []
      for (const m of result.models) {
        // m is PiModelConfig — adapt to DSH LlmModelInfo
        out.push({ provider: providerName, id: m.id, name: m.name, inputModalities: m.input as any })
        const cd = result.callData.get(m.id)
        if (cd) callData.set(m.id, cd)
      }
      // If no profile expansion needed (we already did via Pi profile), also handle raw entries for DSH reasoning
      // For DSH we need to preserve levels for resolveModel; above already captured
      return out
    }
    // spec.models provided directly — not yet mapped, treat as DshModelInfo[]
    return (spec.models as any[]).map((m: any) => ({ provider: providerName, id: m.id, name: m.name ?? m.id } as LlmModelInfo))
  }

  // Initial models
  let initialModels: LlmModelInfo[] = []
  if (spec.models) initialModels = await harvest()
  else if (hooks) initialModels = await harvest()
  else initialModels = []

  // Fallback: if extraction via Pi profile didn't produce DSH reasoning, do DSH-native expansion
  if (initialModels.length === 0 && hooks) {
    const raw = await extractModelsFromConfigHook(hooks as never, authHook?.provider, undefined as never)
    for (const m of raw.models) {
      initialModels.push({ provider: providerName, id: m.id, name: m.name })
    }
  }

  const providerOptionsKey = authHook?.provider ?? hooks?.auth?.provider ?? providerName

  // Credentials: native ref name (e.g. CURSOR_API_KEY)
  const credentialRef = spec.apiKey

  const resolveCredential = credentialRef
    ? async (ref: string, _signal?: AbortSignal): Promise<string | undefined> => {
        const resolved = await ctx.credentials.resolve(ref as never).catch(() => undefined)
        return (resolved as { value?: string } | undefined)?.value
      }
    : undefined

  // Build per-model call data for variant handling (if we used Pi profile, reuse that; otherwise build from loader)
  // For DSH effort picker, we need to expose reasoning levels via resolveModel
  const modelMap = new Map(initialModels.map((m) => [m.id, m]))
  const getCallData = (modelId: string) => callData.get(modelId)

  const adapter = new DshLlmAdapter({
    providerName,
    credentialRef,
    providerOptionsKey,
    resolveCredential: credentialRef ? (ref) => resolveCredential!(ref as string) : undefined,
    createOptionsTemplate: spec.createOptions,
    getLanguageModel: async (modelId, apiKey) => {
      const options = substituteApiKey(spec.createOptions ?? { apiKey: "$apiKey" }, apiKey) as Record<string, unknown>
      const provider = await (loaded.factory as any)(options)
      const call = getCallData(modelId)
      return provider.languageModel(call?.variant.baseId ?? modelId)
    },
    resolveCallData: getCallData,
  })

  // Attach model catalog to adapter for listModels/resolveModel
  const adapterWithCatalog = adapter as unknown as {
    listModels: (provider: string) => Promise<readonly LlmModelInfo[]>
    resolveModel: (provider: string, model: string) => Promise<any>
  }
  adapterWithCatalog.listModels = async () => initialModels
  adapterWithCatalog.resolveModel = async (provider, model) => {
    const base = modelMap.get(model) ?? { provider, id: model, name: model }
    // Expand reasoning levels for this exact model via variant data
    const call = getCallData(model)
    if (call?.variant?.levels?.length) {
      const levels = call.variant.levels as string[]
      return {
        provider,
        id: model,
        name: base.name,
        context: { contextWindow: 128_000 },
        reasoning: {
          efforts: levels.map((lvl) => ({ id: lvl, name: lvl.charAt(0).toUpperCase() + lvl.slice(1) })),
          defaultEffort: levels[Math.floor(levels.length / 2)],
        },
      }
    }
    return { provider, id: model, name: base.name }
  }

  // Register with DSH LLM runtime
  ctx.llm.registerAdapter([providerName], adapter as never)

  // Register configurable provider + discovery for DSH settings UI (directory pattern)
  try {
    ;(ctx.llm as any).registerConfigurableProviders?.([
      {
        provider: providerName,
        displayName: providerName,
        settingsNs: DSH_BRIDGE_SETTINGS_NS,
        settingsPath: settingsPathFor(providerName),
      },
    ])
  } catch { /* ignore if not available */ }

  return { providerName, modelCount: initialModels.length, hasOAuth: Boolean(authHook) }
}
