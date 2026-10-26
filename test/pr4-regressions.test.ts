import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { currentRecordedHostSkills, hostSkillsBridge, skillsFromCatalogText, withHostSkills } from "@opencode-compat/opencode-loader"
import { parseDshSkillReminder, formatAvailableSkillsCatalog } from "../packages/opencode-loader/src/host-skills.ts"
import { installPathBridge } from "../packages/adapter/src/runtime-host.ts"
import { adaptLanguageModel, policyForHostId } from "../packages/adapter/src/language-model.ts"
import { installPiPathBridge } from "../packages/pi-bridge/src/path-bridge.ts"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt } from "../packages/pi-bridge/src/translate/context.ts"
import { buildPiToolInputVocabulary, joinReadFanoutInput, translateCanonicalToolCall, skillReadCall, skillReadCallId } from "../packages/pi-bridge/src/translate/subagent.ts"
import type { PiAssistantMessage, PiContextLike, PiToolCall } from "../packages/pi-bridge/src/pi-provider-types.ts"
import { emptyUsage } from "../packages/pi-bridge/src/translate/stream.ts"
import { linkHostAi } from "../scripts/ocp-dev/pi-family.ts"
import { buildStreamSimple, type AiSdkProviderSpec } from "../packages/pi-bridge/src/bridge.ts"
import { fallbackToolSchema, type PiEventStreamLike } from "../packages/pi-bridge/src/host/runtime.ts"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"
import { dshHostSkills, type DshGenerateOptions } from "../packages/dsh-bridge/src/translate/context.ts"
import { installDshPathBridge, installDshSkillList } from "../packages/dsh-bridge/src/path-bridge.ts"

type LanguageModelV3 = Awaited<ReturnType<AiSdkProviderSpec["getLanguageModel"]>>
type LanguageModelV3StreamPart = Awaited<ReturnType<LanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never

const catalog = (location: string) => formatAvailableSkillsCatalog([{ name: "audit", description: "Audit", location }])

describe("PR 4 catalog regressions", () => {
  test("instructions and malformed catalog openers cannot invent skills", () => {
    expect(skillsFromCatalogText("- Formatting: Keep answers short")).toEqual([])
    expect(skillsFromCatalogText("<skills>".repeat(50_000))).toEqual([])
    expect(skillsFromCatalogText(`<skills>\n-${" ".repeat(100_000)}\n</skills>`)).toEqual([])
    expect(parseDshSkillReminder(`-\`${" ".repeat(100_000)}\n- \`audit\`: Inspect`)).toEqual([{ name: "audit", description: "Inspect" }])
    const skills = [{ name: "a&lt;", description: "Use &lt;tag&gt; & symbols", location: "/repo/a&b.md" }]
    expect(skillsFromCatalogText(formatAvailableSkillsCatalog(skills))).toEqual(skills)
    expect(skillsFromCatalogText(`İ ${catalog("/a/audit.md")}`)[0]?.location).toBe("/a/audit.md")
  })

  for (const host of ["mimo", "kilo", "pi", "omp"] as const) {
    test(`${host} keeps concurrent catalogs and empty/lifecycle requests separate`, async () => {
      const key = Symbol.for("opencode.host.skills")
      const globals = globalThis as Record<PropertyKey, unknown>
      const old = globals[key]
      const pathKeys = [Symbol.for("opencode.host.path-bridge"), Symbol.for("opencode.compat.path-bridge")]
      const oldPaths = pathKeys.map(key => globals[key])
      try {
        if (host === "mimo" || host === "kilo") installPathBridge(host)
        else installPiPathBridge(host)
        const bridge = hostSkillsBridge()!
        const run = (location: string) => withHostSkills(skillsFromCatalogText(catalog(location)), async () => {
          await Promise.resolve()
          return bridge.list({ directory: dirname(location) })
        })
        expect(await Promise.all([run("/a/audit.md"), run("/b/audit.md")])).toEqual([
          [{ name: "audit", description: "Audit", location: "/a/audit.md" }],
          [{ name: "audit", description: "Audit", location: "/b/audit.md" }],
        ])
        expect(await withHostSkills([], () => bridge.list({ directory: "/a" }))).toEqual([])
        expect(await bridge.list({ directory: "/a" })).toEqual([])
      } finally {
        if (old === undefined) delete globals[key]
        else globals[key] = old
        pathKeys.forEach((key, index) => {
          if (oldPaths[index] === undefined) delete globals[key]
          else globals[key] = oldPaths[index]
        })
      }
    })
  }

  test("clone provider async work observes its own catalog", async () => {
    const model = adaptLanguageModel({
      async doGenerate(_options: unknown) {
        await Promise.resolve()
        return { skills: currentRecordedHostSkills() }
      },
    }, policyForHostId("kilo"))
    const call = (location: string) => model.doGenerate({ prompt: [{ role: "system", content: catalog(location) }] })
    const [a, b] = await Promise.all([call("/a/audit.md"), call("/b/audit.md")])
    expect(a.skills[0]?.location).toBe("/a/audit.md")
    expect(b.skills[0]?.location).toBe("/b/audit.md")
    expect(currentRecordedHostSkills()).toEqual([])
  })
})

