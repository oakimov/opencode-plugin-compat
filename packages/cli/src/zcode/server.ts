/**
 * Loopback Anthropic Messages endpoint for stock ZCode's Personal provider.
 *
 * - Binds loopback only, rejects foreign Host headers (DNS rebinding) and any
 *   browser Origin.
 * - The presented bridge credential selects the binding; `x-api-key` and
 *   `Authorization: Bearer` must agree.
 * - ZCode's attribution and trace headers are correlation data for OCP only:
 *   none of them is forwarded to the consumer plugin or its upstream.
 * - Each HTTP attempt owns an AbortController; client disconnect and shutdown
 *   cancel the in-flight provider call. A finished `tool_use` response ends
 *   the attempt and leaves provider-owned continuation state to the provider.
 * - Default logs carry route, binding, model alias, a per-process request id
 *   pseudonym, status, sanitized error code and version — never secrets, raw
 *   header values, prompt bodies or file contents.
 */
import { createHmac, randomBytes } from "node:crypto"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { OCP_VERSION } from "@opencode-compat/profile"
import { parseMessagesRequest, RequestTranslationError } from "./anthropic-request.js"
import {
  anthropicError,
  collectStream,
  encodeAnthropicMessage,
  encodeAnthropicStream,
  type AnthropicErrorType,
  type StreamOutcome,
} from "./anthropic-response.js"
import { presentedCredential } from "./credentials.js"
import { bindingForModelCredential, type BindingRuntime, type Generation } from "./runtime.js"
import { createSessionToolCatalog, ToolMappingError } from "./tools.js"

/** ZCode request attribution (runner-attribution.ts); values are never forwarded. */
export const ZCODE_ATTRIBUTION_HEADERS = [
  "x-session-id",
  "x-zcode-session-type",
  "x-zcode-query-source",
  "x-zcode-session-features",
  "x-query-id",
  "x-request-id",
  "x-zcode-trace-id",
] as const

/** Non-secret protocol headers recorded for wire diagnostics. */
export const PROTOCOL_HEADERS = ["anthropic-version", "anthropic-beta", "user-agent", "content-type", "accept"] as const

export type RequestSummary = {
  route: string
  method: string
  headerNames: string[]
  attribution: Partial<Record<(typeof ZCODE_ATTRIBUTION_HEADERS)[number], string>>
  protocol: Partial<Record<(typeof PROTOCOL_HEADERS)[number], string>>
  binding?: string
  model?: string
  stream?: boolean
  toolNames?: string[]
  toolChoice?: string
  messages?: Array<{ role: string; blocks: string[] }>
  systemBlocks?: number
  toolResultIds?: string[]
  ignoredFields?: string[]
}

export type RequestRecord = RequestSummary & {
  status: number
  errorCode?: string
  stopReason?: string
  toolCallIds?: string[]
  closedByClient?: boolean
  durationMs: number
}

export type BridgeObserver = (record: RequestRecord) => void

export type BridgeServerOptions = {
  generation: Generation
  /** Line logger (stderr by default). */
  log?: (line: string) => void
  observer?: BridgeObserver
  pingIntervalMs?: number
}

export type BridgeServer = {
  url: string
  port: number
  generation(): Generation
  /** Publish a fully built replacement generation. */
  publish(next: Generation): void
  stop(): Promise<void>
}

