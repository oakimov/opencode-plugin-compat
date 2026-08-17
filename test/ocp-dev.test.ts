import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { applyCloneSlot, revertCloneSlot } from "../scripts/ocp-dev/config-slot.ts"
import { cleanPluginInstalls } from "../scripts/ocp-dev/clone.ts"
import { parseJsonc, toValue } from "../scripts/ocp-dev/jsonc.ts"
import { removePiProvider, upsertPiProvider } from "../scripts/ocp-dev/pi-config.ts"

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
})
