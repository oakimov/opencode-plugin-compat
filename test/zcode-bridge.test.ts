/**
 * External ZCode bridge: config, tool mapping, request translation and the
 * real Anthropic Messages wire, driven by `@ai-sdk/anthropic@3.0.81` — the
 * client ZCode 3.18.2 builds its Personal-provider transport from
 * (apps/zcode-cli/packages/adapters/src/model/model-execution.ts:341-349).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  buildGeneration,
  createProbeFile,
  createProbeModel,
  createSessionToolCatalog,
  DEFAULT_LIMITS,
  parseMessagesRequest,
  parseZcodeBridgeConfig,
  PROBE_MODEL_ALIAS,
  startBridgeServer,
  ZcodeConfigError,
  type BridgeServer,
  type RequestRecord,
  type ZcodeBridgeConfig,
  type ZcodePaths,
} from "../packages/cli/src/zcode/index.ts"
import { DurableAuthStore, generationAuthView } from "../packages/cli/src/zcode/auth-store.ts"
import { probeResultMatches, PROBE_MODEL_INFO } from "../packages/cli/src/zcode/probe.ts"
import { LOOP_CALL_ID, recordedCalls } from "./fixtures/zcode-loop-provider.ts"

const ACME = resolve(import.meta.dir, "fixtures/pi-bridge-acme-provider.ts")
const LOOP = resolve(import.meta.dir, "fixtures/zcode-loop-provider.ts")
const CREDENTIAL = "ocpz_test_credential_0123456789abcdef"
const OTHER_CREDENTIAL = "ocpz_test_credential_fedcba9876543210"

/** ZCode Read provider schema shape (contracts/src/tools/read.ts:65-94). */
const ZCODE_READ_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "The absolute path to the file to read" },
    offset: { type: "integer", minimum: 0, description: "The line number to start reading from" },
    limit: { type: "integer", exclusiveMinimum: 0, description: "The number of lines to read" },
  },
  required: ["file_path"],
  additionalProperties: false,
}

