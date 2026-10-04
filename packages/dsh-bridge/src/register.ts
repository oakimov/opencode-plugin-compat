/**
 * Register an unmodified OpenCode plugin as a DSH LlmAdapter.
 * Oriented on `packages/pi-bridge/src/register.ts`.
 */
import {
  createPluginInputStub,
  derivePackageName,
  extractModelsFromConfigHook,
  instantiateHooks,
  loadOpenCodePluginModule,
  loadProviderOptions,
  mergeFactoryOptions,
  openCodeAuthFromResolvedKey,
  providerPackageMatches,
  type OpenCodeAuth,
  type OpenCodeHooks,
  type PiModelConfig,
} from "@opencode-compat/opencode-loader"
import { avoidProviderIdCollision, dshProfile } from "./host/profile.js"
import { DshLlmAdapter, type DshLlmAdapterOptions } from "./adapter.js"
import type { OpenCodePluginSpec } from "./config.js"
import { isCursorProviderPackage } from "./config.js"
import type { SettingsAddress } from "./settings.js"
import { cursorChildNoticeContinuation, removeVisibleReplyEchoes } from "./translate/cursor-continuation.js"

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
  context?: { contextWindow: number }
  defaultMaxTokens?: number
}

function modelInfo(provider: string, model: PiModelConfig): LlmModelInfo {
  return {
    provider, id: model.id, name: model.name, inputModalities: model.input,
    context: { contextWindow: model.contextWindow }, defaultMaxTokens: model.maxTokens,
  }
}

function credentialFromAuth(auth: OpenCodeAuth | undefined): string | undefined {
  if (!auth) return undefined
  if (auth.type === "oauth") return auth.access || undefined
  if (auth.type === "api") return auth.key || undefined
  return undefined
}

export type RegisterResult = {
  providerName: string
  modelCount: number
  hasOAuth: boolean
}

