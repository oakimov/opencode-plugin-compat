/**
 * The single entry point: register an *unmodified* OpenCode plugin package as
 * a provider on whichever Pi-family host is running.
 *
 * Everything except the package name is discovered from conventions the plugin
 * already implements, which is why adding a provider needs no adapter package
 * and no changes to the provider itself:
 *
 *   provider id   ← the plugin's own `auth.provider` / `config` hook entry
 *   models        ← its `config` hook (models.dev entry shape)
 *   OAuth         ← its `auth.methods[]` (`type: "oauth"`)
 *   API key       ← its `auth.methods[]` (`type: "api"`, prompts driven through
 *                    the host's own `onPrompt`)
 *   streaming     ← its `createXxx()` AI-SDK factory
 */
import { registerAiSdkProvider } from "./bridge.js"
import { avoidProviderIdCollision, type PiHostProfile } from "./host/profile.js"
import { loadPiRuntime } from "./host/runtime.js"
import { buildPiOAuth, createLoaderRunner, type PiOAuthConfig } from "./opencode/auth.js"
import { createPluginInputStub } from "./opencode/host-stub.js"
import { derivePackageName, instantiateHooks, loadOpenCodePluginModule, substituteApiKey } from "./opencode/load.js"
import { extractModelsFromConfigHook, type ModelCallData, type PiModelConfig } from "./opencode/models.js"
import { optionsForLevel } from "./opencode/variants.js"
import type { OpenCodeHooks } from "./opencode/types.js"
import type { PiExtensionApi } from "./pi-provider-types.js"

export type OpenCodePluginSpec = {
  /** npm specifier, path, or `file://` URL of the OpenCode plugin package. The only required field. */
  package: string
  /** Override the AI-SDK factory export name (auto-detected: the sole `createXxx`). */
  factoryExport?: string
  /** Override the classic plugin factory export name (auto-detected: the sole `*Plugin`). */
  pluginExport?: string
  /** Override the host-facing provider id (default: the plugin's own, else derived from the package name). */
  providerName?: string
  /** Override the custom wire-api id (default: `<providerName>-bridge`). */
  api?: string
  /** Rarely needed: both hosts require a non-empty baseUrl when models exist, but never use it for a custom provider. */
  baseUrl?: string
  /** Env var name (or literal) for API-key auth, when not using the plugin's OAuth. */
  apiKey?: string
  /** Options passed to the AI-SDK factory. `"$apiKey"` anywhere is replaced with the resolved key. */
  createOptions?: Record<string, unknown>
  /** Skip the plugin's auth hook (e.g. to use only an env-var API key). */
  disableOAuth?: boolean
  /** Force which auth method to use when a plugin offers both. */
  preferAuthMethod?: "oauth" | "api"
  /** Static model list; when set, the plugin's `config` hook is not consulted. */
  models?: PiModelConfig[]
  /** Working directory handed to the plugin (default: process.cwd()). */
  directory?: string
  /**
   * Which variant dimensions split a model into separate host entries.
   * Default `["fast"]`; everything else collapses to one preferred value and
   * effort-like dimensions become the host's thinking picker.
   */
  splitDimensions?: readonly string[]
}

export type RegisterResult = {
  profile: PiHostProfile
  providerName: string
  api: string
  modelCount: number
  hasOAuth: boolean
}

