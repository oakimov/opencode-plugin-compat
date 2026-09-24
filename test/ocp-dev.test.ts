import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { applyCloneSlot, revertCloneSlot } from "../scripts/ocp-dev/config-slot.ts"
import { cleanPluginInstalls } from "../scripts/ocp-dev/clone.ts"
import { parseJsonc, toValue } from "../scripts/ocp-dev/jsonc.ts"
import { removePiProvider, upsertPiProvider } from "../scripts/ocp-dev/pi-config.ts"
import { dshBuiltCli, dshHarnessRoot, isDshHarnessCheckout } from "../scripts/ocp-dev/hosts.ts"
import {
  formatDshBridgePatch,
  stageDshBridgeForForeignFileInstall,
  syncInstalledFilePackageDist,
} from "../scripts/ocp-dev/dsh-family.ts"
import { avoidProviderIdCollision, dshProfile } from "../packages/dsh-bridge/src/host/profile.ts"
import { defaultDevinProviderPath } from "../scripts/ocp-dev/paths.ts"
import { dshWorkspacePackageCwdFilter } from "../scripts/ocp-dev/dsh-tsdown.ts"
import {
  assertForeignFileInstallExactPins,
  FOREIGN_FILE_INSTALL_PACKAGES,
} from "../scripts/publish.ts"

describe("clone cache cleanup", () => {
  test("removes every cached plugin version without touching other packages", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-host-clean-"))
    const packages = join(root, "cache", "packages")
    try {
      for (const dir of [
        join(packages, "cursor-opencode-provider@latest"),
        join(packages, "cursor-opencode-provider@0.4.0"),
        join(packages, "node_modules", "cursor-opencode-provider"),
        join(packages, "unrelated-provider@latest"),
      ]) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "marker"), "present\n")
      }
      cleanPluginInstalls(packages, "cursor-opencode-provider")
      expect(existsSync(join(packages, "cursor-opencode-provider@latest"))).toBe(false)
      expect(existsSync(join(packages, "cursor-opencode-provider@0.4.0"))).toBe(false)
      expect(existsSync(join(packages, "node_modules", "cursor-opencode-provider"))).toBe(false)
      expect(existsSync(join(packages, "unrelated-provider@latest"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a cache target that is not a packages directory", () => {
    expect(() => cleanPluginInstalls("/tmp", "cursor-opencode-provider")).toThrow("must end in /packages")
  })
})

