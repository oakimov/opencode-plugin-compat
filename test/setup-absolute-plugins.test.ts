import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverAbsolutePluginRoots,
  stripJsonc,
  wireAbsolutePluginFacades,
} from "../packages/cli/src/setup.ts"

describe("ocp setup absolute-path plugin wiring", () => {
  test("discoverAbsolutePluginRoots unions plugins from every config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-abs-"))
    try {
      const pluginA = join(dir, "plugin-a")
      const pluginB = join(dir, "plugin-b")
      mkdirSync(join(pluginA, "dist"), { recursive: true })
      mkdirSync(join(pluginB, "dist"), { recursive: true })
      writeFileSync(join(pluginA, "package.json"), JSON.stringify({ name: "plugin-a" }))
      writeFileSync(join(pluginB, "package.json"), JSON.stringify({ name: "plugin-b" }))
      writeFileSync(join(pluginA, "dist", "index.js"), "export {}\n")
      writeFileSync(join(pluginB, "dist", "index.js"), "export {}\n")

      // First config file has no plugins — previously short-circuited discovery.
      writeFileSync(join(dir, "config.json"), JSON.stringify({ lsp: false }))
      writeFileSync(
        join(dir, "kilo.jsonc"),
        JSON.stringify({
          plugin: [
            join(pluginA, "dist", "index.js"),
            `file://${pluginB}/dist/index.js`,
          ],
        }),
      )

      const roots = discoverAbsolutePluginRoots(dir, [
        "config.json",
        "kilo.json",
        "kilo.jsonc",
      ])
      expect(roots.sort()).toEqual([pluginA, pluginB].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("discoverAbsolutePluginRoots reads JSONC with comments and trailing commas", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-abs-jsonc-"))
    try {
      const plugin = join(dir, "plugin")
      mkdirSync(join(plugin, "dist"), { recursive: true })
      writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "plugin" }))
      writeFileSync(join(plugin, "dist", "index.js"), "export {}\n")
      writeFileSync(
        join(dir, "kilo.jsonc"),
        [
          "{",
          '  "$schema": "https://example.invalid/config.json", // trailing comment',
          '  "permission": { "bash": { "*": "ask", "git *": "allow", }, },',
          "  /* block comment */",
          `  "plugin": [`,
          `    ${JSON.stringify(join(plugin, "dist", "index.js"))},`,
          "  ],",
          "}",
        ].join("\n"),
      )
      expect(discoverAbsolutePluginRoots(dir, ["kilo.jsonc"])).toEqual([plugin])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("stripJsonc leaves string contents alone", () => {
    const raw = '{ "url": "https://x.invalid//a", "s": "a, }", "c": "/* not */", "e": "q\\"//", }'
    expect(JSON.parse(stripJsonc(raw))).toEqual({
      url: "https://x.invalid//a",
      s: "a, }",
      c: "/* not */",
      e: 'q"//',
    })
  })

  test("comments cannot concatenate separate JSON tokens", () => {
    for (const raw of ['{"a":1/* comment */2}', '{"a":tr/* comment */ue}']) {
      expect(() => JSON.parse(stripJsonc(raw))).toThrow()
    }
    expect(JSON.parse(stripJsonc('{"a":/* before */1/* after */}'))).toEqual({ a: 1 })
    expect(JSON.parse(stripJsonc('{// comment\r"a":1}'))).toEqual({ a: 1 })
  })

  test("unfinished block comments are rejected instead of accepting a truncated config", () => {
    expect(() => stripJsonc('{"plugin":[]}/* unfinished')).toThrow("Unterminated JSONC")
    const dir = mkdtempSync(join(tmpdir(), "ocp-invalid-jsonc-"))
    try {
      const plugin = join(dir, "plugin")
      mkdirSync(plugin)
      writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "plugin" }))
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ plugin: [plugin] }) + "/* unfinished")
      expect(discoverAbsolutePluginRoots(dir, ["config.jsonc"])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wireAbsolutePluginFacades replaces stock @opencode-ai/sdk with facade", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocp-wire-"))
    try {
      const pluginRoot = join(dir, "gateway")
      const facadePlugin = join(dir, "facade-plugin")
      const facadeSdk = join(dir, "facade-sdk")
      mkdirSync(join(pluginRoot, "node_modules", "@opencode-ai", "sdk"), {
        recursive: true,
      })
      mkdirSync(facadePlugin, { recursive: true })
      mkdirSync(facadeSdk, { recursive: true })
      writeFileSync(
        join(pluginRoot, "node_modules", "@opencode-ai", "sdk", "package.json"),
        JSON.stringify({ name: "@opencode-ai/sdk", version: "1.18.15" }),
      )
      writeFileSync(
        join(facadePlugin, "package.json"),
        JSON.stringify({ name: "@opencode-compat/facade-plugin" }),
      )
      writeFileSync(
        join(facadeSdk, "package.json"),
        JSON.stringify({ name: "@opencode-compat/facade-sdk" }),
      )

      const result = wireAbsolutePluginFacades({
        pluginRoot,
        facadePlugin,
        facadeSdk,
      })
      expect(result.error).toBeUndefined()
      expect(result.changed).toBe(true)
      expect(result.sdk).toBe(true)

      const again = wireAbsolutePluginFacades({
        pluginRoot,
        facadePlugin,
        facadeSdk,
      })
      expect(again.changed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
