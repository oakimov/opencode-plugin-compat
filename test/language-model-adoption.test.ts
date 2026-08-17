/**
 * Option B — host-dynamic LanguageModel adoption + in-place provider shims.
 *
 * MiMo: emit tool-input-start before bare tool-call; fill missing bash.description.
 * Kilo / OpenCode: pass-through (ensureToolCall / optional description).
 */
import { describe, expect, test } from "bun:test"
import {
  adaptLanguageModel,
  adoptStreamPart,
  canonicalToolKey,
  defaultBashDescription,
  normalizeToolInputForSchema,
  policyForHostId,
  policyFromProfile,
  providerShimRuntimeSource,
  renderProviderShimSource,
  RUNTIME_FILENAME,
  SHIM_MARKER,
  SHIM_META_FILENAME,
  stripProviderShimSource,
  wrapProviderModule,
  wrapProviderSdk,
} from "../packages/adapter/src/index.ts"
import {
  kiloProfile,
  mimoProfile,
  opencodeProfile,
} from "../packages/profile/src/index.ts"

describe("HostProfile stream / bash capabilities", () => {
  test("mimo requires adoption (no ensureToolCall; bash.description required)", () => {
    const p = mimoProfile({ home: "/tmp", env: {} })
    expect(p.capabilities.streamToolCallEnsure).toBe(false)
    expect(p.capabilities.bashDescriptionRequired).toBe(true)
    expect(policyFromProfile(p)).toEqual({
      streamToolCallEnsure: false,
      bashDescriptionRequired: true,
    })
  })

  test("kilo / opencode are pass-through", () => {
    const kilo = kiloProfile({ home: "/tmp", env: {} })
    const oc = opencodeProfile({ home: "/tmp", env: {} })
    expect(kilo.capabilities.streamToolCallEnsure).toBe(true)
    expect(kilo.capabilities.bashDescriptionRequired).toBe(false)
    expect(oc.capabilities.streamToolCallEnsure).toBe(true)
    expect(oc.capabilities.bashDescriptionRequired).toBe(false)
    expect(policyForHostId("kilo")).toEqual({
      streamToolCallEnsure: true,
      bashDescriptionRequired: false,
    })
    expect(policyForHostId("opencode")).toEqual({
      streamToolCallEnsure: true,
      bashDescriptionRequired: false,
    })
  })
})

describe("adoptStreamPart — MiMo vs Kilo", () => {
  const mimo = policyForHostId("mimo")
  const kilo = policyForHostId("kilo")

  test("MiMo inserts tool-input-start before bare tool-call", () => {
    const seen = new Set<string>()
    const parts = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read",
        input: { path: "/tmp/x" },
      },
      mimo,
      seen,
    )
    expect(parts).toEqual([
      { type: "tool-input-start", id: "call_1", toolName: "read" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read",
        input: { path: "/tmp/x" },
      },
    ])
    expect(seen.has("call_1")).toBe(true)
  })

  test("MiMo does not duplicate start when tool-input-start already seen", () => {
    const seen = new Set<string>(["call_1"])
    const parts = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read",
        input: {},
      },
      mimo,
      seen,
    )
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe("tool-call")
  })

  test("MiMo records tool-input-start ids", () => {
    const seen = new Set<string>()
    const parts = adoptStreamPart(
      { type: "tool-input-start", id: "call_9", toolName: "bash" },
      mimo,
      seen,
    )
    expect(parts).toHaveLength(1)
    expect(seen.has("call_9")).toBe(true)
  })

  test("MiMo fills missing bash.description (object + JSON string input)", () => {
    const seen = new Set<string>()
    const obj = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "ls -la" },
      },
      mimo,
      seen,
    )
    expect(obj[0]?.type).toBe("tool-input-start")
    const call = obj[1]!
    expect(call.type).toBe("tool-call")
    expect((call.input as { description: string }).description).toBe(
      defaultBashDescription("ls -la"),
    )

    const seen2 = new Set<string>()
    const str = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "b2",
        toolName: "bash",
        input: JSON.stringify({ command: "pwd" }),
      },
      mimo,
      seen2,
    )
    const call2 = str[1]!
    expect(typeof call2.input).toBe("string")
    expect(JSON.parse(call2.input as string).description).toBe(
      defaultBashDescription("pwd"),
    )
  })

  test("MiMo preserves existing bash.description", () => {
    const seen = new Set<string>()
    const parts = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "b3",
        toolName: "bash",
        input: { command: "echo hi", description: "Say hi" },
      },
      mimo,
      seen,
    )
    expect((parts[1]!.input as { description: string }).description).toBe(
      "Say hi",
    )
  })

  test("MiMo does not invent description for non-bash tools", () => {
    const seen = new Set<string>()
    const parts = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "r1",
        toolName: "read",
        input: { path: "/x" },
      },
      mimo,
      seen,
    )
    expect(parts[1]!.input).toEqual({ path: "/x" })
  })

  test("Kilo pass-through: bare tool-call unchanged; no bash.description fill", () => {
    const seen = new Set<string>()
    const bare = adoptStreamPart(
      {
        type: "tool-call",
        toolCallId: "call_k",
        toolName: "bash",
        input: { command: "ls" },
      },
      kilo,
      seen,
    )
    expect(bare).toHaveLength(1)
    expect(bare[0]).toEqual({
      type: "tool-call",
      toolCallId: "call_k",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(seen.size).toBe(0)
  })
})

