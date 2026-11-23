// Trusted review-harness checks for the external ZCode bridge, run inside
// isolate-run.sh against the archived subject's built `packages/cli` dist.
// A fake model records what the bridge hands it; requests go over loopback
// HTTP with node:http so the Host header is under the probe's control. No
// host, provider package, upstream or credential is involved.
//
// Each case prints ZCODE_CONTRACT=<case>:passed|failed|skipped <detail>.
// The last line is REVIEW_CONTRACT_COMPLETE=ZCODE_CONTRACTS:<status>.
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const LABEL = "ZCODE_CONTRACTS"
// Every case name, so a subject without the bridge skips the same names the
// base passed and the wrapper can see the capability disappear.
const CASES = [
  "refuses-missing-credential",
  "refuses-foreign-host",
  "forwards-no-zcode-identity",
  "native-read-call-mapped",
  "no-synthetic-finish",
  "disconnect-aborts-provider",
]
const src = process.argv[2]
const entry = src ? join(src, "packages/cli/dist/zcode/index.js") : ""
let failed = 0

function report(name, status, detail = "") {
  if (status === "failed") failed += 1
  console.log(`ZCODE_CONTRACT=${name}:${status}${detail ? ` ${detail}` : ""}`)
}

function finish(code) {
  console.log(`REVIEW_CONTRACT_COMPLETE=${LABEL}:${failed === 0 ? "passed" : "failed"}`)
  process.exit(code ?? (failed === 0 ? 0 : 1))
}

if (!src || !existsSync(join(src, "package.json"))) {
  console.log(`ZCODE_CONTRACT=subject:unavailable no package.json at ${src ?? "<missing argument>"}`)
  process.exit(2)
}
function skipAll(reason) {
  for (const name of CASES) report(name, "skipped", reason)
  finish()
}

if (!existsSync(entry)) skipAll("packages/cli/dist/zcode/index.js absent")

const bridge = await import(pathToFileURL(entry).href)
if (typeof bridge.buildGeneration !== "function" || typeof bridge.startBridgeServer !== "function") {
  skipAll("buildGeneration/startBridgeServer are not exported")
}

const CREDENTIAL = "ocpz_review_contract_credential_0000000000"
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
const calls = []

/** Scripted fake provider keyed by model id. */
function fakeModel(id) {
  return {
    specificationVersion: "v3",
    provider: "review-contract",
    modelId: id,
    supportedUrls: {},
    async doGenerate(options) {
      calls.push({ id, options })
      return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }
    },
    async doStream(options) {
      calls.push({ id, options })
      const parts = []
      if (id === "text") {
        parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage })
      } else if (id === "read") {
        parts.push({ type: "tool-call", toolCallId: "call_review_1", toolName: "read", input: JSON.stringify({ filePath: "/tmp/review.txt" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage })
      } else if (id === "truncated") {
        parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "partial" })
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            if (id === "slow") {
              controller.enqueue({ type: "text-start", id: "t" })
              controller.enqueue({ type: "text-delta", id: "t", delta: "…" })
              options.abortSignal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
              return
            }
            controller.close()
          },
        }),
      }
    },
  }
}

const info = id => ({ alias: id, upstream: id, name: id, input: ["text"], reasoning: false })
const dir = mkdtempSync(join(tmpdir(), "ocp-review-zcode-"))
let server
try {
  const generation = await bridge.buildGeneration({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    limits: { maxBodyBytes: 1024 * 1024, maxConcurrentRequests: 8, maxSessions: 16 },
    bindings: [{ id: "review", workspace: dir, credentials: { model: { env: "REVIEW_CONTRACT_CREDENTIAL" } }, plugins: [] }],
  }, {
    paths: { configFile: join(dir, "c.json"), installRoot: join(dir, "p"), stateDir: join(dir, "s"), cacheDir: join(dir, "k") },
    env: { REVIEW_CONTRACT_CREDENTIAL: CREDENTIAL },
    staticRoutes: new Map([["review", ["text", "read", "truncated", "slow"].map(id => ({ info: info(id), languageModel: async () => fakeModel(id) }))]]),
  })
  server = bridge.startBridgeServer({ generation, log: () => {}, pingIntervalMs: 0 })
} catch (error) {
  console.log(`ZCODE_CONTRACT=bridge-start:failed ${error instanceof Error ? error.message : String(error)}`)
  failed += 1
  rmSync(dir, { recursive: true, force: true })
  finish()
}