describe("clone config slot", () => {
  test("inserts and reverts without destroying comments or sibling keys", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-slot-"))
    try {
      const stock = join(root, "stock-provider")
      const stockEntry = join(stock, "dist", "index.js")
      const wrapperEntry = join(root, "wrapper", "dist", "index.js")
      const configPath = join(root, "kilo.jsonc")
      mkdirSync(join(stock, "dist"), { recursive: true })
      writeFileSync(stockEntry, "export default {}\n")
      writeFileSync(
        configPath,
        `{
  // keep
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [${JSON.stringify(stockEntry)}, "/other/user-plugin.js"],
  "permission": { "bash": { "*": "ask" } },
  "provider": { "cursor": { "npm": ${JSON.stringify(`file://${stockEntry}`)}, "name": "Cursor" } }
}
`,
      )
      const manifest = applyCloneSlot({
        configPath,
        manifestPath: join(root, "state.json"),
        host: "kilo",
        mode: "local",
        pluginEntry: wrapperEntry,
        providerNpm: `file://${wrapperEntry}`,
        stock,
        wrapper: join(root, "wrapper"),
      })
      const wired = readFileSync(configPath, "utf8")
      expect(wired).toContain("// keep")
      expect(wired).toContain('"$schema": "https://app.kilo.ai/config.json"')
      expect(wired).toContain('"permission": { "bash": { "*": "ask" } }')
      const value = toValue(parseJsonc(wired)) as {
        plugin: string[]
        provider: { cursor: { npm: string; name: string } }
      }
      expect(value.plugin).toEqual(["/other/user-plugin.js", wrapperEntry])
      expect(value.provider.cursor.npm).toBe(`file://${wrapperEntry}`)
      expect(value.provider.cursor.name).toBe("Cursor")
      expect(manifest.config.stockPluginEntriesBefore).toEqual([stockEntry])

      revertCloneSlot(manifest)
      const restored = readFileSync(configPath, "utf8")
      expect(restored).toContain("// keep")
      expect(restored).toContain('"permission": { "bash": { "*": "ask" } }')
      const after = toValue(parseJsonc(restored)) as {
        plugin: string[]
        provider: { cursor: { npm: string; name: string } }
      }
      expect(after.plugin).toEqual(["/other/user-plugin.js", stockEntry])
      expect(after.provider.cursor.npm).toBe(`file://${stockEntry}`)
      expect(after.provider.cursor.name).toBe("Cursor")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("pi-bridge config", () => {
  test("upserts one provider and leaves the others plus file mode intact", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-pi-config-"))
    const provider = join(root, "cursor-opencode-provider")
    const config = join(root, "agent", "pi-bridge.json")
    try {
      mkdirSync(join(provider, "dist"), { recursive: true })
      mkdirSync(join(root, "agent"), { recursive: true })
      writeFileSync(join(provider, "package.json"), '{"name":"cursor-opencode-provider"}\n')
      writeFileSync(join(provider, "dist", "index.js"), "export {}\n")
      writeFileSync(
        config,
        `{
  // keep
  "providers": [
    { "package": "other-provider", "apiKey": "OTHER_KEY" },
    { "packageSpecifier": "cursor-opencode-provider", "splitDimensions": [] }
  ]
}
`,
        { mode: 0o640 },
      )
      chmodSync(config, 0o640)
      const localEntry = join(provider, "dist", "index.js")
      upsertPiProvider(config, localEntry, "cursor-opencode-provider")
      let raw = readFileSync(config, "utf8")
      expect(raw).toContain("// keep")
      expect(toValue(parseJsonc(raw))).toEqual({
        providers: [
          { package: "other-provider", apiKey: "OTHER_KEY" },
          { package: localEntry, splitDimensions: [] },
        ],
      })
      upsertPiProvider(config, "cursor-opencode-provider", "cursor-opencode-provider")
      raw = readFileSync(config, "utf8")
      expect(raw).toContain("// keep")
      expect(toValue(parseJsonc(raw))).toEqual({
        providers: [
          { package: "other-provider", apiKey: "OTHER_KEY" },
          { package: "cursor-opencode-provider", splitDimensions: [] },
        ],
      })
      removePiProvider(config, "cursor-opencode-provider")
      raw = readFileSync(config, "utf8")
      expect(raw).toContain("// keep")
      expect(toValue(parseJsonc(raw))).toEqual({
        providers: [{ package: "other-provider", apiKey: "OTHER_KEY" }],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("creates a private file when none exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-pi-new-"))
    const config = join(root, "nested", "pi-bridge.json")
    try {
      upsertPiProvider(config, "demo-provider", "demo-provider")
      expect(toValue(parseJsonc(readFileSync(config, "utf8")))).toEqual({
        providers: [{ package: "demo-provider" }],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("orchestrator", () => {
  test("shell entrypoint only execs the TypeScript CLI", () => {
    const script = resolve(import.meta.dir, "../scripts/ocp-dev.sh")
    const source = readFileSync(script, "utf8")
    expect(source).toContain("scripts/ocp-dev/cli.ts")
    expect(source).not.toContain("host-dev-common")
    expect(source).not.toContain("pi-family-dev-common")
  })

  test("refuses to shim native OpenCode", async () => {
    const cli = resolve(import.meta.dir, "../scripts/ocp-dev/cli.ts")
    const result = Bun.spawnSync({
      cmd: ["bun", cli, "run", "opencode"],
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${result.stdout}${result.stderr}`
    expect(result.exitCode).not.toBe(0)
    expect(output).toContain("opencode is native")
  })
})

describe("dsh discovery", () => {
  test("prefers DSH_HARNESS_ROOT over a sibling name", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-dsh-harness-"))
    try {
      mkdirSync(join(root, "packages", "bundle"), { recursive: true })
      writeFileSync(join(root, "package.json"), "{}\n")
      const previous = process.env.DSH_HARNESS_ROOT
      process.env.DSH_HARNESS_ROOT = root
      try {
        expect(dshHarnessRoot()).toBe(resolve(root))
        expect(isDshHarnessCheckout(root)).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.DSH_HARNESS_ROOT
        else process.env.DSH_HARNESS_ROOT = previous
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not treat a random package.json as a harness checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-dsh-not-harness-"))
    try {
      writeFileSync(join(root, "package.json"), "{}\n")
      expect(isDshHarnessCheckout(root)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pi-bridge and dsh-bridge keep exact train pins for foreign file: installs", () => {
    expect([...FOREIGN_FILE_INSTALL_PACKAGES]).toEqual(["pi-bridge", "dsh-bridge"])
    expect(() => assertForeignFileInstallExactPins()).not.toThrow()
    for (const dir of FOREIGN_FILE_INSTALL_PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dir, `../packages/${dir}/package.json`), "utf8"),
      ) as { dependencies?: Record<string, string> }
      for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
        if (!name.startsWith("@opencode-compat/")) continue
        expect(range).not.toMatch(/^workspace:/)
        expect(range).toMatch(/^\d+\.\d+\.\d+/)
      }
    }
  })

  test("stages dsh-bridge with file: opencode-loader for profile pnpm", () => {
    const previous = process.env.OCP_DEV_STATE_DIR
    const root = mkdtempSync(join(tmpdir(), "ocp-dsh-stage-"))
    try {
      process.env.OCP_DEV_STATE_DIR = root
      const bridge = resolve(import.meta.dir, "../packages/dsh-bridge")
      const loader = resolve(import.meta.dir, "../packages/opencode-loader")
      const staged = stageDshBridgeForForeignFileInstall(bridge, loader, join(root, "dsh", "bridge-file"))
      const pkg = JSON.parse(readFileSync(join(staged, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      expect(pkg.dependencies["@opencode-compat/opencode-loader"]).toBe(`file:${loader}`)
      expect(existsSync(join(staged, "dist"))).toBe(true)
      expect(existsSync(join(staged, "cordis.patch.yml"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OCP_DEV_STATE_DIR
      else process.env.OCP_DEV_STATE_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("copies newly emitted dist files into an existing file: profile package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-dsh-dist-sync-"))
    try {
      const source = join(root, "source")
      const dest = join(root, "dest")
      mkdirSync(join(source, "dist", "translate"), { recursive: true })
      mkdirSync(join(dest, "dist", "translate"), { recursive: true })
      writeFileSync(join(source, "dist", "index.js"), "export const n = 1\n")
      writeFileSync(join(source, "dist", "translate", "question.js"), "export const q = 1\n")
      writeFileSync(join(dest, "dist", "index.js"), "export const n = 0\n")
      expect(syncInstalledFilePackageDist(source, dest)).toBe(true)
      expect(readFileSync(join(dest, "dist", "index.js"), "utf8")).toContain("n = 1")
      expect(readFileSync(join(dest, "dist", "translate", "question.js"), "utf8")).toContain("q = 1")
      expect(syncInstalledFilePackageDist(source, join(root, "missing"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("launches the built CLI instead of checkout pnpm dsh / tsx", () => {
    expect(dshBuiltCli("/tmp/harness")).toBe(resolve("/tmp/harness/apps/cli/lib/bin.js"))
    const source = readFileSync(resolve(import.meta.dir, "../scripts/ocp-dev/dsh-family.ts"), "utf8")
    expect(source).toContain("dshBuiltCli")
    expect(source).toContain("apps/cli/lib/bin.js")
    expect(source).not.toContain("pnpm --prefix ${harness} dsh web")
  })

  test("does not hardcode a home-directory harness checkout", () => {
    const files = [
      resolve(import.meta.dir, "../scripts/ocp-dev/hosts.ts"),
      resolve(import.meta.dir, "../scripts/ocp-dev/dsh-family.ts"),
      resolve(import.meta.dir, "../scripts/ocp-dev/dsh-tsdown.ts"),
      resolve(import.meta.dir, "../scripts/ocp-dev/cli.ts"),
    ]
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source).not.toMatch(/homedir\(\)[^\n]+deepseek-harness/)
    }
  })

  test("local shim always runs the harness build", () => {
    const source = readFileSync(resolve(import.meta.dir, "../scripts/ocp-dev/dsh-family.ts"), "utf8")
    expect(source).toContain("buildHarness")
    expect(source).toContain('["pnpm", "install"]')
    expect(source).toContain('["pnpm", "run", "build:native-system"]')
    expect(source).toContain('["pnpm", "run", "build:web"]')
    expect(source).toContain("runDshTsdown")
  })

  test("formats Cursor and Devin DSH provider rows", () => {
    const yaml = formatDshBridgePatch([
      { package: "/abs/cursor-opencode-provider/dist/index.js", apiKey: "CURSOR_API_KEY" },
      { package: "/abs/devin-opencode-provider/dist/index.js", apiKey: "DEVIN_API_KEY" },
    ])
    expect(yaml).toContain("package: '/abs/cursor-opencode-provider/dist/index.js'")
    expect(yaml).toContain("apiKey: CURSOR_API_KEY")
    expect(yaml).toContain("package: '/abs/devin-opencode-provider/dist/index.js'")
    expect(yaml).toContain("apiKey: DEVIN_API_KEY")
  })

  test("resolves Devin checkout from OCP_DEV_DEVIN_PROVIDER_PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-devin-provider-"))
    const previous = process.env.OCP_DEV_DEVIN_PROVIDER_PATH
    try {
      writeFileSync(join(root, "package.json"), '{"name":"devin-opencode-provider"}\n')
      process.env.OCP_DEV_DEVIN_PROVIDER_PATH = root
      expect(defaultDevinProviderPath()).toBe(resolve(root))
    } finally {
      if (previous === undefined) delete process.env.OCP_DEV_DEVIN_PROVIDER_PATH
      else process.env.OCP_DEV_DEVIN_PROVIDER_PATH = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("DSH de-collides reserved devin id to devin-opencode", () => {
    expect(avoidProviderIdCollision("devin", dshProfile())).toBe("devin-opencode")
  })

  test("tsdown workspace filter skips leftover dirs without package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-dsh-tsdown-"))
    try {
      mkdirSync(join(root, "vendor", "cordis"), { recursive: true })
      mkdirSync(join(root, "packages", "core", "agent-loop"), { recursive: true })
      mkdirSync(join(root, "packages", "fs", "tool-present"), { recursive: true })
      mkdirSync(join(root, "apps", "cli"), { recursive: true })
      mkdirSync(join(root, "apps", "desktop"), { recursive: true })
      writeFileSync(join(root, "vendor", "cordis", "package.json"), "{}\n")
      writeFileSync(join(root, "packages", "core", "agent-loop", "package.json"), "{}\n")
      writeFileSync(join(root, "apps", "cli", "package.json"), "{}\n")
      writeFileSync(join(root, "apps", "desktop", "package.json"), "{}\n")
      const host = dshWorkspacePackageCwdFilter(root, "host")
      expect(host.test("vendor/cordis")).toBe(true)
      expect(host.test("packages/core/agent-loop")).toBe(true)
      expect(host.test("packages/fs/tool-present")).toBe(false)
      expect(host.test("apps/cli")).toBe(true)
      expect(host.test("apps/desktop")).toBe(true)
      const client = dshWorkspacePackageCwdFilter(root, "client")
      expect(client.test("apps/cli")).toBe(true)
      expect(client.test("apps/desktop")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