const finish: LanguageModelV3StreamPart = {
  type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
}

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({ start(controller) { parts.forEach(part => controller.enqueue(part)); controller.close() } })
}

class CompletionStream implements PiEventStreamLike {
  private resolve!: (value: unknown) => void
  private completion = new Promise<unknown>(resolve => { this.resolve = resolve })
  push(event: unknown) {
    if (!event || typeof event !== "object" || !("type" in event)) return
    if (event.type === "done" && "message" in event) this.resolve(event.message)
    if (event.type === "error") this.resolve(event)
  }
  end() {}
  fail(error: unknown) { this.resolve(error) }
  result() { return this.completion }
  async *[Symbol.asyncIterator]() { yield await this.completion }
}

test("overlapping Pi requests translate delayed skill calls from their own snapshots", async () => {
  let count = 0
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const observed: unknown[] = []
  const model: LanguageModelV3 = {
    specificationVersion: "v3", provider: "acme", modelId: "small", supportedUrls: {},
    async doGenerate() { throw new Error("unused") },
    async doStream() {
      if (++count === 2) release()
      await ready
      observed.push(currentRecordedHostSkills())
      return { stream: streamOf([{ type: "tool-call", toolCallId: "s1", toolName: "skill", input: '{"name":"audit"}' }, finish]) }
    },
  }
  const run = buildStreamSimple({ name: "acme", api: "acme", baseUrl: "https://example.invalid", getLanguageModel: () => model }, {
    profile: piProfile(), createAssistantMessageEventStream: () => new CompletionStream(),
    toolSchema: fallbackToolSchema,
  })
  const piModel = { id: "small", api: "acme", provider: "acme", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const request = (location: string) => run(piModel, {
    systemPrompt: catalog(location), messages: [], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
  }).result()
  const [a, b] = await Promise.all([request("/a/audit.md"), request("/b/audit.md")])
  expect(observed).toEqual([
    [{ name: "audit", description: "Audit", location: "/a/audit.md" }],
    [{ name: "audit", description: "Audit", location: "/b/audit.md" }],
  ])
  for (const [result, location] of [[a, "/a/audit.md"], [b, "/b/audit.md"]]) {
    expect(result).toMatchObject({ stopReason: "toolUse", content: [{ id: skillReadCallId("s1", "audit"), name: "read", arguments: { path: location } }] })
  }
})

test("excluding skill also excludes the synthesized Pi tool", async () => {
  const model: LanguageModelV3 = {
    specificationVersion: "v3", provider: "acme", modelId: "small", supportedUrls: {},
    async doGenerate() { throw new Error("unused") },
    async doStream(call) {
      expect(call.tools?.map(tool => tool.name)).toEqual(["read"])
      return { stream: streamOf([{ ...finish, finishReason: { unified: "stop", raw: "stop" } }]) }
    },
  }
  const run = buildStreamSimple({ name: "acme", api: "acme", baseUrl: "https://example.invalid", getLanguageModel: () => model, excludedToolNames: ["skill"] }, {
    profile: piProfile(), createAssistantMessageEventStream: () => new CompletionStream(), toolSchema: fallbackToolSchema,
  })
  expect(await run({ id: "small", api: "acme", provider: "acme", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, {
    systemPrompt: catalog("/a/audit.md"), messages: [], tools: [{ name: "read", description: "Read", parameters: {} }],
  }).result()).toMatchObject({ stopReason: "stop" })
})

test("DSH lists only current model-visible skills with the requesting workspace/session", async () => {
  const globals = globalThis as Record<PropertyKey, unknown>
  const keys = [Symbol.for("opencode.host.skills"), Symbol.for("opencode.host.path-bridge"), Symbol.for("opencode.compat.path-bridge")]
  const previous = keys.map(key => globals[key])
  const seen: unknown[] = []
  const options: DshGenerateOptions = {
    provider: "acme", model: "small", sessionId: "session-a",
    tools: [{ name: "skill", description: "Load", parameters: {} }],
    messages: [{ role: "user", source: { kind: "skill-catalog", entries: [{ name: "audit", description: "Audit" }, { name: "hidden", description: "Hidden" }] }, content: [] }],
  }
  try {
    installDshPathBridge()
    installDshSkillList(async input => {
      seen.push(input)
      return [
        { name: "audit", description: "Audit", path: "/a/audit.md", invocation: { modelInvocable: true } },
        { name: "hidden", description: "Hidden", path: "/a/hidden.md", invocation: { modelInvocable: false } },
        { name: "unadvertised", description: "Other", path: "/a/other.md" },
      ]
    })
    const model: LanguageModelV3 = {
      specificationVersion: "v3", provider: "acme", modelId: "small", supportedUrls: {},
      async doGenerate() { throw new Error("unused") },
      async doStream(call) {
        await Promise.resolve()
        expect(await hostSkillsBridge()!.list({ directory: "/a", sessionID: call.headers?.["x-opencode-session-id"] })).toEqual([
          { name: "audit", description: "Audit", location: "/a/audit.md" },
        ])
        return { stream: streamOf([finish]) }
      },
    }
    const adapter = new DshLlmAdapter({ providerName: "acme", getLanguageModel: () => model })
    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "tool-calls" } })
    expect(seen).toEqual([{ directory: "/a", sessionID: "session-a" }])
    expect(await hostSkillsBridge()!.list({ directory: "/a" })).toEqual([])
    expect(dshHostSkills({ ...options, messages: [...options.messages, { role: "user", source: { kind: "skill-catalog", entries: [] }, content: [] }] })).toEqual([])
    expect(dshHostSkills({ ...options, tools: [] })).toEqual([])
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete globals[key]
      else globals[key] = previous[index]
    })
    installDshSkillList(async () => [])
  }
})

