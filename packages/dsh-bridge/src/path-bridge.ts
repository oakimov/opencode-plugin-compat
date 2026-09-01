/**
 * Install the same structural host-path surface as the OpenCode-clone adapter and pi-bridge,
 * so an unmodified OpenCode provider resolves project/global config dirs under DSH roots
 * instead of inventing `.opencode`.
 *
 * Mirrors `packages/pi-bridge/src/path-bridge.ts` (installPiPathBridge) but for DSH:
 * `$DSH_HOME` / `~/.dsh` instead of `.pi/.omp`.
 */
import { homedir } from "node:os"
import path from "node:path"
import type { DshHostId } from "./host/profile.js"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")
const LEGACY_PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => path.resolve(value)),
    ),
  ]
}

function homeDir(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function dshRoot(env: Record<string, string | undefined>): string {
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME)
  // Cordis composition uses $DSH_HOME/profiles/<name>/cordis.patch.yml; fallback to ~/.dsh
  return path.join(homeDir(env), ".dsh")
}

/** Install path bridge for DSH. Idempotent. */
export function installDshPathBridge(
  _id: DshHostId = "dsh",
  env: Record<string, string | undefined> = process.env,
): void {
  const globalRoot = dshRoot(env)
  const cacheRoot = env.XDG_CACHE_HOME
    ? path.join(path.resolve(env.XDG_CACHE_HOME), "opencode")
    : path.join(homeDir(env), ".cache", "opencode")
  const fallbackCwd = process.cwd()
  const bridge = {
    globalDataDir() {
      return globalRoot
    },
    globalCacheDir() {
      return cacheRoot
    },
    projectConfigDirs(workspaceRoot: string) {
      const root = path.resolve(workspaceRoot || fallbackCwd)
      // Keep both .dsh and .opencode for compatibility; provider checks both
      return unique([path.join(root, ".dsh"), path.join(root, ".opencode")])
    },
    globalConfigDirs() {
      return unique([globalRoot, path.join(homeDir(env), ".config", "opencode")])
    },
    configFileNames: ["settings.json", "dsh-bridge.json"],
  }
  ;(globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] = bridge
  ;(globalThis as typeof globalThis & Record<typeof LEGACY_PATH_BRIDGE_KEY, unknown>)[LEGACY_PATH_BRIDGE_KEY] = bridge
}