export async function registerDshPlugin(
  ctx: DshContext,
  spec: OpenCodePluginSpec,
  hasCursorPlanEntry = false,
  isPlanActive?: (sessionId: string) => boolean,
  settings?: SettingsAddress,
): Promise<RegisterResult> {
  const cursorIntegration = isCursorProviderPackage(spec.package)
  const cursorUsage = cursorIntegration
    ? await import("./translate/cursor-usage.js")
    : undefined
  const devinUsage = providerPackageMatches(spec.package, "devin-opencode-provider")
    ? await import("@opencode-compat/opencode-loader/devin-usage") : undefined
  const planTools = cursorIntegration ? await import("./cursor-plan-tools.js") : undefined
  const metadataWrite = cursorIntegration ? await import("./cursor-metadata-write.js") : undefined
  const instructions = cursorIntegration ? await import("./cursor-instructions.js") : undefined
  const loadSpec = {
    packageSpecifier: spec.package,
    label: "dsh-bridge",
    ...(spec.factoryExport ? { factoryExport: spec.factoryExport } : {}),
    ...(spec.pluginExport ? { pluginExport: spec.pluginExport } : {}),
  }

  const loaded = await loadOpenCodePluginModule(loadSpec)

  // `session` stays absent so optional host calls do not throw on lookup.
  const stub = createPluginInputStub({
    directory: spec.directory ?? process.cwd(),
    bridgeName: "dsh-bridge",
    absentClientKeys: ["session"],
  })

  let hooks: OpenCodeHooks | undefined
  if (loaded.pluginFactory) {
    try {
      hooks = await instantiateHooks(loaded.pluginFactory, stub, "dsh-bridge")
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
    if (!spec.models) {
      if (!hooks) return []
      // Use loader's extractModels but adapt to DSH shapes
      const result = await extractModelsFromConfigHook(hooks as never, authHook?.provider, profile as never, { splitDimensions: spec.splitDimensions as never })
      const out: LlmModelInfo[] = []
      for (const m of result.models) {
        // m is PiModelConfig — adapt to DSH LlmModelInfo
        out.push(modelInfo(providerName, m))
        const cd = result.callData.get(m.id)
        if (cd) callData.set(m.id, cd)
      }
      // If no profile expansion needed (we already did via Pi profile), also handle raw entries for DSH reasoning
      // For DSH we need to preserve levels for resolveModel; above already captured
      return out
    }
    // spec.models provided directly — not yet mapped, treat as DshModelInfo[]
    return (spec.models as Array<LlmModelInfo & Partial<PiModelConfig>>).map(m => ({
      provider: providerName, id: m.id, name: m.name ?? m.id,
      ...(m.inputModalities || m.input ? { inputModalities: m.inputModalities ?? m.input } : {}),
      ...(m.context || m.contextWindow ? { context: m.context ?? { contextWindow: m.contextWindow! } } : {}),
      ...(m.defaultMaxTokens || m.maxTokens ? { defaultMaxTokens: m.defaultMaxTokens ?? m.maxTokens } : {}),
    }))
  }

  const providerOptionsKey = authHook?.provider ?? hooks?.auth?.provider ?? providerName

  // Credentials: native ref name (env CredentialRef, not a secret). `apiKey`
  // is the shared OpenCodePluginSpec spelling; Settings → Models reads `apiKeyEnv`.
  const credentialRef = spec.apiKeyEnv || spec.apiKey

  const resolveCredential = credentialRef
    ? async (ref: string, _signal?: AbortSignal): Promise<string | undefined> => {
        const resolved = await ctx.credentials.resolve(ref as never).catch(() => undefined)
        return (resolved as { value?: string } | undefined)?.value
      }
    : undefined

  // A DSH CredentialRef names an API key; the bridge runs no OAuth login that
  // could store a session token behind it. Unlike Pi (whose resolved key may
  // come from the plugin's own OAuth login), prefer the plugin's API method.
  const resolvedAuthMethod = spec.preferAuthMethod
    ?? (authHook?.methods?.some(method => method.type === "api") ? "api" : undefined)

  const preparedCredential = async (resolved: string | undefined): Promise<{
    key: string | undefined
    loaderOptions: Record<string, unknown>
  }> => {
    let auth: OpenCodeAuth | undefined
    if (authHook) {
      const stored = await stub.store.get()
      const storedKey = stored?.type === "oauth" ? stored.access : stored?.type === "api" ? stored.key : undefined
      if (resolved) {
        auth = stored && storedKey === resolved
          ? stored
          : openCodeAuthFromResolvedKey(authHook, resolved, resolvedAuthMethod)
      } else {
        auth = stored
      }
    }
    // Single auth.loader call: warms credential-dependent catalogs and yields
    // any factory options (including getAccessToken after provider #35).
    const loaderOptions = await loadProviderOptions(authHook, stub.store, auth)
    const current = await stub.store.get()
    return {
      key: credentialFromAuth(current) ?? resolved,
      loaderOptions,
    }
  }

  // Drive auth.loader before the catalog read when a credential is already
  // resolved, so a catalog that appears only after login is not registered empty.
  let initialModels: LlmModelInfo[] = []
  if (spec.models) initialModels = await harvest()
  else if (hooks) {
    const resolved = credentialRef && resolveCredential ? await resolveCredential(credentialRef) : undefined
    await preparedCredential(resolved)
    initialModels = await harvest()
  } else initialModels = []

  if (initialModels.length === 0 && hooks) {
    const raw = await extractModelsFromConfigHook(hooks, authHook?.provider, undefined, { splitDimensions: spec.splitDimensions })
    for (const m of raw.models) {
      initialModels.push(modelInfo(providerName, m))
    }
  }

  // Build per-model call data for variant handling (if we used Pi profile, reuse that; otherwise build from loader)
  // For DSH effort picker, we need to expose reasoning levels via resolveModel
  const modelMap = new Map(initialModels.map((m) => [m.id, m]))
  const getCallData = (modelId: string) => callData.get(modelId)

  const adapter = new DshLlmAdapter({
    providerName,
    ...(planTools && metadataWrite && instructions ? {
      toolInputs: planTools.cursorPlanToolInputs,
      toolInputsForCall: options => metadataWrite.cursorMetadataWriteToolInputs(options, planTools.cursorPlanToolInputs),
      prepareOptions: options => planTools.prepareCursorPlanOptions(instructions.foldCursorAgentInstructions({
        ...options,
        messages: removeVisibleReplyEchoes(options.messages),
      })),
      reviewCompletedPlan: (chunks, options) => !options.purpose && options.sessionId
        && options.tools?.some(tool => tool.name === "exit_plan_mode")
        && isPlanActive?.(options.sessionId)
        ? planTools.reviewCompletedCursorPlan(chunks, () => isPlanActive(options.sessionId!))
        : chunks,
    } satisfies Pick<DshLlmAdapterOptions, "toolInputs" | "toolInputsForCall" | "prepareOptions" | "reviewCompletedPlan"> : {}),
    ...(!cursorIntegration && hasCursorPlanEntry ? { excludeToolNames: new Set(["plan_enter", "cursor_image_save"]) } : {}),
    skipGenerate: cursorIntegration ? cursorChildNoticeContinuation : undefined,
    ...(cursorUsage ? { finishUsage: cursorUsage.cursorFinishUsage, finishContext: cursorUsage.cursorFinishContext }
      : devinUsage ? { finishUsage: devinUsage.devinFinishUsage, finishContext: devinUsage.devinFinishContext } : {}),
    credentialRef,
    providerOptionsKey,
    resolveCredential: credentialRef ? (ref) => resolveCredential!(ref as string) : undefined,
    getLanguageModel: async (modelId, apiKey) => {
      const prepared = await preparedCredential(apiKey)
      const options = mergeFactoryOptions({
        createOptions: spec.createOptions,
        apiKey: prepared.key,
        loaderOptions: prepared.loaderOptions,
      })
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
        ...base, provider,
        reasoning: {
          efforts: levels.map((lvl) => ({ id: lvl, name: lvl.charAt(0).toUpperCase() + lvl.slice(1) })),
          defaultEffort: levels[Math.floor(levels.length / 2)],
        },
      }
    }
    return { ...base, provider }
  }

  // Register with DSH LLM runtime
  ctx.llm.registerAdapter([providerName], adapter as never)

  // Settings → Models lists a route when its directory entry addresses a value
  // in this entry's volatile Config (`providers[index]`, see settings.ts).
  if (settings) {
    try {
      ctx.llm.registerConfigurableProviders?.([{ provider: providerName, displayName: providerName, ...settings }])
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`dsh-bridge: "${providerName}" is not listed in Settings → Models — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { providerName, modelCount: initialModels.length, hasOAuth: Boolean(authHook) }
}
