/**
 * Neutral host path and skills contracts for plugins loaded by the ZCode
 * bridge, installed before the consumer module is imported.
 *
 * Roots are OCP-owned: plugin data and cache never land in ZCode's private
 * directories or in a native OpenCode install's cache. Project configuration
 * is read from the workspace the provider was handed (the binding's
 * workspace). The skills catalog is empty: ZCode's model request carries no
 * verified skill metadata, and OCP does not synthesize a list from disk.
 */
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { installHostSkillsBridge } from "@opencode-compat/opencode-loader"
import type { ZcodePaths } from "./config.js"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")

export function installZcodePathBridge(paths: ZcodePaths, env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME || homedir()
  const dataRoot = resolve(paths.stateDir, "..")
  const bridge = {
    globalDataDir: () => dataRoot,
    globalCacheDir: () => join(paths.cacheDir, "opencode-providers"),
    projectConfigDirs: (workspaceRoot: string) => [join(resolve(workspaceRoot), ".opencode")],
    globalConfigDirs: () => [join(home, ".config", "opencode")],
    configFileNames: ["opencode.json", "opencode.jsonc"],
  }
  ;(globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] = bridge
  installHostSkillsBridge(async () => [])
}