test("Pi and DSH append newly discovered tools without rewriting an established prefix", async () => {
  for (const host of ["pi", "dsh"]) {
    const seen: unknown[] = []
    const model: LanguageModelV3 = {
      specificationVersion: "v3", provider: "acme", modelId: "small", supportedUrls: {},
      async doGenerate() { throw new Error("unused") },
      async doStream(call) {
        seen.push(call.tools?.map(tool => ({ name: tool.name, description: "description" in tool ? tool.description : undefined })))
        return { stream: streamOf([finish]) }
      },
    }
    const runPi = buildStreamSimple({ name: "acme", api: "acme", baseUrl: "https://example.invalid", getLanguageModel: () => model }, {
      profile: piProfile(), createAssistantMessageEventStream: () => new CompletionStream(), toolSchema: fallbackToolSchema,
    })
    const adapter = new DshLlmAdapter({ providerName: "acme", getLanguageModel: () => model })
    const run = async (names: string[], sessionId = "one", description = "Original") => {
      const tools = names.map(name => ({ name, description, parameters: { type: "object" } }))
      if (host === "pi") {
        await runPi({ id: "small", api: "acme", provider: "acme", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { messages: [], tools }, { sessionId }).result()
      } else {
        for await (const _chunk of adapter.stream({ provider: "acme", model: "small", messages: [], tools, sessionId })) { /* drain */ }
      }
    }
    await run(["z"])
    await run(["a", "z"], "one", "Changed")
    await run([])
    await run(["z", "a"])
    await run(["z", "a"], "two")
    expect(seen).toEqual([
      [{ name: "z", description: "Original" }],
      [{ name: "z", description: "Original" }, { name: "a", description: "Changed" }],
      undefined,
      [{ name: "z", description: "Original" }, { name: "a", description: "Changed" }],
      [{ name: "a", description: "Original" }, { name: "z", description: "Original" }],
    ])
  }
})

function assistant(content: PiToolCall[]): PiAssistantMessage {
  return { role: "assistant", content, api: "acme", provider: "acme", model: "small", usage: emptyUsage(), stopReason: "toolUse", timestamp: 1 }
}

describe("PR 4 Pi replay regressions", () => {
  for (const profile of [piProfile(), ompProfile()]) {
    test(`${profile.id} keeps fanout ids, images, order, and ordinary skill-file reads`, () => {
      const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }]
      const inputs = buildPiToolInputVocabulary(tools, profile)
      const context: PiContextLike = {
        systemPrompt: catalog("/repo/audit.md"), tools,
        messages: [
          assistant([
            { type: "toolCall", id: "batch#0", name: "read", arguments: { path: "/repo/audit.md" } },
            { type: "toolCall", id: "batch#1", name: "read", arguments: { path: "/repo/chart.png" } },
          ]),
          { role: "toolResult", toolCallId: "batch#1", toolName: "read", content: [{ type: "image", data: "YWJj", mimeType: "image/png" }], isError: false, timestamp: 2 },
          { role: "developer", content: "Host note" },
          { role: "toolResult", toolCallId: "batch#0", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 3 },
        ],
      }
      const prompt = translateContextToPrompt(context, undefined, profile, inputs)
      expect(prompt[1]).toMatchObject({ role: "assistant", content: [{ toolCallId: "batch", toolName: "read", input: { filePath: "/repo/audit.md;/repo/chart.png" } }] })
      expect(prompt[2]).toMatchObject({ role: "tool", content: [{ toolCallId: "batch", toolName: "read", output: {
        type: "content", value: [
          { type: "text", text: "/repo/audit.md" }, { type: "text", text: "body" },
          { type: "text", text: "/repo/chart.png" }, { type: "file-data", data: "YWJj", mediaType: "image/png" },
        ],
      } }] })
      expect(prompt[3]).toEqual({ role: "system", content: "Host note" })
    })

    test(`${profile.id} ranged skill-file reads retain read semantics`, () => {
      const inputs = buildPiToolInputVocabulary([{ name: "read", description: "Read", parameters: {} }], profile)
      const arguments_ = profile.id === "omp" ? { path: "/repo/audit.md:5-6" } : { path: "/repo/audit.md", offset: 5, limit: 2 }
      const prompt = translateContextToPrompt({
        systemPrompt: catalog("/repo/audit.md"),
        messages: [
          assistant([{ type: "toolCall", id: "range", name: "read", arguments: arguments_ }]),
          { role: "toolResult", toolCallId: "range", toolName: "read", content: [{ type: "text", text: "two lines" }], isError: false, timestamp: 2 },
        ],
      }, undefined, profile, inputs)
      expect(prompt[1]).toMatchObject({ content: [{ toolName: "read", input: { filePath: "/repo/audit.md", offset: 5, limit: 2 } }] })
      expect(prompt[2]).toMatchObject({ content: [{ toolName: "read", output: { type: "text", value: "two lines" } }] })
    })
  }

  test("Pi fans out joined absolute reads without changing its native range fields", () => {
    const inputs = buildPiToolInputVocabulary([{ name: "read", description: "Read", parameters: {} }], piProfile())
    expect(translateCanonicalToolCall("read", { filePath: "/a;/b", offset: 5, limit: 2 }, undefined, inputs)).toEqual([
      { toolName: "read", input: { path: "/a", offset: 5, limit: 2 } },
      { toolName: "read", input: { path: "/b", offset: 5, limit: 2 } },
    ])
  })

  test("fanout reconstruction keeps Pi's explicit ranges", () => {
    expect(joinReadFanoutInput([{ path: "/a", offset: 5, limit: 2 }, { path: "/b", offset: 5, limit: 2 }])).toEqual({ filePath: "/a;/b", offset: 5, limit: 2 })
  })

  test("skill provenance is reversible and failed loads stay errors", () => {
    const id = skillReadCallId("original#0", "audit:x")
    expect(skillReadCall(id)).toEqual({ id: "original#0", name: "audit:x" })
    expect(skillReadCall("ocp-skill:bad")).toBeUndefined()
    expect(skillReadCall("ocp-skill:bnVsbA")).toBeUndefined()
    const prompt = translateContextToPrompt({ messages: [
      assistant([{ type: "toolCall", id, name: "read", arguments: { path: "/missing" } }]),
      { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Permission denied" }], isError: true, timestamp: 2 },
    ] })
    expect(prompt[1]).toMatchObject({ content: [{ toolCallId: "original#0", toolName: "skill", output: { type: "error-text", value: "Permission denied" } }] })
  })
})

