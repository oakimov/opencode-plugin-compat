/**
 * Facade for `@opencode-ai/sdk/v2/client`.
 *
 * Bundled forks (Kilo/MiMo CLIs) do not expose `@kilocode/sdk` / `@mimo-ai/sdk`
 * to plugin module graphs, so this module is self-contained under OpenCode
 * names. On kilo/mimo, `v2.model.list` avoids re-entrant `GET /api/model` during
 * classic `config` hooks (Plugin.state deadlock) by polyfilling from models.dev.
 */
import { detect, type HostHttp } from "@opencode-compat/profile"
import type { ModelV2Info } from "./types.js"

export type OpencodeClientConfig = {
  baseUrl?: string
  directory?: string
  experimental_workspaceID?: string
  /** Existing hey-api transport (classic `PluginInput.client._client`). */
  client?: unknown
  headers?: Record<string, string>
  fetch?: typeof fetch
  [key: string]: unknown
}

/** Alias matching real SDK export name. */
export type Config = OpencodeClientConfig

type Transport = {
  get: (opts: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown }>
}

type ListParams = {
  location?: {
    directory?: string
    workspace?: string
  }
}

type ListOptions = {
  throwOnError?: boolean
  client?: Transport
  [key: string]: unknown
}

type ListResult = {
  data?: {
    data?: ModelV2Info[]
    location?: {
      directory?: string
      workspaceID?: string
      project?: unknown
    }
  }
  error?: unknown
}

const MODELS_DEV_URL = "https://models.dev/api.json"
const API_MODEL_TIMEOUT_MS = 2_500

function hostHttp(): HostHttp {
  return detect().profile.http
}

function withDirectoryHeaders(
  config: OpencodeClientConfig,
): OpencodeClientConfig {
  const http = hostHttp()
  const headers: Record<string, string> = { ...(config.headers ?? {}) }
  if (config.directory) {
    headers[http.directoryHeader] = encodeURIComponent(config.directory)
  }
  if (config.experimental_workspaceID) {
    headers[http.workspaceHeader] = config.experimental_workspaceID
  }
  return { ...config, headers }
}

type ModelsDevReasoningOption = {
  type?: string
  values?: unknown[]
  min?: number
  max?: number
}

type ModelsDevModel = {
  id?: string
  name?: string
  family?: string
  tool_call?: boolean
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  release_date?: string
  status?: string
  interleaved?: true | { field?: string } | boolean
  reasoning_options?: ModelsDevReasoningOption[]
  limit?: { context?: number; input?: number; output?: number }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  modalities?: { input?: string[]; output?: string[] }
}

type ModelsDevProvider = {
  id?: string
  models?: Record<string, ModelsDevModel>
}

function releasedAt(value: string | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function mapStatus(value: string | undefined): ModelV2Info["status"] {
  if (value === "alpha" || value === "beta" || value === "deprecated" || value === "active") {
    return value
  }
  return "active"
}

function effortId(value: unknown): string | undefined {
  if (value === null) return "none"
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

/** Preserve every models.dev effort (incl. xhigh/max) as Catalog variants. */
function variantsFromReasoningOptions(
  options: ModelsDevReasoningOption[] | undefined,
): ModelV2Info["variants"] {
  if (!options?.length) return []
  const ids: string[] = []
  for (const option of options) {
    if (option.type === "effort") {
      for (const value of option.values ?? []) {
        const id = effortId(value)
        if (id) ids.push(id)
      }
    }
    if (option.type === "toggle") {
      ids.push("none", "high")
    }
    if (option.type === "budget_tokens") {
      ids.push("high", "max")
    }
  }
  const seen = new Set<string>()
  const variants: ModelV2Info["variants"] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    variants.push({ id, headers: {}, body: { reasoningEffort: id } })
  }
  return variants
}

function toModelV2Info(providerID: string, model: ModelsDevModel): ModelV2Info | undefined {
  const id = model.id
  if (!id) return undefined
  const input = model.modalities?.input?.length
    ? [...model.modalities.input]
    : model.attachment
      ? ["text", "image"]
      : ["text"]
  const output = model.modalities?.output?.length ? [...model.modalities.output] : ["text"]
  return {
    id,
    providerID,
    family: model.family,
    name: model.name ?? id,
    api: { id, type: "native", settings: {} },
    capabilities: {
      tools: model.tool_call !== false,
      input,
      output,
      reasoning: model.reasoning === true,
      temperature: model.temperature !== false,
      attachment: model.attachment === true,
    },
    request: { headers: {}, body: {} },
    variants: variantsFromReasoningOptions(model.reasoning_options),
    interleaved: model.interleaved,
    reasoning_options: model.reasoning_options,
    time: { released: releasedAt(model.release_date) },
    cost: [
      {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
      },
    ],
    status: mapStatus(model.status),
    enabled: true,
    limit: {
      context: model.limit?.context ?? 128_000,
      input: model.limit?.input,
      output: model.limit?.output ?? 0,
    },
  }
}

let modelsDevCache: Promise<ModelV2Info[]> | undefined

/** Fetch + flatten models.dev into Catalog-shaped ModelV2Info rows. */
export async function loadModelsDevCatalog(
  fetcher: typeof fetch = fetch,
): Promise<ModelV2Info[]> {
  if (!modelsDevCache) {
    modelsDevCache = (async () => {
      const response = await fetcher(MODELS_DEV_URL)
      if (!response.ok) {
        throw new Error(`models.dev fetch failed: HTTP ${response.status}`)
      }
      const body = (await response.json()) as Record<string, ModelsDevProvider>
      const out: ModelV2Info[] = []
      for (const [providerKey, provider] of Object.entries(body)) {
        const providerID = provider.id ?? providerKey
        for (const model of Object.values(provider.models ?? {})) {
          const mapped = toModelV2Info(providerID, model)
          if (mapped) out.push(mapped)
        }
      }
      return out
    })().catch((err) => {
      modelsDevCache = undefined
      throw err
    })
  }
  return modelsDevCache
}

function isTransport(value: unknown): value is Transport {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Transport).get === "function"
  )
}