const VALID_CONFIG = {
  version: 1,
  listen: { host: "127.0.0.1", port: 18731 },
  bindings: [{
    id: "main",
    workspace: "/work/a",
    credentials: { model: { env: "OCP_MODEL" }, mcp: { env: "OCP_MCP" } },
    plugins: [{ id: "acme", package: "acme-provider", version: "1.2.3", contract: "classic", models: [{ alias: "acme-large", upstream: "acme-large" }] }],
  }],
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function configError(raw: unknown): string {
  try {
    parseZcodeBridgeConfig(raw)
  } catch (error) {
    expect(error).toBeInstanceOf(ZcodeConfigError)
    return (error as Error).message
  }
  throw new Error("expected a config error")
}

describe("zcode bridge config", () => {
  test("accepts a valid config and fills defaults", () => {
    const config = parseZcodeBridgeConfig(VALID_CONFIG)
    expect(config.limits).toEqual(DEFAULT_LIMITS)
    expect(config.bindings[0]!.plugins[0]!.models).toEqual([{ alias: "acme-large", upstream: "acme-large" }])
  })

  test("rejects unknown, conflicting and duplicate entries with their JSON path", () => {
    const unknown = clone(VALID_CONFIG) as Record<string, unknown>
    ;(unknown.bindings as Array<Record<string, unknown>>)[0]!.extra = true
    expect(configError(unknown)).toContain("$.bindings[0].extra: unknown field")

    const remote = clone(VALID_CONFIG)
    remote.listen.host = "0.0.0.0"
    expect(configError(remote)).toContain("$.listen.host: must be a loopback address")

    const duplicateAlias = clone(VALID_CONFIG)
    duplicateAlias.bindings[0]!.plugins.push({ ...duplicateAlias.bindings[0]!.plugins[0]!, id: "acme2" })
    expect(configError(duplicateAlias)).toContain("duplicate model alias \"acme-large\" (already used by plugin \"acme\")")

    const duplicateBinding = clone(VALID_CONFIG)
    duplicateBinding.bindings.push({ ...clone(VALID_CONFIG.bindings[0]!), credentials: { model: { env: "OTHER" }, mcp: { env: "OTHER_MCP" } } })
    expect(configError(duplicateBinding)).toContain("$.bindings[1].id: duplicate binding id \"main\"")

    const sharedCredential = clone(VALID_CONFIG)
    sharedCredential.bindings.push({ ...clone(VALID_CONFIG.bindings[0]!), id: "second" })
    expect(configError(sharedCredential)).toContain("credential reference is already used by binding \"main\" (model)")

    const sameRoute = clone(VALID_CONFIG)
    sameRoute.bindings[0]!.credentials.mcp = { env: "OCP_MODEL" }
    expect(configError(sameRoute)).toContain("must differ from credentials.model")

    const ranged = clone(VALID_CONFIG)
    ranged.bindings[0]!.plugins[0]!.version = "^1.2.3"
    expect(configError(ranged)).toContain("an exact version")

    const contract = clone(VALID_CONFIG) as unknown as { bindings: Array<{ plugins: Array<{ contract: string }> }> }
    contract.bindings[0]!.plugins[0]!.contract = "v3"
    expect(configError(contract)).toContain("must be one of classic, promise-1.18, server-2")
  })
})

describe("zcode tool catalog mapping", () => {
  const read = { name: "Read", description: "native read", input_schema: ZCODE_READ_SCHEMA }
  const grep = { name: "Grep", description: "native grep", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } }
  const mcp = { name: "mcp__acme__lookup", input_schema: { type: "object", properties: {} } }

  test("maps verified native Read to canonical read and passes every other tool through", () => {
    const map = createSessionToolCatalog()([read, grep, mcp], undefined)
    expect(map.tools.map(tool => tool.name)).toEqual(["Grep", "mcp__acme__lookup", "read"])
    expect(map.tools.find(tool => tool.name === "read")!.inputSchema).toMatchObject({ required: ["filePath"] })
    expect(map.toNativeCall("read", JSON.stringify({ filePath: "/a.ts", offset: 2, limit: 3 }))).toEqual({
      name: "Read", input: JSON.stringify({ file_path: "/a.ts", offset: 2, limit: 3 }),
    })
    expect(map.toNativeCall("Grep", "{\"pattern\":\"x\"}")).toEqual({ name: "Grep", input: "{\"pattern\":\"x\"}" })
    expect(map.canonicalName("Read")).toBe("read")
    expect(map.canonicalInput("Read", { file_path: "/a.ts", pages: "1" })).toEqual({ filePath: "/a.ts", pages: "1" })
  })

  test("rejects lossy, invalid and unadvertised calls before they reach ZCode", () => {
    const map = createSessionToolCatalog()([read], undefined)
    expect(() => map.toNativeCall("read", JSON.stringify({ filePath: "/a", pages: "1" }))).toThrow("no native field for pages")
    expect(() => map.toNativeCall("read", JSON.stringify({ filePath: "/a", offset: 0 }))).toThrow("offset must be an integer >= 1")
    expect(() => map.toNativeCall("read", "not json")).toThrow("not valid JSON")
    expect(() => map.toNativeCall("write", "{}")).toThrow("did not advertise")
  })

  test("a native Read whose schema drifted from the verified shape passes through unmapped", () => {
    const drifted = { ...read, input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
    const map = createSessionToolCatalog()([drifted], undefined)
    expect(map.tools.map(tool => tool.name)).toEqual(["Read"])
    expect(map.canonicalName("Read")).toBe("Read")
    expect(map.toNativeCall("Read", "{\"path\":\"/a\"}")).toEqual({ name: "Read", input: "{\"path\":\"/a\"}" })
  })

  test("freezes the first catalog per session, appends sorted newcomers and keeps lifecycle catalogs empty", () => {
    const catalog = createSessionToolCatalog()
    const z = { name: "zeta", input_schema: { type: "object" } }
    const a = { name: "alpha", input_schema: { type: "object" } }
    expect(catalog([z], "s1").tools.map(tool => tool.name)).toEqual(["zeta"])
    expect(catalog([a, z], "s1").tools.map(tool => tool.name)).toEqual(["zeta", "alpha"])
    expect(catalog([], "s1").tools).toEqual([])
    expect(catalog([a, z], "s1").tools.map(tool => tool.name)).toEqual(["zeta", "alpha"])
    expect(catalog([a, z], "s2").tools.map(tool => tool.name)).toEqual(["alpha", "zeta"])
  })

  test("same-name schema drift fails closed on a call; collisions are explicit", () => {
    const catalog = createSessionToolCatalog()
    catalog([{ name: "x", input_schema: { type: "object", properties: { a: { type: "string" } } } }], "s")
    const later = catalog([{ name: "x", input_schema: { type: "object", properties: { b: { type: "string" } } } }], "s")
    expect(() => later.toNativeCall("x", "{}")).toThrow("changed its schema during the session")
    expect(() => catalog([read, { name: "read", input_schema: { type: "object" } }], undefined)).toThrow("tool name collision")
  })
})

describe("zcode request translation", () => {
  const tools = [{ name: "Read", input_schema: ZCODE_READ_SCHEMA }]
  const build = (body: Record<string, unknown>) => {
    const parsed = parseMessagesRequest({ model: "m", max_tokens: 100, ...body })
    return parsed.build(createSessionToolCatalog()(parsed.nativeTools, undefined))
  }

  test("preserves system blocks, mid-conversation system notes, order and structured tool results", () => {
    const { options, ignored } = build({
      system: [{ type: "text", text: "sys one", cache_control: { type: "ephemeral" } }, { type: "text", text: "sys two" }],
      tools,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1\tline" }] },
          { type: "text", text: "and then?" },
        ] },
        { role: "system", content: "mid note" },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/missing" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "File does not exist." }] },
      ],
    })
    expect(ignored).toEqual(["thinking"])
    expect(options.prompt).toEqual([
      { role: "system", content: "sys one" },
      { role: "system", content: "sys two" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "tool-call", toolCallId: "t1", toolName: "read", input: { filePath: "/a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read", output: { type: "text", value: "1\tline" } }] },
      { role: "user", content: [{ type: "text", text: "and then?" }] },
      { role: "system", content: "mid note" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t2", toolName: "read", input: { filePath: "/missing" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", toolName: "read", output: { type: "error-text", value: "File does not exist." } }] },
    ])
    expect(options.tools?.map(tool => tool.name)).toEqual(["read"])
    expect(options.maxOutputTokens).toBe(100)
  })

  test("maps tool choice, images and JSON output; rejects unsupported paths explicitly", () => {
    const { options } = build({
      tools,
      tool_choice: { type: "tool", name: "Read" },
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
    })
    expect(options.toolChoice).toEqual({ type: "tool", toolName: "read" })
    expect(options.responseFormat).toEqual({ type: "json", schema: { type: "object" } })
    expect(options.prompt[0]).toEqual({ role: "user", content: [{ type: "file", mediaType: "image/png", data: "AAAA" }] })

    expect(() => build({ mcp_servers: [], messages: [] })).toThrow("mcp_servers: unsupported request field")
    expect(() => build({ messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }] }))
      .toThrow("unsupported assistant content block \"server_tool_use\"")
    expect(() => build({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] }] }))
      .toThrow("references no earlier tool_use")
    expect(() => build({ tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [] })).toThrow("provider-defined tool type")
  })
})

