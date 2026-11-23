/**
 * Step 0 stock-host probe: a deterministic OCP-owned model served through the
 * same Anthropic endpoint, credential check and tool translation as real
 * plugins, plus a private, redacted wire transcript.
 *
 * Script (keyed only on the conversation's own structure):
 *   1. A tool result for the probe call id → `OCP-PROBE-OK` when its text
 *      equals the probe file contents, else `OCP-PROBE-MISMATCH`.
 *   2. Else, when the latest user text contains `ocp probe read` and the
 *      request advertises canonical `read` → one complete `read` call for the
 *      probe file with the known call id, finishing with `tool-calls`.
 *   3. Else → the plain text `OCP-PROBE-TEXT`.
 * The transcript records header names, protocol headers, block types, tool
 * names, stop reasons and verdicts. ZCode session/query/request/trace ids are
 * stored only as keyed hashes (HMAC with a per-run key that is never
 * written), so equality across requests stays comparable while the ids
 * themselves are not persisted. No prompt text, file contents, local paths or
 * credentials are written.
 */
import { createHmac, randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { ModelInfo } from "./plugin-host.js"
import type { RequestRecord } from "./server.js"

export const PROBE_MODEL_ALIAS = "ocp-probe"
export const PROBE_READ_TRIGGER = "ocp probe read"

export type ProbeFile = { path: string; contents: string }

export function createProbeFile(dir = mkdtempSync(join(tmpdir(), "ocp-zcode-probe-"))): ProbeFile {
  const contents = `ocp-zcode-probe ${randomBytes(16).toString("hex")}`
  const path = join(dir, "probe.txt")
  writeFileSync(path, contents, { mode: 0o600 })
  return { path, contents }
}

export type ProbeVerdict = "text" | "read-requested" | "tool-result-match" | "tool-result-mismatch"

export type ProbeModel = LanguageModelV3 & { readonly callId: string; readonly verdicts: ProbeVerdict[] }

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function toolResultText(options: LanguageModelV3CallOptions, callId: string): string | undefined {
  for (const message of options.prompt) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolCallId !== callId) continue
      const output = part.output
      if (output.type === "text" || output.type === "error-text") return output.value
      if (output.type === "content") return output.value.map(item => item.type === "text" ? item.text : "").join("")
      return output.type === "execution-denied" ? "" : JSON.stringify(output.value)
    }
  }
  return undefined
}

function latestUserText(options: LanguageModelV3CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const message = options.prompt[i]!
    if (message.role === "user") return message.content.map(part => part.type === "text" ? part.text : "").join("\n")
  }
  return ""
}

/** True when `received` is ZCode's rendering of `contents` (line-numbered or raw). */
export function probeResultMatches(received: string, contents: string): boolean {
  if (received.trim() === contents) return true
  // ZCode's Read renders numbered lines; accept exactly one line carrying the contents.
  return received.split(/\r?\n/).some(line => line.replace(/^\s*\d+[\t→|:]\s?/, "").trim() === contents)
}

export function createProbeModel(file: ProbeFile): ProbeModel {
  const callId = `toolu_ocpprobe_${randomBytes(8).toString("hex")}`
  const verdicts: ProbeVerdict[] = []

  const decide = (options: LanguageModelV3CallOptions): LanguageModelV3Content[] => {
    const result = toolResultText(options, callId)
    if (result !== undefined) {
      const ok = probeResultMatches(result, file.contents)
      verdicts.push(ok ? "tool-result-match" : "tool-result-mismatch")
      return [{ type: "text", text: ok ? "OCP-PROBE-OK" : "OCP-PROBE-MISMATCH" }]
    }
    const canRead = options.tools?.some(tool => tool.name === "read") ?? false
    if (canRead && latestUserText(options).toLowerCase().includes(PROBE_READ_TRIGGER)) {
      verdicts.push("read-requested")
      return [{ type: "tool-call", toolCallId: callId, toolName: "read", input: JSON.stringify({ filePath: file.path }) }]
    }
    verdicts.push("text")
    return [{ type: "text", text: "OCP-PROBE-TEXT" }]
  }

  const finishOf = (content: LanguageModelV3Content[]) =>
    content.some(part => part.type === "tool-call")
      ? { unified: "tool-calls" as const, raw: "tool_use" }
      : { unified: "stop" as const, raw: "end_turn" }

  return {
    specificationVersion: "v3",
    provider: "ocp-probe",
    modelId: PROBE_MODEL_ALIAS,
    supportedUrls: {},
    callId,
    verdicts,
    async doGenerate(options) {
      const content = decide(options)
      return { content, finishReason: finishOf(content), usage: USAGE, warnings: [] }
    },
    async doStream(options) {
      const content = decide(options)
      const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }]
      for (const part of content) {
        if (part.type === "text") {
          parts.push({ type: "text-start", id: "probe" }, { type: "text-delta", id: "probe", delta: part.text }, { type: "text-end", id: "probe" })
        } else if (part.type === "tool-call") {
          parts.push(part)
        }
      }
      parts.push({ type: "finish", finishReason: finishOf(content), usage: USAGE })
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }
}

export const PROBE_MODEL_INFO: ModelInfo = {
  alias: PROBE_MODEL_ALIAS,
  upstream: PROBE_MODEL_ALIAS,
  name: "OCP probe",
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  input: ["text"],
  reasoning: false,
}

/** Attribution headers that carry identifiers; the rest are labels. */
const IDENTIFIER_HEADERS = new Set(["x-session-id", "x-query-id", "x-request-id", "x-zcode-trace-id"])

/** Append-only private JSONL transcript. */
export function createTranscript(file: string, header: Record<string, unknown>) {
  const key = randomBytes(32)
  const pseudonym = (value: string) => `hmac:${createHmac("sha256", key).update(value).digest("hex").slice(0, 16)}`
  writeFileSync(file, `${JSON.stringify({ kind: "probe-start", ...header })}\n`, { mode: 0o600, flag: "w" })
  chmodSync(file, 0o600)
  return {
    file,
    pseudonym,
    record(record: RequestRecord, extra: Record<string, unknown> = {}) {
      const attribution = Object.fromEntries(Object.entries(record.attribution).map(([name, value]) =>
        [name, value !== undefined && IDENTIFIER_HEADERS.has(name) ? pseudonym(value) : value]))
      appendFileSync(file, `${JSON.stringify({ kind: "request", at: new Date().toISOString(), ...record, attribution, ...extra })}\n`)
    },
  }
}