describe("schema-driven argument key adoption", () => {
  test("canonicalizes casing and separators without a host-specific table", () => {
    expect(canonicalToolKey("filePath")).toBe("filepath")
    expect(canonicalToolKey("file_path")).toBe("filepath")
    expect(canonicalToolKey("request-id")).toBe("requestid")
  })

  test("normalizes future-fork keys recursively from the advertised schema", () => {
    const schema = {
      type: "object",
      properties: {
        file_path: { type: "string" },
        options: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            replacements: {
              type: "array",
              items: {
                type: "object",
                properties: { old_string: { type: "string" } },
              },
            },
          },
        },
      },
    }
    expect(
      normalizeToolInputForSchema(
        {
          filePath: "/tmp/a",
          options: {
            requestID: "r1",
            replacements: [{ oldString: "before" }],
          },
        },
        schema,
      ),
    ).toEqual({
      file_path: "/tmp/a",
      options: {
        request_id: "r1",
        replacements: [{ old_string: "before" }],
      },
    })
  })

  test("follows local refs and schema composition", () => {
    expect(
      normalizeToolInputForSchema(
        { payload: { requestID: "r1", newValue: "after" } },
        {
          type: "object",
          properties: {
            payload: { $ref: "#/$defs/payload" },
          },
          $defs: {
            payload: {
              allOf: [
                {
                  type: "object",
                  properties: { request_id: { type: "string" } },
                },
                {
                  type: "object",
                  properties: { new_value: { type: "string" } },
                },
              ],
            },
          },
        },
      ),
    ).toEqual({ payload: { request_id: "r1", new_value: "after" } })
  })

  test("preserves exact MCP keys and refuses ambiguous canonical matches", () => {
    expect(
      normalizeToolInputForSchema(
        { filePath: "/tmp/a" },
        { type: "object", properties: { filePath: { type: "string" } } },
      ),
    ).toEqual({ filePath: "/tmp/a" })
    expect(
      normalizeToolInputForSchema(
        { fooBar: 1 },
        {
          type: "object",
          properties: {
            foo_bar: { type: "number" },
            foobar: { type: "number" },
          },
        },
      ),
    ).toEqual({ fooBar: 1 })
    expect(
      normalizeToolInputForSchema(
        { path: "/tmp/a" },
        { type: "object", properties: { file_path: { type: "string" } } },
      ),
    ).toEqual({ path: "/tmp/a" })
  })
})

