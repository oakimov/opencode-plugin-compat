import { afterEach, describe, expect, test } from "bun:test"
import { installDshPathBridge, installDshSkillList } from "../packages/dsh-bridge/src/path-bridge.ts"
import { withHostSkills } from "@opencode-compat/opencode-loader"
import { isCursorAgentToolSpillPath } from "../packages/dsh-bridge/src/cursor-metadata-write.ts"

const KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_KEY = Symbol.for("opencode.compat.path-bridge")
const SKILLS_KEY = Symbol.for("opencode.host.skills")
const globals = globalThis as Record<PropertyKey, unknown>
const saved = { current: globals[KEY], legacy: globals[LEGACY_KEY], skills: globals[SKILLS_KEY] }

type Bridge = {
  globalDataDir: () => string
  globalCacheDir: () => string
  projectConfigDirs: (root: string) => string[]
}

afterEach(() => {
  globals[KEY] = saved.current
  globals[LEGACY_KEY] = saved.legacy
  globals[SKILLS_KEY] = saved.skills
})

describe("installDshPathBridge", () => {
  test("provider cache lives under the DSH root, not a native OpenCode cache", () => {
    installDshPathBridge("dsh", { HOME: "/tmp/h", XDG_CACHE_HOME: "/tmp/xdg" })
    const bridge = globals[KEY] as Bridge
    expect(bridge.globalDataDir()).toBe("/tmp/h/.dsh")
    expect(bridge.globalCacheDir()).toBe("/tmp/h/.dsh/cache/opencode-providers")
    expect(bridge.globalCacheDir()).not.toContain("/opencode/")
    expect(globals[LEGACY_KEY]).toBe(bridge)

    installDshPathBridge("dsh", { HOME: "/tmp/h", DSH_HOME: "/srv/dsh" })
    const relocated = globals[KEY] as Bridge
    expect(relocated.globalCacheDir()).toBe("/srv/dsh/cache/opencode-providers")
    expect(relocated.projectConfigDirs("/ws")).toEqual(["/ws/.dsh", "/ws/.opencode"])

    // Cursor's catalog spill under the relocated cache is still recognized.
    const spill = "/srv/dsh/cache/opencode-providers/projects/ws/agent-tools/01f08b05-86e5-4bec-bbdb-7eacd1489a97.txt"
    expect(isCursorAgentToolSpillPath(spill, relocated.globalCacheDir())).toBe(true)
  })

  test("installs canonical skills list from structural DSH summaries", async () => {
    installDshPathBridge("dsh", { HOME: "/tmp/h" })
    installDshSkillList(async () => [
      { id: "s1", name: "audit", description: "Audit repo", path: "/repo/.dsh/skills/audit.md" },
      { id: "virtual", name: "virtual", description: "Virtual only" },
    ])
    const bridge = globals[SKILLS_KEY] as { list(input: { directory: string }): Promise<unknown> }
    expect(await withHostSkills([{ name: "audit", description: "Audit repo" }], () => bridge.list({ directory: "/repo" }))).toEqual([
      { id: "s1", name: "audit", description: "Audit repo", location: "/repo/.dsh/skills/audit.md" },
    ])
  })
})
