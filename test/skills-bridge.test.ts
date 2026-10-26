import { describe, expect, test } from "bun:test"
import {
  buildAvailableSkillsCatalog,
  installHostSkillsBridge,
  recordHostSkillCatalogText,
  skillsFromCatalogText,
} from "../packages/opencode-loader/src/host-skills.ts"

const KEY = Symbol.for("opencode.host.skills")
type SkillsBridge = { list(input: { directory: string }): Promise<unknown> }

describe("canonical host skills bridge helpers", () => {
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
    recordHostSkillCatalogText(undefined)
    installHostSkillsBridge(() => [{ name: "one", description: "One", location: "/tmp/one.md" }])
    const bridge = (globalThis as Record<PropertyKey, unknown>)[KEY] as SkillsBridge
    expect(await bridge.list({ directory: "/repo" })).toEqual([{ name: "one", description: "One", location: "/tmp/one.md" }])
  })
})