describe("adaptLanguageModel / wrapProvider*", () => {
  test("pass-through hosts still wrap for schema adoption", async () => {
    const model = {
      async doStream(_options?: unknown) {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "read-1",
                toolName: "read",
                input: JSON.stringify({ filePath: "/tmp/a" }),
              })
              controller.close()
            },
          }),
        }
      },
    }
    const adapted = adaptLanguageModel(model, policyForHostId("kilo"))
    expect(adapted).not.toBe(model)
    const result = await adapted.doStream({
      tools: [
        {
          name: "read",
          inputSchema: {
            type: "object",
            properties: { file_path: { type: "string" } },
          },
        },
      ],
    })
    const parts: unknown[] = []
    const reader = result.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts).toHaveLength(1)
    expect(JSON.parse((parts[0] as { input: string }).input)).toEqual({
      file_path: "/tmp/a",
    })
  })

  test.each([
    ["opencode", opencodeProfile({ home: "/tmp", env: {} })],
    ["kilo", kiloProfile({ home: "/tmp", env: {} })],
    ["mimo", mimoProfile({ home: "/tmp", env: {} })],
  ] as const)("%s preserves same-session lifecycle/full catalog affinity", async (_host, profile) => {
    const seen: Array<Record<string, unknown>> = []
    const model = {
      async doStream(call: Record<string, unknown>) {
        seen.push(call)
        return {
          stream: new ReadableStream({
            start(controller) { controller.close() },
          }),
        }
      },
    }
    const adapted = adaptLanguageModel(model, policyFromProfile(profile), profile)
    const signal = new AbortController().signal
    const shared = {
      headers: { "x-opencode-session": "same-session", "x-provider": "generic" },
      providerOptions: { generic: { session: "same-session" } },
      abortSignal: signal,
      prompt: [],
    }

    await adapted.doStream({ ...shared })
    const fullCatalog = [
      { name: "read", inputSchema: { type: "object" } },
      { name: profile.tools?.subagent ?? "task", inputSchema: { type: "object" } },
      { name: "custom-tool", inputSchema: { type: "object" } },
      ...(profile.tools?.todoWrite
        ? [{ name: profile.tools.todoWrite, inputSchema: { type: "object" } }]
        : [{ name: "todowrite", inputSchema: { type: "object" } }]),
    ]
    await adapted.doStream({ ...shared, tools: fullCatalog })

    expect(seen).toHaveLength(2)
    expect(seen[0]?.tools).toBeUndefined()
    expect(seen[0]?.headers).toEqual(shared.headers)
    expect(seen[0]?.providerOptions).toEqual(shared.providerOptions)
    expect(seen[0]?.abortSignal).toBe(signal)
    expect(seen[1]?.headers).toEqual(shared.headers)
    expect(seen[1]?.providerOptions).toEqual(shared.providerOptions)
    expect(seen[1]?.abortSignal).toBe(signal)

    const names = (seen[1]?.tools as Array<{ name: string }>).map(tool => tool.name)
    expect(names).toContain("read")
    expect(names).toContain("custom-tool")
    expect(names).not.toContain("actor")
    expect(names).toEqual([...names].sort())
    if (profile.tools?.subagent) expect(names).toContain("task")
    if (profile.tools?.todoWrite) {
      expect(names).toContain("todowrite")
      expect(names).toContain("todoread")
    }
    // Translation must never mutate the host-owned source catalog.
    expect(fullCatalog.map(tool => tool.name)).toEqual([
      "read",
      profile.tools?.subagent ?? "task",
      "custom-tool",
      profile.tools?.todoWrite ?? "todowrite",
    ])
  })

  test("MiMo doStream inserts preamble + bash description", async () => {
    const model = {
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "c1",
                toolName: "bash",
                input: { command: "echo ok" },
              })
              controller.close()
            },
          }),
        }
      },
    }
    const adapted = adaptLanguageModel(model, policyForHostId("mimo"))
    expect(adapted).not.toBe(model)
    const result = await adapted.doStream()
    const parts: unknown[] = []
    const reader = result.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({
      type: "tool-input-start",
      id: "c1",
      toolName: "bash",
    })
    expect((parts[1] as { input: { description: string } }).input.description).toBe(
      defaultBashDescription("echo ok"),
    )
  })

  test("MiMo doGenerate expands content array and adopts schema keys", async () => {
    const model = {
      async doGenerate(_call?: Record<string, unknown>) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "g1",
              toolName: "edit",
              input: { filePath: "/tmp/a", oldString: "a", newString: "b" },
            },
          ],
        }
      },
    }
    const adapted = adaptLanguageModel(model, policyForHostId("mimo"))
    const result = await adapted.doGenerate({
      tools: [
        {
          name: "edit",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
          },
        },
      ],
    })
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("tool-input-start")
    expect(result.content[1].input as unknown).toEqual({
      file_path: "/tmp/a",
      old_string: "a",
      new_string: "b",
    })
  })

  test("wrapProviderSdk adapts languageModel() for every schema-owning host", () => {
    const sdk = {
      languageModel(id: string) {
        return {
          modelId: id,
          async doGenerate() {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "x",
                  toolName: "read",
                  input: {},
                },
              ],
            }
          },
        }
      },
    }
    expect(wrapProviderSdk(sdk, policyForHostId("kilo"))).not.toBe(sdk)
    const wrapped = wrapProviderSdk(sdk, policyForHostId("mimo"))
    expect(wrapped).not.toBe(sdk)
  })

  test("wrapProviderModule wraps create* only", async () => {
    const mod = {
      createCursor(opts: { label: string }) {
        return {
          label: opts.label,
          languageModel() {
            return {
      async doGenerate(_call?: Record<string, unknown>) {
                return {
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "m1",
                      toolName: "bash",
                      input: { command: "uname" },
                    },
                  ],
                }
              },
            }
          },
        }
      },
      helper: 1,
      default: async () => ({ classic: true }),
    }
    const wrapped = wrapProviderModule(mod, policyForHostId("mimo"))
    expect(wrapped.helper).toBe(1)
    expect(wrapped.default).toBe(mod.default)
    const sdk = wrapped.createCursor!({ label: "demo" })
    const model = sdk.languageModel()
    const out = await model.doGenerate()
    expect(out.content[0].type).toBe("tool-input-start")
    expect(
      (out.content[1].input as unknown as { description: string }).description,
    ).toBe(defaultBashDescription("uname"))
  })
})

