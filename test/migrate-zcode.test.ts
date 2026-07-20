import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EMITTER_VERSION,
  PKG,
  VERSION,
  buildMarketplaceJson,
  migrateZcode,
  migrateZcodeMarketplace,
  pluginSlug,
  sanitizeCommandMarkdown,
  sanitizeSkillMarkdown,
} from "../packages/migrate-zcode/src/index.ts"

const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe("@opencode-compat/migrate-zcode identity", () => {
  test("package constants", () => {
    expect(PKG).toBe("@opencode-compat/migrate-zcode")
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(EMITTER_VERSION).toContain("marketplace")
  })
})

describe("markdown sanitizers", () => {
  test("skill keeps name+description only", () => {
    const { name, content, dropped } = sanitizeSkillMarkdown(
      `---
name: demo
description: Hello
slash: /demo
---
Body
`,
      "fallback",
    )
    expect(name).toBe("demo")
    expect(dropped).toContain("slash")
    expect(content).toContain("name: demo")
    expect(content).not.toContain("slash:")
  })

  test("command drops model/agent", () => {
    const { dropped, content } = sanitizeCommandMarkdown(
      `---
description: Do it
model: gpt
agent: build
---
Run
`,
      "doit",
    )
    expect(dropped).toEqual(expect.arrayContaining(["model", "agent"]))
    expect(content).toContain("description: Do it")
    expect(content).not.toContain("model:")
  })
})