export class ListenerConflictError extends Error {
  constructor(host: string, port: number, cause: unknown) {
    super(`cannot listen on ${host}:${port}: ${cause instanceof Error ? cause.message : String(cause)} (is another bridge or service using the port?)`)
    this.name = "ListenerConflictError"
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function errorResponse(status: number, type: AnthropicErrorType, message: string): Response {
  return json(status, anthropicError(type, message))
}

function blockTypes(content: unknown): string[] {
  if (typeof content === "string") return ["text"]
  if (!Array.isArray(content)) return []
  return content.map(block => (block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string" ? (block as { type: string }).type : "?"))
}

function summarizeBody(summary: RequestSummary, body: unknown): void {
  if (!body || typeof body !== "object") return
  const value = body as Record<string, unknown>
  summary.stream = value.stream === true
  if (Array.isArray(value.tools)) summary.toolNames = value.tools.map(tool => {
    const name = (tool as { name?: unknown } | null)?.name
    return typeof name === "string" ? name : "?"
  })
  const choice = (value.tool_choice as { type?: unknown } | null)?.type
  if (typeof choice === "string") summary.toolChoice = choice
  if (value.system !== undefined) summary.systemBlocks = typeof value.system === "string" ? 1 : Array.isArray(value.system) ? value.system.length : 0
  if (Array.isArray(value.messages)) {
    summary.messages = value.messages.map(message => {
      const { role, content } = (message as { role?: unknown; content?: unknown } | null) ?? {}
      return { role: typeof role === "string" ? role : "?", blocks: blockTypes(content) }
    })
    summary.toolResultIds = value.messages.flatMap(message => {
      const content = (message as { content?: unknown })?.content
      return Array.isArray(content)
        ? content.filter(block => block?.type === "tool_result" && typeof block.tool_use_id === "string").map(block => block.tool_use_id as string)
        : []
    })
  }
}

function sessionKey(binding: BindingRuntime, attribution: RequestSummary["attribution"]): string | undefined {
  const session = attribution["x-session-id"]
  if (!session) return undefined
  return `${binding.spec.id}\u0000${session}\u0000${attribution["x-zcode-session-type"] ?? "other"}`
}

export function startBridgeServer(options: BridgeServerOptions): BridgeServer {
  let generation = options.generation
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  // Retention is fixed for the listener's lifetime; reloads that change it are refused.
  const catalog = createSessionToolCatalog(generation.config.limits.maxSessions)
  const active = new Set<AbortController>()
  const requestLogKey = randomBytes(32)
  let stopping = false
  const { host, port: configuredPort } = generation.config.listen
  const allowedHosts = (port: number) => new Set([
    `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`,
  ])

  const finish = (summary: RequestSummary, started: number, status: number, extra: Partial<RequestRecord> = {}) => {
    const record: RequestRecord = { ...summary, status, durationMs: Date.now() - started, ...extra }
    const requestId = record.attribution["x-request-id"]
    log([
      "ocp-zcode",
      `v=${OCP_VERSION}`,
      `gen=${generation.id}`,
      `route=${["/v1/messages", "/v1/models", "/health"].includes(record.route) ? record.route : "unknown"}`,
      ...(record.binding ? [`binding=${record.binding}`] : []),
      ...(record.model ? [`model=${JSON.stringify(record.model)}`] : []),
      ...(requestId ? [`request=hmac:${createHmac("sha256", requestLogKey).update(requestId).digest("hex").slice(0, 16)}`] : []),
      `status=${record.status}`,
      ...(record.errorCode ? [`error=${record.errorCode}`] : []),
      ...(record.stopReason ? [`stop=${record.stopReason}`] : []),
      ...(record.closedByClient ? ["closed-by-client"] : []),
      ...(record.ignoredFields?.length ? [`unmapped=${record.ignoredFields.join(",")}`] : []),
      `ms=${record.durationMs}`,
    ].join(" "))
    options.observer?.(record)
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: host,
      port: configuredPort,
      maxRequestBodySize: generation.config.limits.maxBodyBytes,
      // Streams may idle while a provider thinks; pings keep them alive.
      idleTimeout: 0,
      fetch: request => handle(request),
    })
  } catch (error) {
    throw new ListenerConflictError(host, configuredPort, error)
  }
  const port = server.port ?? configuredPort

  async function handle(request: Request): Promise<Response> {
    const started = Date.now()
    const url = new URL(request.url)
    const attribution: RequestSummary["attribution"] = {}
    for (const name of ZCODE_ATTRIBUTION_HEADERS) {
      const value = request.headers.get(name)
      if (value) attribution[name] = value
    }
    const protocol: RequestSummary["protocol"] = {}
    for (const name of PROTOCOL_HEADERS) {
      const value = request.headers.get(name)
      if (value) protocol[name] = value
    }
    const summary: RequestSummary = {
      route: url.pathname,
      method: request.method,
      headerNames: [...request.headers.keys()].map(name => name.toLowerCase()).sort(),
      attribution,
      protocol,
    }
    // Until the body is read, its bytes may still be in flight on this socket.
    // A response sent before then closes the connection (RFC 9112 §9.6), so no
    // client reuses a socket whose next "request" would be leftover body.
    let bodyConsumed = request.body === null
    const reject = (status: number, type: AnthropicErrorType, code: string, message: string) => {
      finish(summary, started, status, { errorCode: code })
      const response = errorResponse(status, type, message)
      if (!bodyConsumed) response.headers.set("connection", "close")
      return response
    }

    if (!allowedHosts(port).has(request.headers.get("host") ?? "")) {
      return reject(421, "invalid_request_error", "host", "ocp: request Host is not this loopback listener")
    }
    if (request.headers.get("origin") !== null) {
      return reject(403, "permission_error", "origin", "ocp: browser-originated requests are not accepted")
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json(200, { ok: !stopping, generation: generation.id, version: OCP_VERSION })
    }
    const isMessages = url.pathname === "/v1/messages"
    const isModels = url.pathname === "/v1/models"
    if (!isMessages && !isModels) return reject(404, "not_found_error", "route", `ocp: no route for ${request.method} ${url.pathname}`)
    if ((isMessages && request.method !== "POST") || (isModels && request.method !== "GET")) {
      return reject(405, "invalid_request_error", "method", `ocp: ${request.method} is not supported on ${url.pathname}`)
    }
    if (stopping) return reject(503, "overloaded_error", "stopping", "ocp: bridge is shutting down")

    const presented = presentedCredential(request.headers)
    if (presented.kind !== "one") {
      return reject(401, "authentication_error", presented.kind === "none" ? "auth-missing" : "auth-conflict",
        presented.kind === "none" ? "ocp: missing bridge credential" : "ocp: x-api-key and Authorization disagree, or Authorization is not a Bearer credential")
    }
    const current = generation
    const binding = bindingForModelCredential(current, presented.value)
    if (!binding) return reject(401, "authentication_error", "auth-invalid", "ocp: invalid bridge credential")
    summary.binding = binding.spec.id

    if (isModels) {
      const data = [...binding.routes.values()].map(route => ({
        type: "model", id: route.model.alias, display_name: route.model.name, created_at: "1970-01-01T00:00:00Z",
      }))
      finish(summary, started, 200)
      return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
    }

    if (active.size >= current.config.limits.maxConcurrentRequests) {
      return reject(429, "rate_limit_error", "concurrency", "ocp: too many concurrent requests")
    }
    // Reserve the attempt slot before awaiting the body, so concurrent requests
    // cannot all pass the limit check. Every exit below releases it once.
    const controller = new AbortController()
    let released = false
    const release = () => {
      if (released) return
      released = true
      active.delete(controller)
      request.signal.removeEventListener("abort", onAbort)
    }
    // A client that leaves before the body is consumed never pulls or cancels
    // the response stream, so the abort itself releases the attempt slot.
    const onAbort = () => {
      controller.abort(request.signal.reason)
      release()
    }
    request.signal.addEventListener("abort", onAbort, { once: true })
    active.add(controller)
    // Set once a response path owns `release` (and aborting on failure).
    let handedOff = false

    try {
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > current.config.limits.maxBodyBytes) {
        return reject(413, "request_too_large", "body-size", `ocp: request body exceeds ${current.config.limits.maxBodyBytes} bytes`)
      }
      let body: unknown
      try {
        body = await request.json()
        bodyConsumed = true
      } catch {
        bodyConsumed = true
        return reject(400, "invalid_request_error", "json", "ocp: request body is not valid JSON")
      }
      summarizeBody(summary, body)

      let parsed: ReturnType<typeof parseMessagesRequest>
      try {
        parsed = parseMessagesRequest(body)
      } catch (error) {
        return reject(400, "invalid_request_error", "translate", `ocp: ${error instanceof Error ? error.message : String(error)}`)
      }
      const route = binding.routes.get(parsed.model)
      if (!route) return reject(404, "not_found_error", "model", `ocp: unknown model "${parsed.model}" for this credential`)
      summary.model = route.model.alias
      if (route.plugin?.authReadiness() === "login-required") {
        return reject(403, "permission_error", "login-required",
          `ocp: upstream login required — run: ocp zcode auth --binding ${binding.spec.id} --plugin ${route.plugin.spec.id}`)
      }

      let toolMap: ReturnType<ReturnType<typeof createSessionToolCatalog>>
      let callOptions: LanguageModelV3CallOptions
      try {
        // The catalog is frozen per (binding, ZCode session, session type) inside OCP.
        // The session is not forwarded: ZCode's request carries no verified workspace
        // identity, so no canonical x-opencode-session-id is asserted to the provider.
        toolMap = catalog(parsed.nativeTools, sessionKey(binding, attribution))
        const built = parsed.build(toolMap)
        callOptions = built.options
        if (built.ignored.length > 0) summary.ignoredFields = built.ignored
      } catch (error) {
        const known = error instanceof RequestTranslationError || error instanceof ToolMappingError
        return reject(400, "invalid_request_error", "translate", `ocp: ${known ? error.message : String(error)}`)
      }
      callOptions = { ...callOptions, abortSignal: controller.signal, headers: {} }
      const providerOptions = route.providerOptions()
      if (providerOptions) callOptions.providerOptions = providerOptions as LanguageModelV3CallOptions["providerOptions"]

      const run = <T>(work: () => Promise<T>) => route.plugin ? route.plugin.withAuthOperation(work) : work()
      return await run(async () => {
        let model: LanguageModelV3
        try {
          model = await route.languageModel()
        } catch (error) {
          return reject(502, "api_error", "provider-resolve", `ocp: provider model could not be created: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (parsed.stream) {
          const response = await streamResponse(model, parsed.model, toolMap, callOptions, controller, release, summary, started)
          handedOff = true
          return response
        }
        return generateResponse(model, parsed.model, toolMap, callOptions, controller, release, summary, started)
      })
    } catch (error) {
      controller.abort(error)
      return reject(500, "api_error", "internal", `ocp: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (!handedOff) release()
    }
  }

  async function streamResponse(
    model: LanguageModelV3,
    alias: string,
    toolMap: ReturnType<ReturnType<typeof createSessionToolCatalog>>,
    callOptions: LanguageModelV3CallOptions,
    controller: AbortController,
    release: () => void,
    summary: RequestSummary,
    started: number,
  ): Promise<Response> {
    let result: Awaited<ReturnType<LanguageModelV3["doStream"]>>
    try {
      result = await model.doStream(callOptions)
    } catch (error) {
      const closed = controller.signal.aborted
      // Stop anything the provider started for this attempt.
      controller.abort(error)
      release()
      if (closed) {
        finish(summary, started, 499, { errorCode: "client-closed", closedByClient: true })
        return errorResponse(499, "api_error", "ocp: client closed the request")
      }
      finish(summary, started, 502, { errorCode: "provider" })
      return errorResponse(502, "api_error", `ocp: provider request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const stream = encodeAnthropicStream({
      model: alias,
      toolMap,
      parts: result.stream,
      signal: controller.signal,
      ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
      onOutcome: (outcome: StreamOutcome) => {
        const closed = outcome.aborted || controller.signal.aborted
        // A failed or abandoned stream stops the provider's work; a completed
        // one leaves provider-owned continuation state alone.
        if ((closed || outcome.error !== undefined) && !controller.signal.aborted) controller.abort()
        release()
        finish(summary, started, 200, {
          ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.error ? { errorCode: "stream" } : {}),
          ...(outcome.toolCallIds.length ? { toolCallIds: outcome.toolCallIds } : {}),
          ...(closed ? { closedByClient: true } : {}),
        })
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
    })
  }

  async function generateResponse(
    model: LanguageModelV3,
    alias: string,
    toolMap: ReturnType<ReturnType<typeof createSessionToolCatalog>>,
    callOptions: LanguageModelV3CallOptions,
    controller: AbortController,
    release: () => void,
    summary: RequestSummary,
    started: number,
  ): Promise<Response> {
    try {
      const result = typeof model.doGenerate === "function"
        ? await model.doGenerate(callOptions)
        : await collectStream((await model.doStream(callOptions)).stream, controller.signal)
      const encoded = encodeAnthropicMessage(alias, toolMap, result)
      finish(summary, started, 200, { stopReason: encoded.stopReason, ...(encoded.toolCallIds.length ? { toolCallIds: encoded.toolCallIds } : {}) })
      return json(200, encoded.body)
    } catch (error) {
      const closed = controller.signal.aborted
      controller.abort(error)
      if (closed) {
        finish(summary, started, 499, { errorCode: "client-closed", closedByClient: true })
        return errorResponse(499, "api_error", "ocp: client closed the request")
      }
      const mapping = error instanceof ToolMappingError
      finish(summary, started, 502, { errorCode: mapping ? "tool-mapping" : "provider" })
      return errorResponse(502, "api_error", `ocp: ${mapping ? "invalid tool call" : "provider request failed"}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      release()
    }
  }

  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/v1`,
    port,
    generation: () => generation,
    publish(next) {
      generation = next
    },
    async stop() {
      stopping = true
      for (const controller of active) controller.abort(new Error("ocp: bridge shutting down"))
      active.clear()
      await server.stop(true)
    },
  }
}