const port = server.port

/** One HTTP exchange. `onData(chunk, req)` may destroy the request early. */
function exchange({ headers = {}, body, onData }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: "127.0.0.1", port, method: "POST", path: "/v1/messages",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}`, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        text += chunk
        onData?.(chunk, req)
      })
      res.on("end", () => resolve({ status: res.statusCode, text }))
      res.on("error", () => resolve({ status: res.statusCode, text, closed: true }))
      res.on("close", () => resolve({ status: res.statusCode, text, closed: true }))
    })
    req.on("error", () => resolve({ status: 0, text: "", closed: true }))
    if (payload) req.write(payload)
    req.end()
  })
}

const auth = { "x-api-key": CREDENTIAL, authorization: `Bearer ${CREDENTIAL}` }
const message = model => ({ model, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function check(name, run) {
  if (!CASES.includes(name)) throw new Error(`unlisted case ${name}`)
  try {
    const problem = await run()
    report(name, problem ? "failed" : "passed", problem ?? "")
  } catch (error) {
    report(name, "failed", `threw ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  await check("refuses-missing-credential", async () => {
    const result = await exchange({ body: message("text") })
    return result.status === 401 ? undefined : `status=${result.status}`
  })

  await check("refuses-foreign-host", async () => {
    const result = await exchange({ headers: { ...auth, host: "evil.example" }, body: message("text") })
    return result.status >= 400 && result.status !== 404 ? undefined : `status=${result.status}`
  })

  await check("forwards-no-zcode-identity", async () => {
    calls.length = 0
    const result = await exchange({
      headers: { ...auth, "x-session-id": "sess-review", "x-zcode-session-type": "main", "x-zcode-query-source": "repl", "x-request-id": "req-review", "x-query-id": "q", "x-zcode-trace-id": "t" },
      body: message("text"),
    })
    if (result.status !== 200) return `status=${result.status}`
    const headers = calls.at(-1)?.options?.headers ?? {}
    const leaked = Object.keys(headers).filter(key => /^(x-session-id|x-zcode-|x-request-id|x-query-id|authorization|x-api-key|x-opencode-session-id)/i.test(key))
    return leaked.length === 0 ? undefined : `forwarded=${leaked.join(",")}`
  })

  await check("native-read-call-mapped", async () => {
    const tools = [{ name: "Read", description: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["file_path"] } }]
    const result = await exchange({ headers: auth, body: { ...message("read"), tools } })
    if (result.status !== 200) return `status=${result.status}`
    const advertised = calls.at(-1)?.options?.tools?.map(tool => tool.name) ?? []
    if (!advertised.includes("read")) return `provider saw tools=${advertised.join(",")}`
    if (!/"name":"Read"/.test(result.text)) return "no native Read tool_use"
    if (!result.text.includes('\\"file_path\\":\\"/tmp/review.txt\\"')) return "tool_use input not mapped to file_path"
    return /"stop_reason":"tool_use"/.test(result.text) ? undefined : "stop_reason is not tool_use"
  })

  await check("no-synthetic-finish", async () => {
    const result = await exchange({ headers: auth, body: message("truncated") })
    if (/event: message_stop/.test(result.text)) return "stream without a provider finish ended with message_stop"
    return /event: error/.test(result.text) ? undefined : "no error event"
  })

  await check("disconnect-aborts-provider", async () => {
    calls.length = 0
    await exchange({ headers: auth, body: message("slow"), onData: (_chunk, req) => req.destroy() })
    const signal = calls.at(-1)?.options?.abortSignal
    for (let i = 0; i < 100 && signal && !signal.aborted; i++) await sleep(20)
    return signal?.aborted ? undefined : "provider abortSignal not aborted after client disconnect"
  })
} finally {
  await Promise.race([server.stop(), sleep(5000)])
  rmSync(dir, { recursive: true, force: true })
}

finish()
