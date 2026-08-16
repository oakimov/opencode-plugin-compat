/**
 * Install the same `Symbol.for("opencode.compat.path-bridge")` surface the
 * OpenCode-clone adapter installs, so an unmodified provider (e.g.
 * cursor-opencode-provider) resolves project/global config dirs under
 * `.omp` / `.pi` instead of inventing `.opencode`.
 *
 * Kept inside pi-bridge rather than importing `@opencode-compat/adapter` — the
 * Pi family deliberately stays a separate package graph from the clone path.
 */
import { homedir } from "node:os"
import path from "node:path"
import type { PiHostId } from "./host/profile.js"

const PATH_BRIDGE_KEY = Symbol.for("opencode.compat.path-bridge")

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

function agentRoot(id: PiHostId, env: Record<string, string | undefined>): string {
  if (env.PI_CODING_AGENT_DIR) return path.resolve(env.PI_CODING_AGENT_DIR)
  const configDir = env.PI_CONFIG_DIR || (id === "pi" ? ".pi" : ".omp")
  return path.join(homeDir(env), configDir, "agent")
}

/** Install path bridge for the running Pi-family host. Idempotent. */
export function installPiPathBridge(
  id: PiHostId,
  env: Record<string, string | undefined> = process.env,
): void {
  const projectName = id === "pi" ? ".pi" : ".omp"
  const globalRoot = agentRoot(id, env)
  ;(globalThis as typeof globalThis & Record<typeof PATH_BRIDGE_KEY, unknown>)[PATH_BRIDGE_KEY] = {
    projectConfigDirs(workspaceRoot: string) {
      const root = path.resolve(workspaceRoot || process.cwd())
      return unique([path.join(root, projectName)])
    },
    globalConfigDirs() {
      return unique([globalRoot])
    },
    configFileNames: ["settings.json", "pi-bridge.json"],
  }
}
