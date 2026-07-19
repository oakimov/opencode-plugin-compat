import { describe, expect, test } from "bun:test"
import {
  CORE_HOOKS,
  detect,
  kiloProfile,
  mimoProfile,
  opencodeProfile,
  PKG,
  VERSION,
  zcodeProfile,
} from "../packages/profile/src/index.ts"

describe("@opencode-compat/profile", () => {
  test("package identity", () => {
    expect(PKG).toBe("@opencode-compat/profile")
    expect(VERSION).toBe("0.1.0")
  })

  test("CORE_HOOKS has 21 portable hooks", () => {
    expect(CORE_HOOKS.length).toBe(21)
    expect(CORE_HOOKS).toContain("auth")
    expect(CORE_HOOKS).toContain("dispose")
    expect(CORE_HOOKS).toContain("experimental.provider.small_model")
  })

  test("opencode draft capabilities", () => {
    const p = opencodeProfile({ home: "/tmp/home", env: {} })
    expect(p.id).toBe("opencode")
    expect(p.capabilities.promiseV2).toBe(true)
    expect(p.capabilities.scansDotOpencode).toBe(true)
    expect(p.paths.projectDirs).toEqual([".opencode"])
    expect(p.hooks.missing).toEqual([])
  })

  test("mimo draft declares gaps and extensions", () => {
    const p = mimoProfile({ home: "/tmp/home", env: {} })
    expect(p.nativePlugin).toBe("@mimo-ai/plugin")
    expect(p.capabilities.promiseV2).toBe(false)
    expect(p.capabilities.scansDotOpencode).toBe(false)
    expect(p.paths.compatProjectDirs).toEqual([".opencode"])
    expect(p.hooks.missing).toContain("dispose")
    expect(p.hooks.extensions).toContain("actor.preStop")
  })

  test("mimo respects MIMOCODE_HOME", () => {
    const p = mimoProfile({
      home: "/tmp/home",
      env: { MIMOCODE_HOME: "/opt/mimo" },
    })
    expect(p.paths.configDir).toBe("/opt/mimo/config")
    expect(p.paths.cacheDir).toBe("/opt/mimo/cache")
  })

  test("kilo draft pin and paths", () => {
    const p = kiloProfile({ home: "/tmp/home", env: {} })
    expect(p.upstreamPin).toBe("v1.17.4")
    expect(p.paths.projectDirs).toEqual([".kilo", ".kilocode"])
    expect(p.paths.pluginInstallDir).toBe("/tmp/home/.cache/kilo/packages")
    expect(p.hooks.missing).toEqual([])
  })

  test("zcode is T0 / ocp none", () => {
    const p = zcodeProfile({ home: "/tmp/home", env: {} })
    expect(p.ocpVersion).toBe("none")
    expect(p.capabilities.classicHooks).toBe(false)
    expect(p.capabilities.marketplacePlugins).toBe(true)
  })

  test("detect respects OPENCODE_COMPAT_HOST", () => {
    const mimo = detect({
      env: { OPENCODE_COMPAT_HOST: "mimo" },
      home: "/tmp/home",
    })
    expect(mimo.supported).toBe(true)
    expect(mimo.id).toBe("mimo")
    expect(mimo.source).toBe("env")

    const zcode = detect({
      env: { OPENCODE_COMPAT_HOST: "zcode" },
      home: "/tmp/home",
    })
    expect(zcode.supported).toBe(false)
    expect(zcode.id).toBe("zcode")
    expect(zcode.message).toContain("T0")
    expect(zcode.message).toContain("marketplace")
  })

  test("detect uses binary hint", () => {
    const kilo = detect({
      env: {},
      home: "/tmp/home",
      argv: ["/usr/bin/kilocode"],
      existsSync: () => false,
    })
    expect(kilo.id).toBe("kilo")
    expect(kilo.source).toBe("binary")
    expect(kilo.supported).toBe(true)
  })

  test("detect falls back to unknown", () => {
    const unknown = detect({
      env: {},
      home: "/tmp/empty-home",
      argv: ["node"],
      execPath: "/usr/bin/node",
      existsSync: () => false,
    })
    expect(unknown.id).toBe("unknown")
    expect(unknown.supported).toBe(false)
    expect(unknown.source).toBe("fallback")
  })
})

