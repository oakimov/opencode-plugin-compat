/**
 * Zero-dep runtime-host: tool role maps + path bridge for OpenCode-clone hosts.
 */
import { describe, expect, test } from "bun:test"
import {
  installPathBridge,
  toolRolesForHostId,
} from "../packages/adapter/src/runtime-host.ts"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

type PathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  globalDataDir: () => string
  globalCacheDir: () => string
  configFileNames: string[]
}

function clearBridge(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]
  delete (globalThis as Record<PropertyKey, unknown>)[LEGACY_PATH_BRIDGE_KEY]
}

function bridge(): PathBridge {
  const installed = (globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]
  if (!installed) throw new Error("path bridge not installed")
  return installed as PathBridge
}

describe("toolRolesForHostId", () => {
  test("mimo rotates subagent/todo roles", () => {
    expect(toolRolesForHostId("mimo")).toEqual({
      tools: { subagent: "actor", todoWrite: "task", todoRead: "task" },
    })
  })

  test("opencode / kilo / unknown have no sparse overrides", () => {
    expect(toolRolesForHostId("opencode")).toBeUndefined()
    expect(toolRolesForHostId("kilo")).toBeUndefined()
    expect(toolRolesForHostId("unknown")).toBeUndefined()
    expect(toolRolesForHostId("")).toBeUndefined()
  })
})

describe("installPathBridge", () => {
  test("unknown host is a no-op", () => {
    clearBridge()
    installPathBridge("unknown", { HOME: "/tmp/home" })
    expect((globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]).toBeUndefined()
  })

  test("Pi-family ids are a clone-runtime no-op and inherit no tool roles", () => {
    clearBridge()
    for (const id of ["omp", "pi"]) {
      installPathBridge(id, {
        HOME: "/tmp/home",
        PI_CODING_AGENT_DIR: "/custom/agent",
        PI_CONFIG_DIR: ".custom",
        XDG_CACHE_HOME: "/tmp/xdg-cache",
      })
      expect((globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]).toBeUndefined()
      expect(toolRolesForHostId(id)).toBeUndefined()
    }
  })

  test("mimo installs .mimocode + XDG/MIMOCODE config root", () => {
    clearBridge()
    installPathBridge("mimo", {
      HOME: "/tmp/home",
      XDG_CONFIG_HOME: "/tmp/xdg",
    })
    const b = bridge()
    expect(b.projectConfigDirs("/repo")).toEqual(["/repo/.mimocode"])
    expect(b.globalConfigDirs()).toEqual(["/tmp/xdg/mimocode"])
    expect(b.globalDataDir()).toEqual("/tmp/home/.local/share/mimocode")
    expect(b.globalCacheDir()).toEqual("/tmp/home/.cache/mimocode")
    expect(b.configFileNames).toContain("mimocode.json")
  })

  test("mimo honors MIMOCODE_HOME and MIMOCODE_CONFIG_DIR", () => {
    clearBridge()
    installPathBridge("mimo", {
      HOME: "/tmp/home",
      MIMOCODE_HOME: "/mimo-home",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/mimo-home/config"])

    installPathBridge("mimo", {
      HOME: "/tmp/home",
      MIMOCODE_HOME: "/mimo-home",
      MIMOCODE_CONFIG_DIR: "/explicit-config",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/explicit-config"])
  })

  test("kilo installs .kilo/.kilocode project dirs", () => {
    clearBridge()
    installPathBridge("kilo", {
      HOME: "/tmp/home",
      XDG_CONFIG_HOME: "/tmp/xdg",
    })
    const b = bridge()
    expect(b.projectConfigDirs("/repo")).toEqual(["/repo/.kilo", "/repo/.kilocode"])
    expect(b.globalConfigDirs()).toEqual(["/tmp/xdg/kilo"])
  })

  test("opencode installs .opencode + XDG opencode config", () => {
    clearBridge()
    installPathBridge("opencode", {
      HOME: "/tmp/home",
      XDG_CONFIG_HOME: "/tmp/xdg",
    })
    const b = bridge()
    expect(b.projectConfigDirs("/repo")).toEqual(["/repo/.opencode"])
    expect(b.globalConfigDirs()).toEqual(["/tmp/xdg/opencode"])
    expect(b.configFileNames).toEqual(["opencode.json", "opencode.jsonc"])
  })

  test("OPENCODE_CONFIG_DIR overrides opencode global root", () => {
    clearBridge()
    installPathBridge("opencode", {
      HOME: "/tmp/home",
      OPENCODE_CONFIG_DIR: "/custom/opencode",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/custom/opencode"])
  })

  test("empty workspaceRoot falls back to process.cwd() for project dirs", () => {
    clearBridge()
    installPathBridge("opencode", { HOME: "/tmp/home" })
    const dirs = bridge().projectConfigDirs("")
    expect(dirs).toHaveLength(1)
    expect(dirs[0]?.endsWith("/.opencode")).toBe(true)
  })

  test("installs the same shape under the legacy symbol for older providers", () => {
    clearBridge()
    installPathBridge("opencode", { HOME: "/tmp/home", XDG_CONFIG_HOME: "/tmp/xdg" })
    const legacy = (globalThis as Record<PropertyKey, unknown>)[LEGACY_PATH_BRIDGE_KEY] as PathBridge
    const current = (globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY] as PathBridge
    expect(legacy).toBe(current)
    expect(legacy.globalDataDir()).toBe("/tmp/home/.local/share/opencode")
    expect(legacy.globalCacheDir()).toBe("/tmp/home/.cache/opencode")
  })

  test("mimo honors XDG_DATA_HOME and XDG_CACHE_HOME for data and cache", () => {
    clearBridge()
    installPathBridge("mimo", {
      HOME: "/tmp/home",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
    })
    expect(bridge().globalDataDir()).toBe("/xdg/data/mimocode")
    expect(bridge().globalCacheDir()).toBe("/xdg/cache/mimocode")
  })

  test("mimo honors MIMOCODE_HOME for data and cache roots", () => {
    clearBridge()
    installPathBridge("mimo", {
      HOME: "/tmp/home",
      MIMOCODE_HOME: "/mimo-home",
    })
    expect(bridge().globalDataDir()).toBe("/mimo-home")
    expect(bridge().globalCacheDir()).toBe("/mimo-home/cache")
  })

  test("kilo exposes data and cache under its XDG roots", () => {
    clearBridge()
    installPathBridge("kilo", {
      HOME: "/tmp/home",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
    })
    expect(bridge().globalDataDir()).toBe("/xdg/data/kilo")
    expect(bridge().globalCacheDir()).toBe("/xdg/cache/kilo")
  })

  test("opencode exposes data and cache under its XDG roots", () => {
    clearBridge()
    installPathBridge("opencode", {
      HOME: "/tmp/home",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
    })
    expect(bridge().globalDataDir()).toBe("/xdg/data/opencode")
    expect(bridge().globalCacheDir()).toBe("/xdg/cache/opencode")
  })

  test("reinstall replaces prior bridge (idempotent overwrite)", () => {
    clearBridge()
    installPathBridge("mimo", { HOME: "/tmp/a", XDG_CONFIG_HOME: "/tmp/xdg" })
    installPathBridge("kilo", { HOME: "/tmp/b", XDG_CONFIG_HOME: "/tmp/xdg" })
    expect(bridge().projectConfigDirs("/ws")).toEqual(["/ws/.kilo", "/ws/.kilocode"])
    expect(bridge().globalConfigDirs()).toEqual(["/tmp/xdg/kilo"])
  })
})
