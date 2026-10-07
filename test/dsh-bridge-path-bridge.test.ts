import { afterEach, describe, expect, test } from "bun:test"
import { installDshPathBridge } from "../packages/dsh-bridge/src/path-bridge.ts"
import { isCursorAgentToolSpillPath } from "../packages/dsh-bridge/src/cursor-metadata-write.ts"

const KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_KEY = Symbol.for("opencode.compat.path-bridge")
const globals = globalThis as Record<PropertyKey, unknown>
const saved = { current: globals[KEY], legacy: globals[LEGACY_KEY] }

type Bridge = {
  globalDataDir: () => string
  globalCacheDir: () => string
  projectConfigDirs: (root: string) => string[]
}

afterEach(() => {
  globals[KEY] = saved.current
  globals[LEGACY_KEY] = saved.legacy
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
})