describe("@opencode-compat/adapter", () => {
  test("requireHost throws on zcode", async () => {
    const { requireHost } = await import("../packages/adapter/src/index.ts")
    expect(() =>
      requireHost({ env: { OPENCODE_COMPAT_HOST: "zcode" }, home: "/tmp" }),
    ).toThrow(/T0/)
  })

  test("doctorReport ok for opencode", async () => {
    const { doctorReport } = await import("../packages/adapter/src/index.ts")
    const report = doctorReport({
      env: { OPENCODE_COMPAT_HOST: "opencode" },
      home: "/tmp",
    })
    expect(report.ok).toBe(true)
    expect(report.result.id).toBe("opencode")
  })

  test("doctorReport privacy hints for kilo/mimo/zcode", async () => {
    const { doctorReport } = await import("../packages/adapter/src/index.ts")
    const kilo = doctorReport({
      env: { OPENCODE_COMPAT_HOST: "kilo" },
      home: "/tmp",
    })
    expect(kilo.summary).toContain("kilocode-telemetry-disable.md")

    const mimo = doctorReport({
      env: { OPENCODE_COMPAT_HOST: "mimo" },
      home: "/tmp",
    })
    expect(mimo.summary).toContain("mimocode-telemetry-disable.md")
    expect(mimo.summary).toContain("MIMOCODE_ENABLE_ANALYSIS=false")

    const zcode = doctorReport({
      env: { OPENCODE_COMPAT_HOST: "zcode" },
      home: "/tmp",
    })
    expect(zcode.ok).toBe(false)
    expect(zcode.summary).toContain("zcode-telemetry-block.md")
  })

  test("nativePluginSpecifier for mimo tool", async () => {
    const { nativePluginSpecifier } = await import(
      "../packages/adapter/src/index.ts"
    )
    expect(
      nativePluginSpecifier("tool", {
        env: { OPENCODE_COMPAT_HOST: "mimo" },
        home: "/tmp",
      }),
    ).toBe("@mimo-ai/plugin/tool")
  })

  test("importNativePlugin uses importer hook", async () => {
    const { importNativePlugin } = await import(
      "../packages/adapter/src/index.ts"
    )
    const mod = await importNativePlugin("tool", {
      env: { OPENCODE_COMPAT_HOST: "kilo" },
      home: "/tmp",
      importer: async (specifier) => {
        expect(specifier).toBe("@kilocode/plugin/tool")
        return { tool: (input: unknown) => input }
      },
    })
    expect(typeof mod.tool).toBe("function")
  })

  test("normalizeHooks warns on mimo gaps", async () => {
    const { normalizeHooks } = await import("../packages/adapter/src/index.ts")
    const warnings: string[] = []
    const profile = mimoProfile({ home: "/tmp", env: {} })
    const hooks = normalizeHooks(
      {
        dispose: async () => {},
        auth: { provider: "x", methods: [] },
      },
      profile,
      { onWarn: (m) => warnings.push(m) },
    )
    expect(hooks.auth?.provider).toBe("x")
    expect(warnings.some((w) => w.includes("dispose"))).toBe(true)
  })

  test("wrapClassicPlugin normalizes returned hooks", async () => {
    const { wrapClassicPlugin } = await import(
      "../packages/adapter/src/index.ts"
    )
    const warnings: string[] = []
    const wrapped = wrapClassicPlugin(
      async () => ({
        dispose: async () => {},
        config: async () => {},
      }),
      {
        env: { OPENCODE_COMPAT_HOST: "mimo" },
        home: "/tmp",
        onWarn: (m) => warnings.push(m),
      },
    )
    const hooks = await wrapped({} as never)
    expect(hooks.config).toBeDefined()
    expect(warnings.some((w) => w.includes("dispose"))).toBe(true)
  })
})

