/**
 * External ZCode bridge: config, tool mapping, request translation and the
 * real Anthropic Messages wire, driven by `@ai-sdk/anthropic@3.0.81` — the
 * client ZCode 3.18.2 builds its Personal-provider transport from
 * (apps/zcode-cli/packages/adapters/src/model/model-execution.ts:341-349).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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

  test("pass-through calls still require a complete JSON object", () => {
    const map = createSessionToolCatalog()([{ name: "Custom", input_schema: { type: "object" } }], undefined)
    expect(map.toNativeCall("Custom", '{"argument":1}')).toEqual({ name: "Custom", input: '{"argument":1}' })
    expect(() => map.toNativeCall("Custom", '{"argument":')).toThrow("not valid JSON")
    expect(() => map.toNativeCall("Custom", "[]")).toThrow("must be a JSON object")
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

async function startHarness(extra: { probe?: ReturnType<typeof createProbeModel>; seedAcme?: boolean; log?: (line: string) => void } = {}): Promise<Harness> {
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
            { alias: "error-stream", upstream: "error-stream" }, { alias: "locked-stream", upstream: "locked-stream" },
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
  const server = startBridgeServer({ generation, log: extra.log ?? (() => {}), observer: record => records.push(record), pingIntervalMs: 0 })
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
    harness = await startHarness({ seedAcme: true })
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
    // The model entry's own options reach the provider under its provider id.
    expect(seen1.providerOptions).toEqual({ loop: { wireModel: "loop-1-wire" } })

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
    const missing = await post({})
    expect(missing.status).toBe(401)
    // Refused before its body was read: the socket is not offered for reuse.
    expect(missing.headers.get("connection")).toBe("close")
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
    // The body was read, so the connection stays reusable.
    expect(bad.headers.get("connection")).not.toBe("close")
    expect(await bad.json()).toMatchObject({ error: { type: "invalid_request_error", message: "ocp: mcp_servers: unsupported request field" } })
  })

  test("malformed metadata is rejected by the translator with a 400", async () => {
    const response = await fetch(`${harness.server.url}/messages`, {
      method: "POST",
      headers: { "x-api-key": CREDENTIAL },
      body: JSON.stringify({ model: "plain", max_tokens: 10, messages: [], tool_choice: { type: { toString: 0 } } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } })
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

  test("a provider error part aborts the provider and cancels its stream", async () => {
    const model = zcodeClient(harness.server).languageModel("error-stream")
    const parts = await drain((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions)).stream)
    expect(parts.some(part => part.type === "error")).toBe(true)
    const signal = recordedCalls()[0]!.abortSignal!
    for (let i = 0; i < 50 && !signal.aborted; i++) await Bun.sleep(10)
    expect(signal.aborted).toBe(true)
  })

  test("a provider stream rejected during SSE setup releases the attempt slot", async () => {
    const attempts = harness.server.generation().config.limits.maxConcurrentRequests + 1
    for (let index = 0; index < attempts; index++) {
      const response = await fetch(`${harness.server.url}/messages`, {
        method: "POST",
        headers: { "x-api-key": CREDENTIAL },
        body: JSON.stringify({ model: "locked-stream", max_tokens: 10, stream: true, messages: [] }),
      })
      expect(response.status).toBe(500)
      await response.text()
    }
    expect(recordedCalls()).toHaveLength(attempts)
    expect(recordedCalls().every(call => call.abortSignal?.aborted)).toBe(true)
  })

  test("the concurrency limit holds while request bodies are still arriving", async () => {
    // Every body is held open, so each request is past the limit check while
    // its body is pending — the slot must already be reserved by then.
    const gates: Array<() => void> = []
    const clients: AbortController[] = []
    const send = () => {
      const client = new AbortController()
      clients.push(client)
      const payload = new TextEncoder().encode(JSON.stringify({ model: "slow", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }))
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          gates.push(() => {
            try {
              controller.enqueue(payload)
              controller.close()
            } catch {
              // Refused before its body was read: the server already closed it.
            }
          })
        },
      })
      return fetch(`${harness.server.url}/messages`, {
        method: "POST",
        headers: { "x-api-key": CREDENTIAL, "content-type": "application/json", "content-length": String(payload.length) },
        body,
        duplex: "half",
        signal: client.signal,
      } as RequestInit)
    }
    const before = harness.records.length
    const pending = Array.from({ length: 6 }, send)
    await Bun.sleep(100)
    for (const open of gates) open()
    // A refused request may surface as a 429 or, because its body was never
    // read, as a reset socket; the server's own records are authoritative.
    const settled = await Promise.allSettled(pending)
    const responses = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : [])
    expect(responses.filter(response => response.status === 200)).toHaveLength(4)
    expect(responses.every(response => response.status === 200 || response.status === 429)).toBe(true)
    const refused = harness.records.slice(before).filter(record => record.errorCode === "concurrency")
    expect(refused).toHaveLength(2)
    expect(recordedCalls().length).toBe(4)
    // Disconnect the way a client such as ZCode does: abort the fetch.
    for (const client of clients) client.abort()
    for (let i = 0; i < 200 && recordedCalls().some(call => !call.abortSignal?.aborted); i++) await Bun.sleep(10)
    expect(recordedCalls().every(call => call.abortSignal?.aborted)).toBe(true)
  })

  test("shutdown ends held streams and aborts their provider calls even when nothing is reading", async () => {
    const local = await startHarness()
    try {
      const response = await fetch(`${local.server.url}/messages`, {
        method: "POST",
        headers: { "x-api-key": CREDENTIAL, "content-type": "application/json" },
        body: JSON.stringify({ model: "slow", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(response.status).toBe(200)
      // The client keeps the connection but never reads the body.
      await local.server.stop()
      const signal = recordedCalls()[0]!.abortSignal!
      expect(signal.aborted).toBe(true)
      expect(local.records.find(record => record.model === "slow")?.closedByClient).toBe(true)
      await response.body?.cancel().catch(() => undefined)
    } finally {
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  test("a provider stream that ends without finish surfaces an error, not a successful stop", async () => {
    const model = zcodeClient(harness.server).languageModel("truncated")
    const parts = await drain((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as LanguageModelV3CallOptions)).stream)
    expect(parts.some(part => part.type === "error")).toBe(true)
    const finish = parts.find(part => part.type === "finish") as { finishReason: { unified: string } } | undefined
    expect(finish === undefined || finish.finishReason.unified === "error").toBe(true)
  })

  test("Step 0 probe: plain text, then a native Read whose replayed result yields the marker", async () => {
    const probeDir = mkdtempSync(join(tmpdir(), "ocp-zcode-probe2-"))
    const probeFile = createProbeFile(probeDir)
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
      rmSync(probeDir, { recursive: true, force: true })
    }
  })
})

describe("zcode CLI recovery", () => {
  const cli = resolve(import.meta.dir, "../packages/ocp/bin/ocp.ts")

  test("explicit logout works when the old credential prevents catalog discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-zcode-auth-recovery-"))
    try {
      const dataHome = join(root, "data")
      const paths = { ...process.env, HOME: root, XDG_DATA_HOME: dataHome, TMPDIR: root }
      const packageDir = join(dataHome, "opencode-compat/zcode/plugins/node_modules/test-provider")
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "test-provider", version: "1.0.0", exports: "./index.js" }))
      writeFileSync(join(packageDir, "index.js"), `
        export function createTest() { return { languageModel() { throw new Error("unexpected model call") } } }
        export default async () => ({
          auth: {
            provider: "fixture",
            methods: [{ type: "api", label: "Test" }],
            async loader() { throw new Error("expired credential"); },
          },
          async config() { throw new Error("unexpected catalog discovery"); },
        });
      `)
      const config = join(root, "config.json")
      writeFileSync(config, JSON.stringify({
        version: 1, bindings: [{ id: "main", workspace: root, credentials: { model: { env: "OCP_UNUSED_TEST_ENV" } },
          plugins: [{ id: "test", package: "test-provider", version: "1.0.0", contract: "classic", models: "catalog" }] }],
      }))
      const store = DurableAuthStore.forPlugin(join(dataHome, "opencode-compat/zcode/state"), "main", "test", "fixture")
      await store.replace({ type: "api", key: "expired-fixture-key" })
      const result = Bun.spawnSync([process.execPath, cli, "zcode", "auth", "--config", config, "--binding", "main", "--plugin", "test", "--logout"], { env: paths, timeout: 5000 })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(store.read()).toEqual({ generation: 2 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the probe handles SIGTERM as soon as it announces readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-zcode-probe-signal-"))
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = String(listener.port)
    await listener.stop(true)
    const transcript = join(root, "trace.jsonl")
    const entry = resolve(import.meta.dir, "../packages/cli/src/zcode/cli.ts")
    const child = Bun.spawn([process.execPath, "--eval", `
      import { runZcodeCli } from ${JSON.stringify(entry)}
      const print = console.log
      console.log = (...args) => {
        print(...args)
        // Hold the startup caller after its last write but before it returns.
        if (args[0] === "Stop with Ctrl-C.") Bun.sleepSync(300)
      }
      process.exitCode = await runZcodeCli(["probe", "--port", ${JSON.stringify(port)}, "--transcript", ${JSON.stringify(transcript)}])
    `], { env: { ...process.env, HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "ignore" })
    const ready = async () => {
      let output = ""
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk)
        if (output.includes("Stop with Ctrl-C.")) return true
      }
      return false
    }
    try {
      expect(await Promise.race([ready(), Bun.sleep(2000).then(() => false)])).toBe(true)
      child.kill("SIGTERM")
      expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => null)])).toBe(0)
      expect(readdirSync(root).filter(name => name.startsWith("ocp-zcode-probe-"))).toEqual([])
      expect(await Bun.file(transcript).exists()).toBe(true)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a port conflict leaves the private transcript and removes the temporary probe file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-zcode-probe-conflict-"))
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    try {
      const result = Bun.spawnSync([process.execPath, cli, "zcode", "probe", "--port", String(listener.port),
        "--transcript", join(root, "trace.jsonl")], {
        env: { ...process.env, HOME: root, TMPDIR: root }, timeout: 5000,
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("cannot listen")
      const entries = readdirSync(root)
      expect(entries).toContain("trace.jsonl")
      expect(entries.filter(name => name.startsWith("ocp-zcode-probe-"))).toEqual([])
    } finally {
      await listener.stop(true)
      rmSync(root, { recursive: true, force: true })
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

describe("zcode review regressions", () => {
  test("collectStream cancels its source when the provider reports an error", async () => {
    const { collectStream } = await import("../packages/cli/src/zcode/anthropic-response.ts")
    let cancelled = false
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "error", error: new Error("boom") })
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(collectStream(stream)).rejects.toThrow("boom")
    expect(cancelled).toBe(true)
  })

  test("collectStream settles at finish even if the provider keeps its stream open", async () => {
    const { collectStream } = await import("../packages/cli/src/zcode/anthropic-response.ts")
    let cancelled = false
    let closeSource!: () => void
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        closeSource = () => controller.close()
        controller.enqueue({
          type: "finish", finishReason: { unified: "stop", raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        })
      },
      cancel() {
        cancelled = true
      },
    })
    const result = await Promise.race([collectStream(stream), Bun.sleep(100).then(() => "still waiting")])
    if (!cancelled) closeSource()
    expect(result).toMatchObject({ finishReason: { unified: "stop" } })
    expect(cancelled).toBe(true)
  })

  test("bridge logs correlate repeated request ids without recording the header value", async () => {
    const lines: string[] = []
    const local = await startHarness({ log: line => lines.push(line) })
    try {
      const requestId = "synthetic-request-id"
      for (let index = 0; index < 2; index++) {
        const response = await fetch(`${local.server.url}/models`, {
          headers: { "x-api-key": CREDENTIAL, "x-request-id": requestId },
        })
        expect(response.status).toBe(200)
        await response.text()
      }
      expect(lines).toHaveLength(2)
      expect(lines.join("\n")).not.toContain(requestId)
      const ids = lines.map(line => line.match(/request=hmac:[0-9a-f]{16}/)?.[0])
      expect(ids[0]).toBeDefined()
      expect(ids[0]).toBe(ids[1])
    } finally {
      await local.server.stop()
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  test("an idle non-streaming fallback cancels the source on HTTP shutdown", async () => {
    const local = await startHarness({ probe: createProbeModel({ path: "/probe", contents: "probe" }) })
    const route = local.server.generation().bindings[1]!.routes.get(PROBE_MODEL_ALIAS)!
    const model = await route.languageModel()
    const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>()
    let closeSource!: () => void
    let cancelled = false
    route.languageModel = async () => ({
      ...model,
      doGenerate: undefined,
      async doStream() {
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              closeSource = () => controller.close()
              signalStarted()
            },
            cancel() {
              cancelled = true
            },
          }),
        }
      },
    }) as unknown as typeof model
    const response = fetch(`${local.server.url}/messages`, {
      method: "POST",
      headers: { "x-api-key": OTHER_CREDENTIAL, "content-type": "application/json" },
      body: JSON.stringify({ model: PROBE_MODEL_ALIAS, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }).catch(() => undefined)
    try {
      expect(await Promise.race([started.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true)
      await local.server.stop()
      expect(cancelled).toBe(true)
    } finally {
      if (!cancelled) closeSource?.()
      await local.server.stop()
      await response
      rmSync(local.dir, { recursive: true, force: true })
    }
  })

  test("auth files never collide across binding/plugin/provider tuples", () => {
    const a = DurableAuthStore.forPlugin("/state", "a__b", "c", "p").file
    const b = DurableAuthStore.forPlugin("/state", "a", "b__c", "p").file
    const c = DurableAuthStore.forPlugin("/state", "a", "b", "c__p").file
    expect(new Set([a, b, c]).size).toBe(3)
  })

  test("another process (as serve vs auth) cannot replace the record while the lock is held", async () => {
    const { withFileLock } = await import("../packages/cli/src/zcode/auth-store.ts")
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-lock-"))
    try {
      const file = join(dir, "auth.json")
      await new DurableAuthStore(file).replace({ type: "api", key: "seed" })
      const generation = new DurableAuthStore(file).read().generation
      const script = join(dir, "writer.ts")
      writeFileSync(script, [
        `import { DurableAuthStore } from ${JSON.stringify(resolve(import.meta.dir, "../packages/cli/src/zcode/auth-store.ts"))}`,
        `const applied = await new DurableAuthStore(process.argv[2]!).replace({ type: "api", key: "from-child" }, Number(process.argv[3]))`,
        "console.log(applied)",
      ].join("\n"))
      let child: ReturnType<typeof Bun.spawn> | undefined
      await withFileLock(`${file}.lock`, async () => {
        child = Bun.spawn([process.execPath, script, file, String(generation)], { stdout: "pipe", stderr: "inherit" })
        await Bun.sleep(400)
        // The child is blocked on the lock: nothing was written meanwhile.
        expect(new DurableAuthStore(file).read()).toMatchObject({ generation, auth: { key: "seed" } })
      })
      expect(await child!.exited).toBe(0)
      expect((await new Response(child!.stdout as ReadableStream).text()).trim()).toBe("true")
      expect(new DurableAuthStore(file).read()).toMatchObject({ generation: generation + 1, auth: { key: "from-child" } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a lock left by a dead process is recovered; a live holder is waited for", async () => {
    const { withFileLock } = await import("../packages/cli/src/zcode/auth-store.ts")
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-lock2-"))
    try {
      const lock = join(dir, "x.lock")
      writeFileSync(lock, `999999 ${Date.now()} dead`)
      expect(await withFileLock(lock, () => "ran")).toBe("ran")
      const order: string[] = []
      const first = withFileLock(lock, async () => {
        order.push("first-start")
        await Bun.sleep(60)
        order.push("first-end")
      })
      await Bun.sleep(5)
      await withFileLock(lock, () => {
        order.push("second")
      })
      await first
      expect(order).toEqual(["first-start", "first-end", "second"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a changed entry at an already imported path requires a restart", async () => {
    const { loadPlugin, PluginLoadError } = await import("../packages/cli/src/zcode/plugin-host.ts")
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-reload-"))
    try {
      const paths: ZcodePaths = { configFile: "", installRoot: join(dir, "p"), stateDir: join(dir, "s"), cacheDir: join(dir, "c") }
      const binding = { id: "r", workspace: dir, credentials: { model: { env: "X" } }, plugins: [] }
      const spec = { id: "loop", package: "zcode-loop-provider", version: "1.0.0", contract: "classic" as const, models: [{ alias: "loop", upstream: "loop-1" }] }
      const resolved = (sha256: string, version = "1.0.0") => () => ({ name: spec.package, version, entry: LOOP, sha256 })
      await loadPlugin(binding, spec, { paths, resolvePackage: resolved("sha-loop") })
      const failure = await loadPlugin(binding, spec, { paths, resolvePackage: resolved("sha-upgraded", "1.0.1") }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PluginLoadError)
      expect((failure as { code: string }).code).toBe("restart-required")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reloads run one at a time and a trigger during a run gets one more full pass", async () => {
    const { coalescingRunner } = await import("../packages/cli/src/zcode/cli.ts")
    const log: string[] = []
    let n = 0
    const run = coalescingRunner(async () => {
      const id = ++n
      log.push(`start${id}`)
      await Bun.sleep(20)
      log.push(`end${id}`)
    })
    const first = run()
    run()
    run()
    await first
    expect(log).toEqual(["start1", "end1", "start2", "end2"])
  })

  test("maxSessions bounds retained session catalogs", () => {
    const catalog = createSessionToolCatalog(1)
    const z = { name: "zeta", input_schema: { type: "object" } }
    const a = { name: "alpha", input_schema: { type: "object" } }
    expect(catalog([z], "s1").tools.map(tool => tool.name)).toEqual(["zeta"])
    expect(catalog([z], "s2").tools.map(tool => tool.name)).toEqual(["zeta"])
    // s1 was evicted, so its next catalog is a fresh, sorted first catalog.
    expect(catalog([a, z], "s1").tools.map(tool => tool.name)).toEqual(["alpha", "zeta"])
  })

  test("the probe transcript stores ids only as per-run keyed hashes", async () => {
    const { createTranscript } = await import("../packages/cli/src/zcode/probe.ts")
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-transcript-"))
    try {
      const file = join(dir, "t.jsonl")
      const transcript = createTranscript(file, { port: 1 })
      const record = { route: "/v1/messages", method: "POST", headerNames: [], protocol: {}, status: 200, durationMs: 1,
        attribution: { "x-session-id": "sess-secret-1", "x-zcode-session-type": "main", "x-request-id": "req-secret-2" } } as RequestRecord
      transcript.record(record)
      transcript.record(record)
      const text = (await Bun.file(file).text())
      expect(text).not.toContain("sess-secret-1")
      expect(text).not.toContain("req-secret-2")
      const [, one, two] = text.trim().split("\n").map(line => JSON.parse(line))
      expect(one.attribution["x-zcode-session-type"]).toBe("main")
      expect(one.attribution["x-session-id"]).toMatch(/^hmac:[0-9a-f]{16}$/)
      expect(one.attribution["x-session-id"]).toBe(two.attribution["x-session-id"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("zcode SSE encoder abort", () => {
  test("an abort ends the response and reports the outcome without a pending read", async () => {
    const { encodeAnthropicStream } = await import("../packages/cli/src/zcode/anthropic-response.ts")
    let providerCancelled = false
    const parts = new ReadableStream<LanguageModelV3StreamPart>({
      // Never yields: only cancellation can end it.
      cancel() {
        providerCancelled = true
      },
    })
    const controller = new AbortController()
    const outcomes: unknown[] = []
    const sse = encodeAnthropicStream({
      model: "m",
      toolMap: createSessionToolCatalog()([], undefined),
      parts,
      signal: controller.signal,
      pingIntervalMs: 0,
      onOutcome: outcome => outcomes.push(outcome),
    })
    controller.abort()
    expect(outcomes).toEqual([{ toolCallIds: [], aborted: true }])
    const reader = sse.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("event: message_start")
    expect((await reader.read()).done).toBe(true)
    for (let i = 0; i < 20 && !providerCancelled; i++) await Bun.sleep(5)
    expect(providerCancelled).toBe(true)
  })
})

describe("zcode catalog models", () => {
  test("config accepts \"catalog\" and rejects other strings", () => {
    const catalog = clone(VALID_CONFIG) as unknown as { bindings: Array<{ plugins: Array<{ models: unknown }> }> }
    catalog.bindings[0]!.plugins[0]!.models = "catalog"
    expect(parseZcodeBridgeConfig(catalog).bindings[0]!.plugins[0]!.models).toBe("catalog")
    catalog.bindings[0]!.plugins[0]!.models = "all"
    expect(configError(catalog)).toContain("must be \"catalog\" or a nonempty array")
  })

  test("a catalog plugin serves every published model under its own id; collisions are attributable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-zcode-catalog-"))
    try {
      const paths: ZcodePaths = { configFile: "", installRoot: join(dir, "p"), stateDir: join(dir, "s"), cacheDir: join(dir, "c") }
      const plugin = (id: string) => ({ id, package: "zcode-loop-provider", version: "1.0.0", contract: "classic" as const, models: "catalog" as const })
      const build = (plugins: ReturnType<typeof plugin>[]) => buildGeneration({
        version: 1, listen: { host: "127.0.0.1", port: 0 }, limits: DEFAULT_LIMITS,
        bindings: [{ id: "c", workspace: dir, credentials: { model: { env: "CAT" } }, plugins }],
      }, { paths, env: { CAT: CREDENTIAL }, resolvePackage: spec => ({ name: spec.package, version: spec.version, entry: LOOP, sha256: "sha-loop" }) })

      const generation = await build([plugin("one")])
      const routes = generation.bindings[0]!.routes
      expect([...routes.keys()].sort()).toEqual(["_model", "error-stream", "loop-1", "model+extended", "plain", "slow", "truncated"])
      expect(routes.get("loop-1")!.model).toMatchObject({ name: "Loop One", contextWindow: 64_000, maxOutputTokens: 4_000 })
      expect(routes.get("loop-1")!.providerOptions()).toEqual({ loop: { wireModel: "loop-1-wire" } })

      const failure = await build([plugin("one"), plugin("two")]).then(
        () => ({ issues: [] as Array<{ plugin?: string; code: string }> }),
        (error: unknown) => error as { issues: Array<{ plugin?: string; code: string }> },
      )
      expect(failure.issues.every(issue => issue.plugin === "two" && issue.code === "alias-collision")).toBe(true)
      expect(failure.issues).toHaveLength(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