describe("zcode auth store", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ocp-zcode-auth-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("an in-flight loader never reseeds a stale credential over a newer login", async () => {
    const store = new DurableAuthStore(join(dir, "a.json"))
    await store.replace({ type: "oauth", access: "v1", refresh: "r", expires: 1 })
    const inFlight = generationAuthView(store)
    expect(await inFlight.get()).toMatchObject({ access: "v1" })
    await store.replace({ type: "oauth", access: "login-v2", refresh: "r2", expires: 2 })
    await inFlight.set({ type: "oauth", access: "refreshed-from-v1", refresh: "r", expires: 3 })
    expect(store.read().auth).toMatchObject({ access: "login-v2" })

    const fresh = generationAuthView(store)
    await fresh.get()
    await fresh.set({ type: "oauth", access: "refreshed-from-v2", refresh: "r2", expires: 4 })
    await fresh.set({ type: "oauth", access: "refreshed-again", refresh: "r2", expires: 5 })
    expect(store.read().auth).toMatchObject({ access: "refreshed-again" })
  })
})

type Harness = { server: BridgeServer; records: RequestRecord[]; dir: string; paths: ZcodePaths }

async function startHarness(extra: { probe?: ReturnType<typeof createProbeModel>; seedAcme?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-wire-"))
  const paths: ZcodePaths = { configFile: join(dir, "config.json"), installRoot: join(dir, "plugins"), stateDir: join(dir, "state"), cacheDir: join(dir, "cache") }
  const config: ZcodeBridgeConfig = {
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    limits: { ...DEFAULT_LIMITS, maxConcurrentRequests: 4 },
    bindings: [
      {
        id: "main",
        workspace: dir,
        credentials: { model: { env: "MODEL_CREDENTIAL" } },
        plugins: [
          { id: "loop", package: "zcode-loop-provider", version: "1.0.0", contract: "classic", models: [
            { alias: "loop", upstream: "loop-1" }, { alias: "plain", upstream: "plain" },
            { alias: "slow", upstream: "slow" }, { alias: "truncated", upstream: "truncated" },
          ] },
          { id: "acme", package: "pi-bridge-acme-provider", version: "1.0.0", contract: "classic", models: [{ alias: "acme", upstream: "acme-large" }] },
        ],
      },
      { id: "other", workspace: join(dir, "other"), credentials: { model: { env: "OTHER_CREDENTIAL" } }, plugins: [] },
    ],
  }
  if (extra.seedAcme) {
    await DurableAuthStore.forPlugin(paths.stateDir, "main", "acme", "acme").replace({ type: "oauth", access: "acme-access-token", refresh: "acme-refresh-token", expires: 1 })
  }
  const generation = await buildGeneration(config, {
    paths,
    env: { MODEL_CREDENTIAL: CREDENTIAL, OTHER_CREDENTIAL },
    resolvePackage: spec => ({ name: spec.package, version: spec.version, entry: spec.id === "loop" ? LOOP : ACME, sha256: `sha-${spec.id}` }),
    ...(extra.probe ? { staticRoutes: new Map([["other", [{ info: PROBE_MODEL_INFO, languageModel: async () => extra.probe! }]]]) } : {}),
  })
  const records: RequestRecord[] = []
  const server = startBridgeServer({ generation, log: () => {}, observer: record => records.push(record), pingIntervalMs: 0 })
  return { server, records, dir, paths }
}

/** ZCode's construction: SDK x-api-key plus an explicit Bearer header. */
function zcodeClient(server: BridgeServer, credential = CREDENTIAL) {
  return createAnthropic({ baseURL: server.url, apiKey: credential, headers: { Authorization: `Bearer ${credential}` } })
}

const ZCODE_HEADERS = {
  "x-session-id": "parent-123",
  "x-zcode-session-type": "main",
  "x-zcode-query-source": "repl_main_thread",
  "x-request-id": "req-1",
  "x-zcode-trace-id": "trace-1",
}

const READ_TOOL = { type: "function" as const, name: "Read", description: "Read a file", inputSchema: ZCODE_READ_SCHEMA as never }

async function drain(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

describe("zcode bridge on the Anthropic Messages wire", () => {
  let harness: Harness
  beforeAll(async () => {
    harness = await startHarness({ seedAcme: true, probe: createProbeModel(createProbeFile(mkdtempSync(join(tmpdir(), "ocp-zcode-probe-")))) })
  })
  afterAll(async () => {
    await harness.server.stop()
    rmSync(harness.dir, { recursive: true, force: true })
  })
  afterEach(() => {
    recordedCalls().length = 0
  })

  test("native Read round trip keeps the call id, maps both directions and forwards no ZCode headers", async () => {
    const model = zcodeClient(harness.server).languageModel("loop")
    const turn1 = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [READ_TOOL],
      headers: ZCODE_HEADERS,
    } as LanguageModelV3CallOptions)
    const parts1 = await drain(turn1.stream)
    const call = parts1.find(part => part.type === "tool-call")
    expect(call).toMatchObject({ type: "tool-call", toolCallId: LOOP_CALL_ID, toolName: "Read" })
    expect(JSON.parse((call as { input: string }).input)).toEqual({ file_path: "/tmp/ocp-loop.txt", offset: 1, limit: 5 })
    expect(parts1.find(part => part.type === "finish")).toMatchObject({ finishReason: { unified: "tool-calls", raw: "tool_use" } })

    const seen1 = recordedCalls()[0]!
    expect(seen1.tools?.map(tool => tool.name)).toEqual(["read"])
    expect(seen1.headers).toEqual({})

    const turn2 = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "read it" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: LOOP_CALL_ID, toolName: "Read", input: { file_path: "/tmp/ocp-loop.txt", offset: 1, limit: 5 } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: LOOP_CALL_ID, toolName: "Read", output: { type: "text", value: "hello" } }] },
      ],
      tools: [READ_TOOL],
      headers: { ...ZCODE_HEADERS, "x-request-id": "req-2" },
    } as LanguageModelV3CallOptions)
    const parts2 = await drain(turn2.stream)
    expect(parts2.filter(part => part.type === "text-delta").map(part => (part as { delta: string }).delta).join("")).toBe("FINAL:hello")
    const finish = parts2.find(part => part.type === "finish") as { finishReason: unknown; usage: { inputTokens: Record<string, unknown> } }
    expect(finish.finishReason).toMatchObject({ unified: "stop", raw: "end_turn" })
    expect(finish.usage.inputTokens).toMatchObject({ noCache: 10, cacheRead: 2 })

    const seen2 = recordedCalls()[1]!
    expect(seen2.prompt[1]).toEqual({ role: "assistant", content: [{ type: "tool-call", toolCallId: LOOP_CALL_ID, toolName: "read", input: { filePath: "/tmp/ocp-loop.txt", offset: 1, limit: 5 } }] })
    expect(seen2.prompt[2]).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: LOOP_CALL_ID, toolName: "read", output: { type: "text", value: "hello" } }] })

    const records = harness.records.filter(record => record.model === "loop")
    expect(records.map(record => [record.stopReason, record.attribution["x-request-id"]])).toEqual([["tool_use", "req-1"], ["end_turn", "req-2"]])
    expect(records[0]!.attribution["x-session-id"]).toBe("parent-123")
    expect(records[1]!.toolResultIds).toEqual([LOOP_CALL_ID])
  })

  test("non-streaming uses doGenerate and returns the same native call", async () => {
    const result = await zcodeClient(harness.server).languageModel("loop").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
      tools: [READ_TOOL],
    } as LanguageModelV3CallOptions)
    expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
    const call = result.content.find(part => part.type === "tool-call") as { toolCallId: string; toolName: string; input: string }
    expect([call.toolCallId, call.toolName, JSON.parse(call.input)]).toEqual([LOOP_CALL_ID, "Read", { file_path: "/tmp/ocp-loop.txt", offset: 1, limit: 5 }])
  })

  test("unchanged Acme fixture: catalog, durable auth through its own loader, text in both modes", async () => {
    const model = zcodeClient(harness.server).languageModel("acme")
    const streamed = await drain((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions)).stream)
    expect(streamed.filter(part => part.type === "text-delta").map(part => (part as { delta: string }).delta).join("")).toBe("hello from generic provider")
    // Acme has no doGenerate: the bridge aggregates its stream for a JSON response.
    const generated = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions)
    expect(generated.content).toEqual([{ type: "text", text: "hello from generic provider" }])
    // Acme's auth.loader renewed and persisted its token through client.auth.set.
    const stored = DurableAuthStore.forPlugin(harness.paths.stateDir, "main", "acme", "acme").read()
    expect(stored.auth).toMatchObject({ type: "oauth", access: "acme-access-token-v2" })
    const models = await fetch(`${harness.server.url}/models`, { headers: { "x-api-key": CREDENTIAL } }).then(response => response.json()) as { data: Array<{ id: string; display_name: string }> }
    expect(models.data.find(entry => entry.id === "acme")?.display_name).toBe("Acme Large")
  })

  test("the credential selects the binding; missing, conflicting and foreign requests are refused", async () => {
    const body = JSON.stringify({ model: "loop", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    const post = (headers: Record<string, string>) => fetch(`${harness.server.url}/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
    expect((await post({})).status).toBe(401)
    expect((await post({ "x-api-key": "ocpz_wrong_credential_000000000000" })).status).toBe(401)
    expect((await post({ "x-api-key": CREDENTIAL, authorization: `Bearer ${OTHER_CREDENTIAL}` })).status).toBe(401)
    expect((await post({ "x-api-key": CREDENTIAL, origin: "https://evil.example" })).status).toBe(403)
    expect((await post({ "x-api-key": CREDENTIAL, host: "evil.example" })).status).toBe(421)
    // The other binding's credential cannot reach this binding's models.
    const foreign = await post({ "x-api-key": OTHER_CREDENTIAL })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } })
    const bad = await fetch(`${harness.server.url}/messages`, { method: "POST", headers: { "x-api-key": CREDENTIAL }, body: JSON.stringify({ model: "loop", max_tokens: 10, messages: [], mcp_servers: [] }) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { type: "invalid_request_error", message: "ocp: mcp_servers: unsupported request field" } })
  })

  test("client disconnect aborts the provider call", async () => {
    const controller = new AbortController()
    const model = zcodeClient(harness.server).languageModel("slow")
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], abortSignal: controller.signal } as LanguageModelV3CallOptions)
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done || next.value.type === "text-delta") break
    }
    controller.abort()
    await reader.cancel().catch(() => undefined)
    const signal = recordedCalls()[0]!.abortSignal!
    for (let i = 0; i < 50 && !signal.aborted; i++) await Bun.sleep(10)
    expect(signal.aborted).toBe(true)
  })

  test("a provider stream that ends without finish surfaces an error, not a successful stop", async () => {
    const model = zcodeClient(harness.server).languageModel("truncated")
    const parts = await drain((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions)).stream)
    expect(parts.some(part => part.type === "error")).toBe(true)
    const finish = parts.find(part => part.type === "finish") as { finishReason: { unified: string } } | undefined
    expect(finish === undefined || finish.finishReason.unified === "error").toBe(true)
  })

  test("Step 0 probe: plain text, then a native Read whose replayed result yields the marker", async () => {
    const probeFile = createProbeFile(mkdtempSync(join(tmpdir(), "ocp-zcode-probe2-")))
    const probe = createProbeModel(probeFile)
    const local = await startHarness({ probe })
    try {
      const model = zcodeClient(local.server, OTHER_CREDENTIAL).languageModel(PROBE_MODEL_ALIAS)
      const text = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [READ_TOOL] } as LanguageModelV3CallOptions)
      expect(text.content).toEqual([{ type: "text", text: "OCP-PROBE-TEXT" }])

      const turn1 = await drain((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "please OCP probe read" }] }], tools: [READ_TOOL] } as LanguageModelV3CallOptions)).stream)
      const call = turn1.find(part => part.type === "tool-call") as { toolCallId: string; toolName: string; input: string }
      expect([call.toolCallId, call.toolName, JSON.parse(call.input)]).toEqual([probe.callId, "Read", { file_path: probeFile.path }])

      const turn2 = await drain((await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "please OCP probe read" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "Read", input: JSON.parse(call.input) }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "Read", output: { type: "text", value: `     1\t${probeFile.contents}` } }] },
        ],
        tools: [READ_TOOL],
      } as LanguageModelV3CallOptions)).stream)
      expect(turn2.filter(part => part.type === "text-delta").map(part => (part as { delta: string }).delta).join("")).toBe("OCP-PROBE-OK")
      expect(probe.verdicts).toEqual(["text", "read-requested", "tool-result-match"])
      // The transcript carries structure, not prompt text or file contents.
      expect(JSON.stringify(local.records)).not.toContain(probeFile.contents)
      expect(JSON.stringify(local.records)).not.toContain("please OCP probe read")
    } finally {
      await local.server.stop()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })
})

describe("zcode probe matching", () => {
  test("accepts raw or one numbered line of exactly the contents", () => {
    expect(probeResultMatches("abc", "abc")).toBe(true)
    expect(probeResultMatches("     1\tabc\n", "abc")).toBe(true)
    expect(probeResultMatches("1→abc", "abc")).toBe(true)
    expect(probeResultMatches("abcd", "abc")).toBe(false)
  })
})

describe("zcode generation build", () => {
  test("unsupported contracts, missing credentials and duplicate secrets are attributable readiness failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-gen-"))
    try {
      const paths: ZcodePaths = { configFile: "", installRoot: join(dir, "plugins"), stateDir: join(dir, "state"), cacheDir: join(dir, "cache") }
      const credentialFile = join(dir, "cred")
      writeFileSync(credentialFile, `${CREDENTIAL}\n`)
      const config = parseZcodeBridgeConfig({
        version: 1,
        bindings: [
          { id: "a", workspace: dir, credentials: { model: { file: credentialFile } }, plugins: [
            { id: "p2", package: "x", version: "1.0.0", contract: "server-2", models: [{ alias: "m", upstream: "m" }] },
            { id: "absent", package: "not-installed-pkg", version: "1.0.0", contract: "classic", models: [{ alias: "n", upstream: "n" }] },
          ] },
          { id: "b", workspace: dir, credentials: { model: { env: "SAME" } }, plugins: [
            { id: "q", package: "y", version: "1.0.0", contract: "promise-1.18", models: [{ alias: "m", upstream: "m" }] },
          ] },
          { id: "c", workspace: dir, credentials: { model: { env: "UNSET" } }, plugins: [
            { id: "r", package: "y", version: "1.0.0", contract: "classic", models: [{ alias: "m", upstream: "m" }] },
          ] },
        ],
      })
      const error = await buildGeneration(config, { paths, env: { SAME: CREDENTIAL } }).then(() => undefined, (failure: unknown) => failure as { issues: Array<{ binding: string; plugin?: string; code: string }> })
      expect(error?.issues.map(issue => [issue.binding, issue.plugin ?? null, issue.code])).toEqual([
        ["a", "p2", "contract-unsupported"],
        ["a", "absent", "not-installed"],
        ["b", "q", "contract-unsupported"],
        ["c", null, "credential"],
        ["b", null, "credential"],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("zcode install-root resolution", () => {
  test("records version, real entry and checksum; refuses missing, mismatched and escaping entries", async () => {
    const { resolveInstalledPackage, PluginLoadError } = await import("../packages/cli/src/zcode/plugin-host.ts")
    const root = mkdtempSync(join(tmpdir(), "ocp-zcode-root-"))
    try {
      const pkg = join(root, "node_modules", "@acme", "provider")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(join(pkg, "dist"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@acme/provider", version: "2.0.1", type: "module", exports: { ".": "./dist/index.js", "./server": "./dist/server.js" } }))
      writeFileSync(join(pkg, "dist", "index.js"), "export const x = 1\n")
      writeFileSync(join(pkg, "dist", "server.js"), "export const y = 2\n")
      const spec = { id: "p", package: "@acme/provider", version: "2.0.1", contract: "classic" as const, models: [{ alias: "a", upstream: "a" }] }
      const resolved = resolveInstalledPackage(root, spec)
      expect(resolved.entry.endsWith("/node_modules/@acme/provider/dist/index.js")).toBe(true)
      expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(resolveInstalledPackage(root, { ...spec, entry: "./server" }).entry.endsWith("/dist/server.js")).toBe(true)
      expect(() => resolveInstalledPackage(root, { ...spec, version: "2.0.0" })).toThrow("does not match the configured version 2.0.0")
      expect(() => resolveInstalledPackage(root, { ...spec, package: "@acme/absent" })).toThrow(PluginLoadError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("zcode auth view writes", () => {
  test("re-setting the unchanged credential does not advance the generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-auth2-"))
    try {
      const store = new DurableAuthStore(join(dir, "b.json"))
      await store.replace({ type: "api", key: "k1" })
      const generation = store.read().generation
      const view = generationAuthView(store)
      await view.set({ type: "api", key: "k1" })
      expect(store.read().generation).toBe(generation)
      const other = generationAuthView(store)
      await other.get()
      await other.set({ type: "api", key: "k2" })
      expect(store.read()).toMatchObject({ generation: generation + 1, auth: { key: "k2" } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
