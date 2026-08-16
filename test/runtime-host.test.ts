/**
 * Zero-dep runtime-host: tool role maps + path bridge for clone and pi hosts.
 */
import { describe, expect, test } from "bun:test"
import {
  installPathBridge,
  toolRolesForHostId,
} from "../packages/adapter/src/runtime-host.ts"

const PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

type PathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  configFileNames: string[]
}

function clearBridge(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[PATH_BRIDGE_KEY]
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

  test("omp maps question → ask only", () => {
    expect(toolRolesForHostId("omp")).toEqual({
      tools: { question: "ask" },
    })
  })

  test("opencode / kilo / pi / unknown have no sparse overrides", () => {
    expect(toolRolesForHostId("opencode")).toBeUndefined()
    expect(toolRolesForHostId("kilo")).toBeUndefined()
    expect(toolRolesForHostId("pi")).toBeUndefined()
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

  test("omp installs .omp project + ~/.omp/agent global", () => {
    clearBridge()
    installPathBridge("omp", { HOME: "/tmp/home-omp" })
    const b = bridge()
    expect(b.projectConfigDirs("/ws")).toEqual(["/ws/.omp"])
    expect(b.globalConfigDirs()).toEqual(["/tmp/home-omp/.omp/agent"])
    expect(b.configFileNames).toEqual(["settings.json", "pi-bridge.json"])
  })

  test("pi installs .pi project + ~/.pi/agent global", () => {
    clearBridge()
    installPathBridge("pi", { HOME: "/tmp/home-pi" })
    const b = bridge()
    expect(b.projectConfigDirs("/ws")).toEqual(["/ws/.pi"])
    expect(b.globalConfigDirs()).toEqual(["/tmp/home-pi/.pi/agent"])
    expect(b.configFileNames).toEqual(["settings.json", "pi-bridge.json"])
  })

  test("PI_CODING_AGENT_DIR overrides agent root for omp and pi", () => {
    clearBridge()
    installPathBridge("omp", {
      HOME: "/tmp/home",
      PI_CODING_AGENT_DIR: "/custom/agent",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/custom/agent"])

    installPathBridge("pi", {
      HOME: "/tmp/home",
      PI_CODING_AGENT_DIR: "/other/agent",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/other/agent"])
  })

  test("PI_CONFIG_DIR overrides the ~/.{omp,pi} segment when agent dir unset", () => {
    clearBridge()
    installPathBridge("omp", {
      HOME: "/tmp/home",
      PI_CONFIG_DIR: ".custom-omp",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/tmp/home/.custom-omp/agent"])

    installPathBridge("pi", {
      HOME: "/tmp/home",
      PI_CONFIG_DIR: ".custom-pi",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/tmp/home/.custom-pi/agent"])
  })

  test("PI_CODING_AGENT_DIR wins over PI_CONFIG_DIR", () => {
    clearBridge()
    installPathBridge("pi", {
      HOME: "/tmp/home",
      PI_CONFIG_DIR: ".ignored",
      PI_CODING_AGENT_DIR: "/wins",
    })
    expect(bridge().globalConfigDirs()).toEqual(["/wins"])
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
    installPathBridge("omp", { HOME: "/tmp/home" })
    const dirs = bridge().projectConfigDirs("")
    expect(dirs).toHaveLength(1)
    expect(dirs[0]?.endsWith("/.omp")).toBe(true)
  })

  test("reinstall replaces prior bridge (idempotent overwrite)", () => {
    clearBridge()
    installPathBridge("omp", { HOME: "/tmp/a" })
    installPathBridge("pi", { HOME: "/tmp/b" })
    expect(bridge().projectConfigDirs("/ws")).toEqual(["/ws/.pi"])
    expect(bridge().globalConfigDirs()).toEqual(["/tmp/b/.pi/agent"])
  })
})