describe("@opencode-compat/facade-plugin", () => {
  test("tool() is identity with zod schema", async () => {
    const { tool } = await import("../packages/facade-plugin/src/tool.ts")
    const def = tool({
      description: "echo",
      args: { msg: tool.schema.string() },
      async execute(args) {
        return args.msg
      },
    })
    expect(def.description).toBe("echo")
    expect(await def.execute({ msg: "hi" }, {} as never)).toBe("hi")
    expect(tool.schema.string().parse("x")).toBe("x")
  })

  test("classic Hooks type accepts auth hook shape", async () => {
    const mod = await import("../packages/facade-plugin/src/index.ts")
    const hooks: import("../packages/facade-plugin/src/types.ts").Hooks = {
      auth: {
        provider: "demo",
        methods: [
          {
            type: "api",
            label: "API key",
            async authorize() {
              return { type: "success", key: "k" }
            },
          },
        ],
      },
    }
    expect(hooks.auth?.provider).toBe("demo")
    expect(mod.PKG).toBe("@opencode-compat/facade-plugin")
  })

  test("v2/promise loud-fails without promiseV2", async () => {
    const prev = process.env.OPENCODE_COMPAT_HOST
    process.env.OPENCODE_COMPAT_HOST = "mimo"
    try {
      const { define } = await import(
        "../packages/facade-plugin/src/v2/promise.ts"
      )
      expect(() => define({ async setup() {} })).toThrow(
        /Promise v2 not available/,
      )
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COMPAT_HOST
      else process.env.OPENCODE_COMPAT_HOST = prev
    }
  })

  test("v2/promise define works when host has promiseV2", async () => {
    const prev = process.env.OPENCODE_COMPAT_HOST
    process.env.OPENCODE_COMPAT_HOST = "opencode"
    try {
      const { define } = await import(
        "../packages/facade-plugin/src/v2/promise.ts"
      )
      const plugin = define({
        async setup(ctx) {
          expect(ctx.aisdk).toBeDefined()
        },
      })
      expect(typeof plugin.setup).toBe("function")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_COMPAT_HOST
      else process.env.OPENCODE_COMPAT_HOST = prev
    }
  })

  test("v2/effect loud-fails", async () => {
    const mod = await import("../packages/facade-plugin/src/v2/effect.ts")
    expect(() => mod.define({})).toThrow(/Effect v2 not supported/)
  })
})

describe("@opencode-compat/facade-sdk", () => {
  test("Auth union and injected client factory", async () => {
    const {
      createOpencodeClient,
      setCreateOpencodeClient,
      PKG: sdkPkg,
    } = await import("../packages/facade-sdk/src/index.ts")
    expect(sdkPkg).toBe("@opencode-compat/facade-sdk")
    setCreateOpencodeClient(() => ({ ping: true }))
    expect(createOpencodeClient().ping).toBe(true)
    setCreateOpencodeClient(undefined)
    expect(() => createOpencodeClient()).toThrow(/no native factory/)
  })
})