async function listViaTransport(
  transport: Transport,
  parameters: ListParams | undefined,
  options: ListOptions | undefined,
): Promise<ListResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_MODEL_TIMEOUT_MS)
  try {
    const query: Record<string, unknown> = {}
    if (parameters?.location) query.location = parameters.location
    return (await transport.get({
      url: "/api/model",
      query,
      ...options,
      signal: controller.signal,
      throwOnError: options?.throwOnError,
    })) as ListResult
  } finally {
    clearTimeout(timer)
  }
}

function wrapCatalog(data: ModelV2Info[], directory?: string): ListResult {
  return {
    data: {
      data,
      location: {
        directory,
      },
    },
  }
}

/**
 * OpenCode-named v2 client. Construct with `{ client: classic._client }` the
 * same way stock `@opencode-ai/sdk/v2/client` does.
 */
export class OpencodeClient {
  readonly client: unknown
  private readonly directory?: string

  constructor(config: OpencodeClientConfig = {}) {
    const normalized = withDirectoryHeaders(config)
    this.client = normalized.client
    this.directory = normalized.directory
  }

  get v2() {
    const self = this
    return {
      get model() {
        return {
          list(
            parameters?: ListParams,
            options?: ListOptions,
          ): Promise<ListResult> {
            return self.listModels(parameters, options)
          },
        }
      },
    }
  }

  private async listModels(
    parameters?: ListParams,
    options?: ListOptions,
  ): Promise<ListResult> {
    const directory = parameters?.location?.directory ?? this.directory
    const host = detect().id

    // Kilo/MiMo: classic config hooks run inside Plugin.state. Calling the
    // in-process `/api/model` handler re-enters Location/Instance boot and
    // deadlocks (`timeout: false` fetch). Polyfill from models.dev instead.
    if (host === "kilo" || host === "mimo") {
      try {
        return wrapCatalog(await loadModelsDevCatalog(), directory)
      } catch (err) {
        if (options?.throwOnError) throw err
        return { data: { data: [], location: { directory } }, error: err }
      }
    }

    const transport = options?.client ?? this.client
    if (isTransport(transport)) {
      try {
        const result = await listViaTransport(transport, parameters, options)
        if (Array.isArray(result.data?.data)) return result
      } catch (err) {
        // Fall through to models.dev when /api/model is unavailable.
        if (options?.throwOnError && host === "opencode") {
          // Still try models.dev before failing hard — keeps catalog plugins useful.
        } else if (options?.throwOnError) {
          // continue to polyfill; throw only if that also fails
        }
        void err
      }
    }

    try {
      return wrapCatalog(await loadModelsDevCatalog(), directory)
    } catch (err) {
      if (options?.throwOnError) throw err
      return { data: { data: [], location: { directory } }, error: err }
    }
  }
}

/** Factory matching `@opencode-ai/sdk/v2/client` `createOpencodeClient`. */
export function createOpencodeClient(
  config?: OpencodeClientConfig,
): OpencodeClient {
  return new OpencodeClient(config ?? {})
}

export type { ModelV2Info }