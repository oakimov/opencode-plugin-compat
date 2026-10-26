import { describe, expect, test } from "bun:test"
import {
  buildAvailableSkillsCatalog,
  hostSkillsBridge,
  installHostSkillsBridge,
  skillsFromCatalogText,
} from "../packages/opencode-loader/src/host-skills.ts"

const KEY = Symbol.for("opencode.host.skills")
type SkillsBridge = { list(input: { directory: string }): Promise<unknown> }

describe("canonical host skills bridge helpers", () => {
  for (const host of ["mimo", "kilo"] as const) {
    test(`${host} provider bundles retain isolated skills through another bundle's global reader`, async () => {
      type Runtime = Pick<typeof import("../packages/adapter/src/runtime-entry.ts"), "adaptLanguageModel" | "installPathBridge" | "policyForHostId">
      const first: Runtime = await import(`../packages/adapter/dist/ocp-lm-runtime.js?skills-copy=${host}-first`)
      const second: Runtime = await import(`../packages/adapter/dist/ocp-lm-runtime.js?skills-copy=${host}-second`)
      expect(first.installPathBridge).not.toBe(second.installPathBridge)
      const globals = globalThis as Record<PropertyKey, unknown>
      const keys = [KEY, Symbol.for("opencode.host.path-bridge"), Symbol.for("opencode.compat.path-bridge")]
      const previous = keys.map(key => globals[key])
      const read = () => hostSkillsBridge()!.list({ directory: "/workspace" })
      const call = (location: string) => ({ prompt: [{ role: "system", content: buildAvailableSkillsCatalog([
        { name: "audit", description: "Audit", location },
      ]) }] })
      try {
        first.installPathBridge(host, { HOME: "/fixture" })
        const modelA = first.adaptLanguageModel({ async doGenerate(_options: unknown) { await Promise.resolve(); return { skills: await read() } } }, first.policyForHostId(host))
        second.installPathBridge(host, { HOME: "/fixture" })
        const modelB = second.adaptLanguageModel({ async doGenerate(_options: unknown) { await Promise.resolve(); return { skills: await read() } } }, second.policyForHostId(host))
        expect((await modelA.doGenerate(call("/a/SKILL.md"))).skills).toEqual([{ name: "audit", description: "Audit", location: "/a/SKILL.md" }])
        const [a, b] = await Promise.all([modelA.doGenerate(call("/a/SKILL.md")), modelB.doGenerate(call("/b/SKILL.md"))])
        expect(a.skills[0]?.location).toBe("/a/SKILL.md")
        expect(b.skills[0]?.location).toBe("/b/SKILL.md")
        expect((await modelA.doGenerate({ prompt: [] })).skills).toEqual([])
        expect(await read()).toEqual([])

        let resume!: () => void
        const gate = new Promise<void>(resolve => { resume = resolve })
        const streaming = first.adaptLanguageModel({ async doStream(_options: unknown) {
          return { stream: new ReadableStream<{ type: string; delta: string }>({ async start(controller) {
            await gate
            controller.enqueue({ type: "text-delta", delta: JSON.stringify(await read()) })
            controller.close()
          } }) }
        } }, first.policyForHostId(host))
        const result = await streaming.doStream(call("/stream/SKILL.md"))
        second.installPathBridge(host, { HOME: "/fixture" })
        resume()
        const parts = []
        for await (const part of result.stream) parts.push(part)
        expect(parts).toEqual([{ type: "text-delta", delta: JSON.stringify([{ name: "audit", description: "Audit", location: "/stream/SKILL.md" }]) }])
      } finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete globals[key]
          else globals[key] = previous[index]
        })
      }
    })
  }

  test("parses OpenCode C1 catalogs, normalizes file URLs, and omits builtin locations", () => {
    const skills = skillsFromCatalogText(`<available_skills>
  <skill>
    <name>repo-skill</name>
    <description>Use &lt;repo&gt; guidance.</description>
    <location>file:///tmp/repo/.kilo/skills/repo-skill.md</location>
  </skill>
  <skill>
    <name>builtin</name>
    <description>Built in</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`)
    expect(skills).toEqual([
      { name: "repo-skill", description: "Use <repo> guidance.", location: "/tmp/repo/.kilo/skills/repo-skill.md" },
      { name: "builtin", description: "Built in" },
    ])
  })

  test("parses OMP skill lists into skill URI locations", () => {
    expect(skillsFromCatalogText(`<skills>
- plan: Planning guidance
- \`audit\`: Audit guidance
</skills>`)).toEqual([
      { name: "plan", description: "Planning guidance", location: "skill://plan" },
      { name: "audit", description: "Audit guidance", location: "skill://audit" },
    ])
  })

  test("builds canonical C1 catalog text without content", () => {
    expect(buildAvailableSkillsCatalog([{ name: "audit", description: "Audit", location: "/tmp/audit.md" }]))
      .toBe("<available_skills>\n<skill>\n<name>audit</name>\n<description>Audit</description>\n<location>/tmp/audit.md</location>\n</skill>\n</available_skills>")
  })

  test("installs the structural symbol", async () => {
    delete (globalThis as Record<PropertyKey, unknown>)[KEY]
    installHostSkillsBridge(() => [{ name: "one", description: "One", location: "/tmp/one.md" }])
    const bridge = (globalThis as Record<PropertyKey, unknown>)[KEY] as SkillsBridge
    expect(await bridge.list({ directory: "/repo" })).toEqual([{ name: "one", description: "One", location: "/tmp/one.md" }])
  })
})