describe("@opencode-compat/cli", () => {
  test("doctor reports zcode unsupported", async () => {
    const { doctor } = await import("../packages/cli/src/index.ts")
    const result = doctor({
      env: { OPENCODE_COMPAT_HOST: "zcode" },
      home: "/tmp",
    })
    expect(result.ok).toBe(false)
    expect(result.host).toBe("zcode")
    expect(result.message).toContain("marketplace")
  })

  test("doctor ok for kilo override", async () => {
    const { doctor } = await import("../packages/cli/src/index.ts")
    const result = doctor({
      env: { OPENCODE_COMPAT_HOST: "kilo" },
      home: "/tmp",
    })
    expect(result.ok).toBe(true)
    expect(result.host).toBe("kilo")
  })

  test("doctor zcode mentions migrate-zcode companion", async () => {
    const { doctor } = await import("../packages/cli/src/index.ts")
    const result = doctor({
      env: { OPENCODE_COMPAT_HOST: "zcode" },
      home: "/tmp",
    })
    expect(result.message).toContain("migrate-zcode")
    expect(result.message).toContain("host MCP")
  })

  test("setup writes Layer A overrides into install tree", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { setup, parseSetupArgs } = await import("../packages/cli/src/index.ts")
    const { facadeOverrides } = await import("../packages/profile/src/index.ts")

    const parsed = parseSetupArgs([
      "--dir",
      "/tmp/x",
      "--mode",
      "npm",
      "--dry-run",
      "--no-deep",
    ])
    expect(parsed.dryRun).toBe(true)
    expect(parsed.mode).toBe("npm")
    expect(parsed.deep).toBe(false)

    const dir = await mkdtemp(join(tmpdir(), "ocp-setup-"))
    try {
      await Bun.write(
        join(dir, "demo-plugin", "package.json"),
        JSON.stringify({ name: "demo-plugin", version: "1.0.0" }, null, 2),
      )
      const result = setup({
        dir,
        host: "mimo",
        mode: "npm",
        version: "0.1.0",
        detectOptions: { home: "/tmp" },
      })
      expect(result.ok).toBe(true)
      expect(result.host).toBe("mimo")
      expect(result.mode).toBe("npm")
      expect(result.overrides).toEqual(facadeOverrides("0.1.0"))
      expect(result.targets.some((t) => t.changed)).toBe(true)

      const root = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      expect(root.overrides["@opencode-ai/plugin"]).toBe(
        "npm:@opencode-compat/facade-plugin@0.1.0",
      )
      expect(root.overrides["@opencode-ai/sdk"]).toBe(
        "npm:@opencode-compat/facade-sdk@0.1.0",
      )

      const child = JSON.parse(
        await readFile(join(dir, "demo-plugin", "package.json"), "utf8"),
      )
      expect(child.overrides["@opencode-ai/plugin"]).toBe(
        "npm:@opencode-compat/facade-plugin@0.1.0",
      )

      // idempotent second pass
      const again = setup({
        dir,
        host: "mimo",
        mode: "npm",
        version: "0.1.0",
        detectOptions: { home: "/tmp" },
      })
      expect(again.ok).toBe(true)
      expect(again.targets.every((t) => !t.changed)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("setup --mode file uses monorepo facade paths", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { setup } = await import("../packages/cli/src/index.ts")

    const dir = await mkdtemp(join(tmpdir(), "ocp-setup-file-"))
    try {
      const result = setup({
        dir,
        host: "kilo",
        mode: "file",
        deep: false,
        detectOptions: { home: "/tmp" },
      })
      expect(result.ok).toBe(true)
      expect(result.mode).toBe("file")
      expect(result.overrides["@opencode-ai/plugin"]).toMatch(/facade-plugin/)
      expect(result.overrides["@opencode-ai/plugin"]).toMatch(/^file:/)
      expect(result.overrides["@opencode-ai/sdk"]).toMatch(/^file:/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("migrate-zcode CLI dry-run on mock plugin", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const {
      runMigrateZcodeCli,
      parseMigrateZcodeArgs,
      migrateZcodeExitCode,
    } = await import("../packages/cli/src/index.ts")

    const parsed = parseMigrateZcodeArgs([
      "--plugin",
      "/tmp/x",
      "--dry-run",
      "--format=json",
    ])
    expect(parsed.dryRun).toBe(true)
    expect(parsed.format).toBe("json")
    expect(parsed.plugins).toEqual(["/tmp/x"])

    const multi = parseMigrateZcodeArgs([
      "--plugin",
      "/tmp/a",
      "--plugin",
      "/tmp/b",
      "--marketplace-name",
      "fleet",
      "--owner-name",
      "tester",
    ])
    expect(multi.plugins).toEqual(["/tmp/a", "/tmp/b"])
    expect(multi.marketplaceName).toBe("fleet")
    expect(multi.ownerName).toBe("tester")

    const pluginDir = await mkdtemp(join(tmpdir(), "ocp-cli-mig-"))
    try {
      await Bun.write(
        join(pluginDir, "skills", "gamma", "SKILL.md"),
        `---
name: gamma
description: Gamma
---
Body
`,
      )
      const code = await runMigrateZcodeCli([
        "--plugin",
        pluginDir,
        "--dry-run",
        "--format",
        "json",
      ])
      expect(code).toBe(0)
      expect(
        migrateZcodeExitCode({
          ok: false,
          pluginDir,
          included: { skills: [], commands: [], manifests: [] },
          skipped: [],
          warnings: ["empty-migration: none"],
        }),
      ).toBe(2)
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })
})

describe("@opencode-compat/ocp", () => {
  test("umbrella identity and re-exports", async () => {
    const ocp = await import("../packages/ocp/src/index.ts")
    expect(ocp.PKG).toBe("@opencode-compat/ocp")
    expect(ocp.VERSION).toBe("0.1.0")
    expect(typeof ocp.setup).toBe("function")
    expect(typeof ocp.doctor).toBe("function")
    expect(typeof ocp.facadeOverrides).toBe("function")
  })
})
