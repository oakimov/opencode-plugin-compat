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
  ORIGINAL_SUFFIX,
  policyForHostId,
  policyFromProfile,
  providerShimRuntimeSource,
  renderProviderShimSource,
  RUNTIME_FILENAME,
  SHIM_MARKER,
  SHIM_META_FILENAME,
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
      async doGenerate() {
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
    expect(result.content[1].input).toEqual({
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
              async doGenerate() {
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
      (out.content[1].input as { description: string }).description,
    ).toBe(defaultBashDescription("uname"))
  })
})

describe("provider shim source + install-tree setup", () => {
  test("runtime source detects worker markers and falls back to its install-tree host", async () => {
    const src = providerShimRuntimeSource()
    expect(src).toContain(SHIM_MARKER)
    expect(src).toContain('case "mimo"')
    expect(src).toContain("streamToolCallEnsure: false")
    expect(src).toContain("bashDescriptionRequired: true")
    expect(src).toContain("tool-input-start")

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
        normalizeToolInputForSchema: (input: unknown, schema: unknown) => unknown
      }
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

  test("renderProviderShimSource re-exports create* via wrapProviderModule", () => {
    const src = renderProviderShimSource({
      original: "./index.ocp-original.js",
      entry: "./index.js",
      exportNames: ["createCursor", "VERSION"],
      hostHint: "mimo",
      strategy: "inplace-entry",
    })
    expect(src).toContain(SHIM_MARKER)
    expect(src).toContain("./ocp-lm-runtime.js")
    expect(src).toContain('from "./index.ocp-original.js"')
    expect(src).toContain('process.execPath, "mimo"')
    expect(src).toContain("export const createCursor")
    expect(src).toContain("export const VERSION")
  })

  test("setupProviderShims writes in-place entry beside stock create* package", async () => {
    const { mkdtemp, rm, readFile, mkdir } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
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
      const original = `export function createDemo() {
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

      const result = setupProviderShims({ dir: root, hostHint: "mimo" })
      expect(result.ok).toBe(true)
      expect(result.targets.some((t) => t.changed)).toBe(true)
      expect(result.targets.some((t) => t.packageName === "fast-check")).toBe(
        false,
      )
      expect(await readFile(join(utilityDir, "lib", "fast-check.js"), "utf8")).toBe(
        utilitySource,
      )

      const entry = join(pkgDir, "dist", "index.js")
      const backup = join(pkgDir, "dist", `index${ORIGINAL_SUFFIX}`)
      const runtime = join(pkgDir, "dist", RUNTIME_FILENAME)
      const meta = join(pkgDir, SHIM_META_FILENAME)

      expect(existsSync(backup)).toBe(true)
      expect(existsSync(runtime)).toBe(true)
      expect(existsSync(meta)).toBe(true)
      expect(await readFile(backup, "utf8")).toBe(original)

      const shim = await readFile(entry, "utf8")
      expect(shim).toContain(SHIM_MARKER)
      expect(shim).toContain("createDemo")
      expect(await readFile(runtime, "utf8")).toContain("adoptStreamPart")

      // idempotent refresh
      const again = setupProviderShims({ dir: root, hostHint: "mimo" })
      expect(again.ok).toBe(true)
      expect(await readFile(backup, "utf8")).toBe(original)
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
