import { homedir } from "node:os"
import { join } from "node:path"

export type PathEnv = NodeJS.ProcessEnv

function xdgHome(
  env: PathEnv,
  key: "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME",
  fallback: string,
  home: string,
): string {
  const override = env[key]
  if (override && override.length > 0) return override
  return join(home, fallback)
}

/** Resolve OpenCode-style XDG layout for an app name. */
export function resolveXdgDirs(
  app: string,
  env: PathEnv = process.env,
  home: string = env.HOME ?? homedir(),
): { configDir: string; dataDir: string; cacheDir: string } {
  return {
    configDir: join(xdgHome(env, "XDG_CONFIG_HOME", ".config", home), app),
    dataDir: join(xdgHome(env, "XDG_DATA_HOME", ".local/share", home), app),
    cacheDir: join(xdgHome(env, "XDG_CACHE_HOME", ".cache", home), app),
  }
}

/** Expand a leading `~` against `home`. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return path
}