describe("provider shim source + install-tree setup", () => {
  test("runtime source detects worker markers and falls back to its install-tree host", async () => {
    const src = providerShimRuntimeSource()
    expect(src).toContain(SHIM_MARKER)
    expect(src).not.toContain("@opencode-compat/")

    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const dir = await mkdtemp(join(tmpdir(), "ocp-runtime-"))
    try {
      const runtimePath = join(dir, "ocp-lm-runtime.mjs")
      await Bun.write(runtimePath, src)
      const runtime = (await import(pathToFileURL(runtimePath).href)) as {
        detectHostId: (
          env: Record<string, string>,
          argv: string[],
          execPath: string,
          hostHint?: string,
        ) => string
        installPathBridge: (id: string, env?: Record<string, string>) => void
        policyForHostId: (id: string) => unknown
        toolRolesForHostId: (id: string) => { tools: Record<string, string> } | undefined
        wrapProviderModule: (...args: unknown[]) => unknown
        normalizeToolInputForSchema: (input: unknown, schema: unknown) => unknown
      }
      expect(typeof runtime.detectHostId).toBe("function")
      expect(typeof runtime.installPathBridge).toBe("function")
      expect(typeof runtime.policyForHostId).toBe("function")
      expect(typeof runtime.toolRolesForHostId).toBe("function")
      expect(typeof runtime.wrapProviderModule).toBe("function")
      expect(
        runtime.detectHostId(
          { MIMOCODE: "1" },
          ["node", "worker.js"],
          "/usr/bin/node",
          "kilo",
        ),
      ).toBe("mimo")
      expect(
        runtime.detectHostId(
          {},
          ["node", "/tmp/opencode-plugin-compat/worker.js"],
          "/usr/bin/node",
          "mimo",
        ),
      ).toBe("mimo")
      expect(
        runtime.detectHostId({}, ["/usr/bin/opencode"], "/usr/bin/node", "mimo"),
      ).toBe("opencode")
      expect(
        runtime.normalizeToolInputForSchema(
          { filePath: "/tmp/a", oldString: "a" },
          {
            type: "object",
            properties: {
              file_path: { type: "string" },
              old_string: { type: "string" },
            },
          },
        ),
      ).toEqual({ file_path: "/tmp/a", old_string: "a" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("runtime source translates MiMo's rotated vocabulary end to end", async () => {
    // Guards against the failure mode where vocabulary.ts / language-model.ts
    // gain rotation logic but the hand-duplicated embedded runtime — the code
    // actually written into an install tree and loaded by MiMo — is not kept
    // in sync. Exercises the runtime exactly as `ocp setup` ships it: written
    // to disk fresh and dynamically imported, not the source module.
    const src = providerShimRuntimeSource()
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const dir = await mkdtemp(join(tmpdir(), "ocp-runtime-vocab-"))
    try {
      const runtimePath = join(dir, "ocp-lm-runtime.mjs")
      await Bun.write(runtimePath, src)
      const runtime = (await import(pathToFileURL(runtimePath).href)) as {
        toolRolesForHostId: (id: string) => { tools: Record<string, string> } | undefined
        wrapProviderModule: (
          mod: Record<string, unknown>,
          policy: unknown,
          roles: unknown,
        ) => Record<string, unknown>
      }

      const roles = runtime.toolRolesForHostId("mimo")
      expect(roles).toEqual({ tools: { subagent: "actor", todoWrite: "task", todoRead: "task" } })

      let seenCall: { tools: Array<{ name: string }> } | undefined
      const fakeModule = {
        createFoo: () => ({
          languageModel: () => ({
            doStream: async (call: { tools: Array<{ name: string }> }) => {
              seenCall = call
              const stream = new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: "call1",
                    toolName: "task",
                    input: JSON.stringify({
                      description: "d",
                      prompt: "p",
                      subagent_type: "explorer",
                    }),
                  })
                  controller.close()
                },
              })
              return { stream }
            },
          }),
        }),
      }

      const wrapped = runtime.wrapProviderModule(
        fakeModule,
        { streamToolCallEnsure: false, bashDescriptionRequired: true },
        roles,
      )
      const sdk = (wrapped.createFoo as () => { languageModel: () => { doStream: (c: unknown) => Promise<unknown> } })()
      const model = sdk.languageModel()
      const result = (await model.doStream({
        tools: [
          { name: "actor", inputSchema: { type: "object" } },
          { name: "task", inputSchema: { type: "object" } },
        ],
        prompt: [],
      })) as { stream: ReadableStream }

      // The plugin's own catalog must show canonical names, never the host's
      // rotated `actor` — that is the entire point of translation.
      expect(seenCall?.tools.map((t) => t.name).sort()).toEqual(["task", "todoread", "todowrite"])

      const reader = result.stream.getReader()
      const parts: Array<Record<string, unknown>> = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value as Record<string, unknown>)
      }
      // Canonical `task` call must be restated onto the host's `actor` tool.
      const call = parts.find((p) => p.type === "tool-call")
      expect(call?.toolName).toBe("actor")
      expect(JSON.parse(call?.input as string)).toEqual({
        operation: { action: "run", description: "d", prompt: "p", subagent_type: "explorer" },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("renderProviderShimSource instruments stock create* exports in place", () => {
    const stock = `export const createCursor = () => ({})
export const VERSION = "1.0.0"
`
    const src = renderProviderShimSource(
      {
        entry: "./index.js",
        factories: [
          {
            exportName: "createCursor",
            localName: "createCursor",
            declaration: "const",
          },
        ],
        hostHint: "mimo",
        strategy: "instrumented-entry",
      },
      stock,
    )
    expect(src).toContain(SHIM_MARKER)
    expect(src).toContain("./ocp-lm-runtime.js")
    expect(src).not.toContain("ocp-original")
    expect(src).toContain("installPathBridge(__host, process.env)")
    expect(src).toContain('process.execPath, "mimo"')
    expect(src).toContain("mutable const createCursor")
    expect(src).toContain("export const VERSION")
    expect(src).toContain(
      'createCursor = __ocpWrappedFactories["createCursor"]',
    )
    expect(stripProviderShimSource(src)).toBe(stock)
    // Roles must be resolved and threaded into wrapProviderModule, or the
    // instrumented entry adopts the host's stream/bash policy but never rotates
    // tool vocabulary — the exact gap this generator previously had.
    expect(src).toContain("toolRolesForHostId")
    expect(src).toContain("const __roles = toolRolesForHostId(__host)")
    expect(src).toContain("}, __policy, __roles)")
  })

  test("setupProviderShims writes in-place entry beside stock create* package", async () => {
    const { mkdtemp, rm, readFile, mkdir } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const { existsSync } = await import("node:fs")
    const {
      setupProviderShims,
      discoverExportNames,
      resolvePackageEntryRel,
    } = await import("../packages/cli/src/provider-shim.ts")

    expect(discoverExportNames("export function createFoo() {}")).toEqual([
      "createFoo",
    ])
    expect(resolvePackageEntryRel({ main: "dist/index.js" })).toBe(
      "./dist/index.js",
    )

    const root = await mkdtemp(join(tmpdir(), "ocp-shim-"))
    try {
      const pkgDir = join(
        root,
        "demo-provider@1.0.0",
        "node_modules",
        "demo-provider",
      )
      await mkdir(join(pkgDir, "dist"), { recursive: true })
      await Bun.write(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "demo-provider",
            version: "1.0.0",
            main: "dist/index.js",
            dependencies: { "@ai-sdk/provider": "2.0.0" },
          },
          null,
          2,
        ),
      )
      const original = `export const createDemo = function () {
  return {
    languageModel() {
      return { id: "demo" }
    }
  }
}
export const VERSION = "1.0.0"
`
      await Bun.write(join(pkgDir, "dist", "index.js"), original)

      const utilityDir = join(
        root,
        "fast-check@1.0.0",
        "node_modules",
        "fast-check",
      )
      await mkdir(join(utilityDir, "lib"), { recursive: true })
      await Bun.write(
        join(utilityDir, "package.json"),
        JSON.stringify({
          name: "fast-check",
          version: "1.0.0",
          main: "lib/fast-check.js",
        }),
      )
      const utilitySource = "export function createDepthIdentifier() {}\n"
      await Bun.write(join(utilityDir, "lib", "fast-check.js"), utilitySource)

      const result = setupProviderShims({
        dir: root,
        hostHint: "mimo",
      })
      expect(result.ok).toBe(true)
      expect(result.targets.some((t) => t.changed)).toBe(true)
      expect(result.targets.some((t) => t.packageName === "fast-check")).toBe(
        false,
      )
      expect(await readFile(join(utilityDir, "lib", "fast-check.js"), "utf8")).toBe(
        utilitySource,
      )

      const entry = join(pkgDir, "dist", "index.js")
      const legacyBackup = join(pkgDir, "dist", "index.ocp-original.js")
      const runtime = join(pkgDir, "dist", RUNTIME_FILENAME)
      const meta = join(pkgDir, "dist", SHIM_META_FILENAME)

      expect(existsSync(legacyBackup)).toBe(false)
      expect(existsSync(runtime)).toBe(true)
      expect(existsSync(meta)).toBe(true)

      const shim = await readFile(entry, "utf8")
      expect(shim).toContain(SHIM_MARKER)
      expect(shim).toContain("createDemo")
      expect(stripProviderShimSource(shim)).toBe(original)
      expect(await readFile(runtime, "utf8")).toContain(SHIM_MARKER)
      const loaded = (await import(
        `${pathToFileURL(entry).href}?instrumented=${Date.now()}`
      )) as {
        VERSION: string
        createDemo: () => { languageModel: () => { id: string } }
      }
      expect(loaded.VERSION).toBe("1.0.0")
      expect(loaded.createDemo().languageModel().id).toBe("demo")

      // Idempotent reapplication strips and regenerates the instrumentation;
      // it never needs a captured copy of the stock module.
      const again = setupProviderShims({ dir: root, hostHint: "mimo" })
      expect(again.ok).toBe(true)
      expect(stripProviderShimSource(await readFile(entry, "utf8"))).toBe(
        original,
      )

      // Local TypeScript builds restore the out-of-box entry. Reapplying setup
      // must force-wrap that fresh build and remove any legacy backup artifact.
      const rebuilt = original.replace('"1.0.0"', '"2.0.0"')
      await Bun.write(entry, rebuilt)
      await Bun.write(legacyBackup, "stale legacy backup\n")
      const afterBuild = setupProviderShims({ dir: root, hostHint: "mimo" })
      expect(afterBuild.ok).toBe(true)
      expect(afterBuild.targets.some((t) => t.changed)).toBe(true)
      expect(existsSync(legacyBackup)).toBe(false)
      expect(stripProviderShimSource(await readFile(entry, "utf8"))).toBe(
        rebuilt,
      )

      const afterBuildAgain = setupProviderShims({
        dir: root,
        hostHint: "mimo",
      })
      expect(afterBuildAgain.ok).toBe(true)
      expect(existsSync(legacyBackup)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("setupProviderShims scans an absolute provider package root", async () => {
    const { mkdtemp, rm, readFile, mkdir } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { setupProviderShims } = await import(
      "../packages/cli/src/provider-shim.ts"
    )

    const root = await mkdtemp(join(tmpdir(), "ocp-absolute-provider-"))
    try {
      await mkdir(join(root, "dist"), { recursive: true })
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          name: "absolute-provider",
          main: "dist/index.js",
          dependencies: { "@ai-sdk/provider": "2.0.0" },
        }),
      )
      await Bun.write(
        join(root, "dist", "index.js"),
        "export function createAbsolute() { return {} }\n",
      )

      const result = setupProviderShims({
        dir: root,
        rootOnly: true,
        hostHint: "mimo",
      })
      expect(result.ok).toBe(true)
      expect(result.targets).toHaveLength(1)
      expect(result.targets[0]?.packageDir).toBe(root)
      expect(result.targets.some((target) => target.packageName === "fast-check")).toBe(
        false,
      )
      expect(await readFile(join(root, "dist", "index.js"), "utf8")).toContain(
        SHIM_MARKER,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("setup --no-provider-shim skips Option B", async () => {
    const { parseSetupArgs, setup } = await import(
      "../packages/cli/src/index.ts"
    )
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    expect(parseSetupArgs(["--no-provider-shim"]).providerShim).toBe(false)
    expect(parseSetupArgs(["--provider-shim"]).providerShim).toBe(true)

    const dir = await mkdtemp(join(tmpdir(), "ocp-nosshim-"))
    try {
      const result = setup({
        dir,
        host: "mimo",
        mode: "npm",
        version: "0.1.0",
        reify: false,
        providerShim: false,
        detectOptions: { home: "/tmp" },
      })
      expect(result.ok).toBe(true)
      expect(result.providerShim).toBeUndefined()
      expect(result.message).toContain("--no-provider-shim")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