/** Discover everything the plugin exposes, then register it with the host. */
export async function registerOpenCodePlugin(pi: PiExtensionApi, spec: OpenCodePluginSpec): Promise<RegisterResult> {
  const loaded = await loadOpenCodePluginModule({
    packageSpecifier: spec.package,
    factoryExport: spec.factoryExport,
    pluginExport: spec.pluginExport,
  })

  const stub = createPluginInputStub({ directory: spec.directory ?? process.cwd() })

  // The classic plugin factory is optional: without it we still have a working
  // streaming provider, just no plugin-supplied auth or model catalog.
  let hooks: OpenCodeHooks | undefined
  if (loaded.pluginFactory) {
    try {
      hooks = await instantiateHooks(loaded.pluginFactory, stub)
    } catch (err) {
      console.error(
        `pi-bridge: "${spec.package}" has an OpenCode plugin factory that failed to initialize; ` +
          `continuing without its auth/model hooks — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const authHook = spec.disableOAuth ? undefined : hooks?.auth
  const declaredProviderId = hooks?.auth?.provider ?? derivePackageName(spec.package)

  // An explicit providerName is taken as-is; a *derived* one is checked against
  // the host's own provider ids, since a plugin declaring e.g. "cursor" would
  // otherwise silently shadow a host built-in of the same name.
  const { profile: hostProfile } = await loadPiRuntime()
  let providerName: string
  if (spec.providerName) {
    providerName = spec.providerName
  } else {
    providerName = avoidProviderIdCollision(declaredProviderId, hostProfile)
    if (providerName !== declaredProviderId) {
      console.error(
        `pi-bridge: "${spec.package}" declares provider id "${declaredProviderId}", which ${hostProfile.name} already ships natively — ` +
          `registering as "${providerName}" instead so the built-in provider is not shadowed. Set "providerName" to choose your own.`,
      )
    }
  }
  const api = spec.api ?? `${providerName}-bridge`

  let oauth: PiOAuthConfig | undefined
  if (authHook) {
    oauth = buildPiOAuth({
      authHook,
      prefer: spec.preferAuthMethod,
      runLoader: createLoaderRunner(authHook, stub.store),
    })
  }

  // Model list. The `config` hook is cache/credential dependent for many
  // plugins, so it is re-run on each host refresh rather than captured once.
  // `callData` records what each expanded model must send at call time.
  const callData = new Map<string, ModelCallData>()

  const harvest = async (): Promise<readonly PiModelConfig[]> => {
    if (!hooks) return []
    const result = await extractModelsFromConfigHook(hooks, authHook?.provider, hostProfile, {
      ...(spec.splitDimensions ? { splitDimensions: spec.splitDimensions } : {}),
    })
    for (const [id, data] of result.callData) callData.set(id, data)
    return result.models
  }

  const initialModels = spec.models ?? (await harvest())
  const fetchModels = spec.models ? undefined : harvest

  // The plugin reads its provider options under the id *it* declares, which is
  // not necessarily the host-facing name (that one may have been de-collided).
  const providerOptionsKey = authHook?.provider ?? hooks?.auth?.provider ?? providerName

  const profile = await registerAiSdkProvider(pi, {
    name: providerName,
    api,
    baseUrl: spec.baseUrl ?? `opencode-plugin:${spec.package}`,
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    ...(initialModels.length > 0 ? { models: initialModels } : {}),
    ...(fetchModels ? { fetchModels } : {}),
    ...(oauth ? { oauth } : {}),
    getLanguageModel: async (modelId, apiKey) => {
      const options = substituteApiKey(spec.createOptions ?? { apiKey: "$apiKey" }, apiKey) as Record<string, unknown>
      const provider = await loaded.factory(options)
      // Variant entries carry synthetic ids (e.g. `grok-4.6-fast`); the plugin
      // only knows the base model, so resolve back to it.
      const call = callData.get(modelId)
      return provider.languageModel(call?.variant.baseId ?? modelId)
    },
    buildCallOptions: ({ model, options, base }) => {
      const call = callData.get(model.id)
      if (!call) return base
      // Entry options first (e.g. a long-context entry's wire model id), then
      // the selected variant's own options object, verbatim.
      const merged = { ...call.entryOptions, ...optionsForLevel(call.variant, options?.reasoning) }
      if (Object.keys(merged).length === 0) return base
      return {
        ...base,
        providerOptions: { ...base.providerOptions, [providerOptionsKey]: merged as Record<string, never> },
      }
    },
  })

  return {
    profile,
    providerName,
    api,
    modelCount: initialModels.length,
    hasOAuth: Boolean(oauth),
  }
}