test("Pi local setup replaces dangling overlay and bridge links after a reinstall", () => {
  const root = mkdtempSync(join(tmpdir(), "ocp-ai-links-"))
  const previous = { root: process.env.OCP_DEV_ROOT, state: process.env.OCP_DEV_STATE_DIR }
  try {
    process.env.OCP_DEV_ROOT = root
    process.env.OCP_DEV_STATE_DIR = join(root, "state")
    const cli = join(root, "host", "bin", "pi")
    const source = join(root, "host", "node_modules", "@earendil-works", "pi-ai")
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, "")
    mkdirSync(join(source, "dist"), { recursive: true })
    writeFileSync(join(source, "package.json"), '{"name":"@earendil-works/pi-ai","version":"1.0.0"}')
    writeFileSync(join(source, "dist", "index.js"), "export {}")
    const overlay = join(root, "state", "pi", "node_modules", "@earendil-works", "pi-ai")
    const target = join(root, "packages", "pi-bridge", "node_modules", "@earendil-works", "pi-ai")
    for (const link of [overlay, target]) {
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(root, "removed"), link)
    }
    linkHostAi("pi", cli)
    expect(realpathSync(target)).toBe(realpathSync(source))
    expect(readlinkSync(target)).toBe(overlay)
    linkHostAi("pi", cli)
    expect(realpathSync(target)).toBe(realpathSync(source))
  } finally {
    if (previous.root === undefined) delete process.env.OCP_DEV_ROOT
    else process.env.OCP_DEV_ROOT = previous.root
    if (previous.state === undefined) delete process.env.OCP_DEV_STATE_DIR
    else process.env.OCP_DEV_STATE_DIR = previous.state
    rmSync(root, { recursive: true, force: true })
  }
})