describe("migrate plugin package (mocked dirs)", () => {
  test("packs skills, commands, and zcode manifest; skips JS entry", async () => {
    const pluginDir = await tempDir("ocp-mig-plugin-")
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "mock-vendor-plugin",
        version: "1.2.3",
        main: "./dist/index.js",
      }),
    )
    await Bun.write(
      join(pluginDir, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "mock-vendor-plugin",
        version: "1.2.3",
        description: "mock",
        skills: "./skills",
      }),
    )
    await Bun.write(
      join(pluginDir, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill
slash: /alpha
---
Use alpha.
`,
    )
    await Bun.write(
      join(pluginDir, "commands", "ship.md"),
      `---
description: Ship it
model: whatever
---
Ship the thing.
`,
    )

    const outDir = await tempDir("ocp-mig-out-")
    const { report, tree } = await migrateZcode({
      pluginDir,
      outDir,
      dryRun: false,
    })

    expect(report.ok).toBe(true)
    expect(report.included.skills).toContain("skills/alpha/SKILL.md")
    expect(report.included.commands).toContain("commands/ship.md")
    expect(report.included.manifests.some((p) => p.includes("plugin.json"))).toBe(
      true,
    )
    expect(
      report.skipped.some((s) => s.reason === "ocp-abi-not-migratable"),
    ).toBe(true)
    expect(tree?.pluginJson.name).toBe("mock-vendor-plugin")

    const emittedSkill = await Bun.file(
      join(outDir, "skills", "alpha", "SKILL.md"),
    ).text()
    expect(emittedSkill).toContain("name: alpha")
    expect(emittedSkill).not.toContain("slash:")

    const emittedCmd = await Bun.file(
      join(outDir, "commands", "ship.md"),
    ).text()
    expect(emittedCmd).not.toContain("model:")

    const pluginJson = await Bun.file(
      join(outDir, ".zcode-plugin", "plugin.json"),
    ).json()
    expect(pluginJson.skills).toBe("./skills")
    expect(pluginJson.commands).toBe("./commands")
  })

  test("hooks-only plugin reports empty without allowEmpty", async () => {
    const pluginDir = await tempDir("ocp-mig-hooks-")
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "hooks-only",
        version: "0.0.1",
        main: "./index.js",
      }),
    )
    await Bun.write(join(pluginDir, "index.js"), "export default async () => ({})\n")

    const { report } = await migrateZcode({
      pluginDir,
      dryRun: true,
    })
    expect(report.ok).toBe(false)
    expect(report.warnings.some((w) => w.includes("hooks-only-plugin"))).toBe(
      true,
    )
    expect(
      report.skipped.some((s) => s.reason === "ocp-abi-not-migratable"),
    ).toBe(true)
  })

  test("copies marketplace.json under .zcode-plugin", async () => {
    const pluginDir = await tempDir("ocp-mig-mkt-")
    await Bun.write(
      join(pluginDir, "marketplace.json"),
      JSON.stringify({ name: "mock-market", plugins: [] }),
    )
    await Bun.write(
      join(pluginDir, "skills", "beta", "SKILL.md"),
      `---
name: beta
description: Beta
---
Beta body
`,
    )

    const outDir = await tempDir("ocp-mig-mkt-out-")
    const { report } = await migrateZcode({
      pluginDir,
      outDir,
      dryRun: false,
      name: "beta-pack",
    })
    expect(report.ok).toBe(true)
    const market = await Bun.file(
      join(outDir, ".zcode-plugin", "marketplace.json"),
    ).json()
    expect(market.name).toBe("mock-market")
  })

  test("requires pluginDir", async () => {
    expect(migrateZcode({ pluginDir: "" } as never)).rejects.toThrow(
      /pluginDir/,
    )
  })

  test("skill name collision fails closed", async () => {
    const pluginDir = await tempDir("ocp-mig-collide-")
    await Bun.write(
      join(pluginDir, "skills", "one", "SKILL.md"),
      `---
name: twin
description: First
---
A
`,
    )
    await Bun.write(
      join(pluginDir, "skills", "two", "SKILL.md"),
      `---
name: twin
description: Second
---
B
`,
    )

    const { report } = await migrateZcode({
      pluginDir,
      dryRun: true,
    })
    expect(report.ok).toBe(false)
    expect(
      report.skipped.some((s) => s.reason === "skill-name-collision:twin"),
    ).toBe(true)
  })

  test("allowEmpty succeeds for hooks-only", async () => {
    const pluginDir = await tempDir("ocp-mig-empty-ok-")
    await Bun.write(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "hooks-only", main: "./index.js" }),
    )
    const { report } = await migrateZcode({
      pluginDir,
      dryRun: true,
      allowEmpty: true,
    })
    expect(report.ok).toBe(true)
  })
})
describe("migrateZcodeMarketplace (multi-plugin wrap)", () => {
  test("pluginSlug normalizes names", () => {
    expect(pluginSlug("My Plugin")).toBe("my-plugin")
    expect(pluginSlug("alpha_beta")).toBe("alpha_beta")
  })

  test("buildMarketplaceJson matches fleet-shaped catalog", () => {
    const catalog = buildMarketplaceJson({
      name: "mock-fleet",
      description: "A mock marketplace",
      ownerName: "oakimov",
      ownerUrl: "https://github.com/oakimov",
      plugins: [
        {
          name: "alpha",
          source: "./plugins/alpha",
          description: "Alpha pack",
        },
      ],
    })
    expect(catalog.name).toBe("mock-fleet")
    expect(catalog.description).toBe("A mock marketplace")
    expect(catalog.owner).toEqual({
      name: "oakimov",
      url: "https://github.com/oakimov",
    })
    expect(catalog.plugins).toEqual([
      {
        name: "alpha",
        source: "./plugins/alpha",
        description: "Alpha pack",
      },
    ])
  })

  test("wraps two plugins under plugins/<slug> + root marketplace.json", async () => {
    const a = await tempDir("ocp-mkt-a-")
    const b = await tempDir("ocp-mkt-b-")
    await Bun.write(
      join(a, "package.json"),
      JSON.stringify({ name: "pack-alpha", version: "1.0.0" }),
    )
    await Bun.write(
      join(a, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill
---
A
`,
    )
    await Bun.write(
      join(b, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "pack-beta",
        version: "2.0.0",
        description: "Beta pack",
      }),
    )
    await Bun.write(
      join(b, "commands", "beta.md"),
      `---
description: Beta cmd
---
B
`,
    )
    await Bun.write(
      join(b, "marketplace.json"),
      JSON.stringify({ name: "should-omit", plugins: [] }),
    )

    const outDir = await tempDir("ocp-mkt-out-")
    const { report, marketplace } = await migrateZcodeMarketplace({
      pluginDirs: [a, b],
      outDir,
      marketplaceName: "mock-fleet",
      marketplaceDescription: "Test fleet",
      ownerName: "tester",
      dryRun: false,
    })

    expect(report.ok).toBe(true)
    expect(report.plugins.map((p) => p.name).sort()).toEqual([
      "pack-alpha",
      "pack-beta",
    ])
    expect(marketplace?.name).toBe("mock-fleet")
    expect(marketplace?.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pack-alpha",
          source: "./plugins/pack-alpha",
        }),
        expect.objectContaining({
          name: "pack-beta",
          source: "./plugins/pack-beta",
          description: "Beta pack",
        }),
      ]),
    )

    const catalog = await Bun.file(
      join(outDir, ".zcode-plugin", "marketplace.json"),
    ).json()
    expect(catalog.name).toBe("mock-fleet")
    expect(catalog.owner).toEqual({ name: "tester" })

    const alphaSkill = await Bun.file(
      join(outDir, "plugins", "pack-alpha", "skills", "alpha", "SKILL.md"),
    ).text()
    expect(alphaSkill).toContain("name: alpha")

    const betaCmd = await Bun.file(
      join(outDir, "plugins", "pack-beta", "commands", "beta.md"),
    ).text()
    expect(betaCmd).toContain("description: Beta cmd")

    expect(
      await Bun.file(
        join(
          outDir,
          "plugins",
          "pack-beta",
          ".zcode-plugin",
          "marketplace.json",
        ),
      ).exists(),
    ).toBe(false)

    expect(
      report.warnings.some((w) =>
        w.startsWith("marketplace-manifest-omitted-under-wrap:"),
      ),
    ).toBe(true)
  })

  test("slug collision fails closed", async () => {
    const a = await tempDir("ocp-mkt-c1-")
    const b = await tempDir("ocp-mkt-c2-")
    await Bun.write(
      join(a, "skills", "x", "SKILL.md"),
      `---
name: x
description: X
---
X
`,
    )
    await Bun.write(
      join(b, "skills", "y", "SKILL.md"),
      `---
name: y
description: Y
---
Y
`,
    )
    await Bun.write(
      join(a, "package.json"),
      JSON.stringify({ name: "same-name" }),
    )
    await Bun.write(
      join(b, "package.json"),
      JSON.stringify({ name: "same-name" }),
    )

    const { report } = await migrateZcodeMarketplace({
      pluginDirs: [a, b],
      marketplaceName: "collide-fleet",
      dryRun: true,
    })
    expect(report.ok).toBe(false)
    expect(
      report.skipped.some((s) => s.reason === "plugin-slug-collision:same-name"),
    ).toBe(true)
  })

  test("requires marketplaceName and pluginDirs", async () => {
    expect(
      migrateZcodeMarketplace({
        pluginDirs: [],
        marketplaceName: "x",
      }),
    ).rejects.toThrow(/pluginDirs/)
    expect(
      migrateZcodeMarketplace({
        pluginDirs: ["/tmp/x"],
        marketplaceName: "  ",
      }),
    ).rejects.toThrow(/marketplaceName/)
  })
})