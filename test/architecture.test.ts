import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { buildVocabulary, translateCatalog } from "@opencode-compat/adapter"
import { mimoProfile } from "@opencode-compat/profile"

const ROOT = path.resolve(import.meta.dir, "..")

function filesUnder(relative: string, extensions: readonly string[]): string[] {
  const root = path.join(ROOT, relative)
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      const stat = statSync(file)
      if (stat.isDirectory()) walk(file)
      else if (extensions.some(ext => file.endsWith(ext))) out.push(file)
    }
  }
  walk(root)
  return out
}

function text(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8")
}

function violations(files: readonly string[], pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of files) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) found.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

describe("OCP architecture boundaries", () => {
  test("clone adapter contains no Pi-family runtime identities or paths", () => {
    const files = filesUnder("packages/adapter/src", [".ts"])
    expect(violations(
      files,
      /PI_CODING_AGENT_DIR|PI_CONFIG_DIR|@oh-my-pi|@earendil-works|\.omp(?:["'`/])|\.pi(?:["'`/])|case\s+["'](?:omp|pi)["']/,
    )).toEqual([])
  })

  test("generic Pi entry/core has no static Cursor integration/provider import", () => {
    const generic = [
      "packages/pi-bridge/src/extension.ts",
      "packages/pi-bridge/src/bridge.ts",
      "packages/pi-bridge/src/register.ts",
      "packages/pi-bridge/src/config.ts",
      "packages/pi-bridge/src/path-bridge.ts",
    ].map(file => path.join(ROOT, file))
    expect(violations(
      generic,
      /^\s*import[^\n]*(?:cursor-host-tools|cursor-opencode-provider)/,
    )).toEqual([])
    const extension = text("packages/pi-bridge/src/extension.ts")
    expect(extension).toMatch(/await import\(["']\.\/cursor-host-tools\.js["']\)/)
    expect(extension).toMatch(/await import\(["']\.\/edit-replace-tool\.js["']\)/)
    expect(violations(
      [path.join(ROOT, "packages/pi-bridge/src/cursor-host-tools.ts")],
      /import\(["']cursor-opencode-provider/,
    )).toEqual([])
  })

  test("path installers publish the neutral structural contract", () => {
    for (const file of [
      "packages/adapter/src/runtime-host.ts",
      "packages/pi-bridge/src/path-bridge.ts",
    ]) {
      const source = text(file)
      expect(source).toContain('Symbol.for("opencode.host.path-bridge")')
      expect(source).toContain('Symbol.for("opencode.compat.path-bridge")')
    }
  })

  test("generic provider fixtures remain present for Pi and clone paths", () => {
    expect(existsSync(path.join(ROOT, "test/fixtures/pi-bridge-acme-provider.ts"))).toBe(true)
    const clone = text("test/language-model-adoption.test.ts")
    expect(clone).toContain('"x-provider": "generic"')
    const pi = text("test/pi-bridge-config.test.ts")
    expect(pi).toContain("pi-bridge-acme-provider.ts")
  })

  test("canonical task schema exposes task_id but no fork fields and preserves order", () => {
    const vocab = buildVocabulary(mimoProfile(), ["read", "actor", "custom", "task"])
    if (!vocab) throw new Error("expected MiMo vocabulary")
    const source = [
      { name: "read", inputSchema: {} },
      { name: "actor", inputSchema: {} },
      { name: "custom", inputSchema: {} },
      { name: "task", inputSchema: {} },
    ]
    const translated = translateCatalog(source, vocab)
    const task = translated.find(tool => tool.name === "task") as unknown as {
      inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }
    }
    expect(task.inputSchema.properties.task_id).toBeDefined()
    expect(task.inputSchema.properties.actor_id).toBeUndefined()
    expect(task.inputSchema.additionalProperties).toBe(false)
    expect(translated.map(tool => tool.name)).toEqual([
      "custom",
      "read",
      "task",
      "todoread",
      "todowrite",
    ])
    expect(source.map(tool => tool.name)).toEqual(["read", "actor", "custom", "task"])
  })

  test("dsh-bridge has no Pi host packages or static Cursor provider import", () => {
    const files = filesUnder("packages/dsh-bridge/src", [".ts"])
    expect(violations(
      files,
      /^\s*import[^\n]*(?:@oh-my-pi|@earendil-works|pi-bridge|cursor-opencode-provider|cursor-host-tools)/,
    )).toEqual([])
  })

  test("generic DSH adapter has no provider identity or provider-specific branch", () => {
    const adapter = path.join(ROOT, "packages/dsh-bridge/src/adapter.ts")
    expect(violations(
      [adapter],
      /cursor|devin|isCursorProviderPackage|cursorIntegration|cursorSilentChildNoticeReason/i,
    )).toEqual([])
  })

  test("generic stream adapters receive usage callbacks without reading provider metadata", () => {
    const generic = [
      "packages/adapter/src/language-model.ts",
      "packages/pi-bridge/src/translate/stream.ts",
      "packages/dsh-bridge/src/translate/stream.ts",
    ].map(file => path.join(ROOT, file))
    expect(violations(
      generic,
      /providerMetadata\.cursor|metadata\.cursor|inputTokensRaw|cacheReadRaw|reasoningTokensRaw/,
    )).toEqual([])
    const usage = text("packages/adapter/src/usage-reconciliation.ts")
    expect(usage).toContain("usageVersion === 3")
    expect(usage).not.toMatch(/cursor-opencode-provider|devin-opencode-provider|metadata\.cursor|metadata\.devin/)
    expect(text("packages/pi-bridge/src/register.ts")).toContain('isCursorProviderPackage(spec.package)')
    expect(text("packages/dsh-bridge/src/register.ts")).toContain('isCursorProviderPackage(spec.package)')
  })

  test("dsh-bridge leaves native plan-mode policy and transitions to DSH", () => {
    const files = filesUnder("packages/dsh-bridge/src", [".ts"])
    expect(violations(
      files,
      /plan\/mode|sessionPromptAsync|installDshPlanModeBridge|cursorPlanBridge|createPlanReviewPlan|stripPlanReviewMessage|cursorQuestionFromExitPlanInput/,
    )).toEqual([])
  })
})
