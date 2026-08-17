import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))

export function repoRoot(): string {
  return process.env.OCP_DEV_ROOT ? resolve(process.env.OCP_DEV_ROOT) : ROOT
}

export function stateRoot(): string {
  return process.env.OCP_DEV_STATE_DIR
    ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ocp-dev")
}

export function hostStateDir(host: string): string {
  return join(stateRoot(), host)
}

export function wrapperDir(host: string): string {
  return join(hostStateDir(host), "provider")
}

export function manifestPath(host: string): string {
  return join(hostStateDir(host), "state.json")
}

export function pluginName(): string {
  return process.env.OCP_DEV_PLUGIN || "cursor-opencode-provider"
}

export function defaultProviderPath(): string {
  const override = process.env.OCP_DEV_PROVIDER_PATH
  if (override) {
    const resolved = resolve(override)
    if (!existsSync(join(resolved, "package.json"))) {
      throw new Error(`OCP_DEV_PROVIDER_PATH is not a package: ${resolved}`)
    }
    return resolved
  }
  const sibling = join(dirname(repoRoot()), "cursor-opencode-provider")
  if (existsSync(join(sibling, "package.json"))) return sibling
  const fallback = join(homedir(), "Projects", "cursor-opencode-provider")
  if (existsSync(join(fallback, "package.json"))) return fallback
  throw new Error("local provider not found; set OCP_DEV_PROVIDER_PATH")
}

export function assertManaged(path: string): void {
  const root = resolve(stateRoot())
  const resolved = resolve(path)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`refusing path outside dev state dir: ${path}`)
  }
  if (resolved.includes("..")) throw new Error(`refusing path with traversal: ${path}`)
}

export function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, text, { encoding: "utf8", mode: mode ?? 0o644 })
  if (mode !== undefined) chmodSync(temporary, mode)
  renameSync(temporary, path)
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export function fileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

export function ocpVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "packages/profile/package.json"), "utf8")) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
