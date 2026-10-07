/**
 * Reject a bridged model's call that names a path which does not exist, and
 * say which call to make instead.
 *
 * DSH resolves a relative path against the session workspace and does not
 * expand `~` (`packages/fs/tool-fs/src/session-cwd.ts`), so `~/x` reads
 * `<workspace>/~/x` and fails with a bare "not found". A model without the
 * home directory then guesses one (`/Users/<someone>/…`) or searches the
 * workspace, where the file is not. Search roots that do not exist can also
 * come back as an empty result instead of an error. The public
 * `tools/pre-execute` waterfall denies the call before dispatch with a reason
 * the model receives as the tool error (`packages/core/tools/src/index.ts`).
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { dshProfile, type DshHostProfile } from "./host/profile.js"

type GuardAgent = {
  options?: { provider?: unknown }
  session?: {
    header?: { cwd?: unknown }
    requestHeader?: () => { config?: { provider?: unknown } } | undefined
  }
}

type GuardExecution = {
  name: string
  arguments: unknown
  agent?: GuardAgent
  /** Present on nested transport dispatches, which the model did not author. */
  parent?: unknown
}

type PreToolDecision = { kind: "deny"; reason: string } | { kind: string }

function hasGlobChars(value: string): boolean {
  return /[*?[\]{}]/.test(value)
}

/** Deepest existing directory on the way to `target`. */
function nearestExistingDir(target: string, exists: (target: string) => boolean): string {
  let current = path.dirname(target)
  while (!exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Model-facing reason for a path that does not exist, or `undefined` when the
 * path exists, cannot be resolved here, or is not a plain filesystem path.
 */
export function missingPathReason(input: {
  value: unknown
  cwd: string | undefined
  home: string
  exists?: (target: string) => boolean
}): string | undefined {
  const exists = input.exists ?? existsSync
  const value = input.value
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("://") || hasGlobChars(trimmed)) return undefined
  if (!path.isAbsolute(trimmed) && !input.cwd) return undefined
  const resolved = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(input.cwd!, trimmed)
  if (exists(resolved)) return undefined

  const home = path.resolve(input.home)
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const expanded = path.join(home, trimmed.slice(1))
    return `"${trimmed}" does not exist: this host does not expand "~" and resolved it to "${resolved}". `
      + (exists(expanded)
        ? `Retry with the absolute path "${expanded}".`
        : `The home directory is "${home}", but "${expanded}" does not exist either. `
          + `Find the file with glob (pattern "**/${path.basename(expanded)}", path "${nearestExistingDir(expanded, exists)}") and retry with a path it returns.`)
  }

  // A guessed home directory: same layout under another user's home.
  const homeParent = path.dirname(home)
  if (resolved.startsWith(homeParent + path.sep) && !resolved.startsWith(home + path.sep)) {
    const relative = path.relative(homeParent, resolved).split(path.sep).slice(1).join(path.sep)
    const candidate = relative ? path.join(home, relative) : home
    if (relative && exists(candidate)) {
      return `"${resolved}" does not exist. The home directory is "${home}"; retry with "${candidate}".`
    }
  }

  return `"${resolved}" does not exist. Find it with glob (pattern "**/${path.basename(resolved)}", `
    + `path "${nearestExistingDir(resolved, exists)}") and retry with a path it returns.`
}

function providerOf(agent: GuardAgent | undefined): string | undefined {
  const fromOptions = agent?.options?.provider
  if (typeof fromOptions === "string") return fromOptions
  const fromHeader = agent?.session?.requestHeader?.()?.config?.provider
  return typeof fromHeader === "string" ? fromHeader : undefined
}

/** Deny a bridged provider's call whose existing-path argument does not exist. */
export function missingPathDecision(
  exec: GuardExecution,
  bridgedProviders: ReadonlySet<string>,
  options: { profile?: DshHostProfile; home?: string; exists?: (target: string) => boolean } = {},
): { kind: "deny"; reason: string } | undefined {
  if (exec.parent !== undefined) return undefined
  const provider = providerOf(exec.agent)
  if (!provider || !bridgedProviders.has(provider)) return undefined
  const keys = (options.profile ?? dshProfile()).existingPaths?.[exec.name]
  const args = exec.arguments
  if (!keys || !args || typeof args !== "object") return undefined
  const cwd = typeof exec.agent?.session?.header?.cwd === "string" ? exec.agent.session.header.cwd : undefined
  // DSH also runs sessions on remote filesystems (ssh, e2b). The local disk
  // only answers for a session whose workspace is local.
  const exists = options.exists ?? existsSync
  if (!cwd || !path.isAbsolute(cwd) || !exists(cwd)) return undefined
  for (const key of keys) {
    const reason = missingPathReason({
      value: (args as Record<string, unknown>)[key],
      cwd,
      home: options.home ?? process.env.HOME ?? homedir(),
      exists,
    })
    if (reason) return { kind: "deny", reason }
  }
  return undefined
}

export function installMissingPathGuard(
  on: ((event: string, listener: (exec: GuardExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) => void) | undefined,
  bridgedProviders: ReadonlySet<string>,
): void {
  on?.("tools/pre-execute", async (exec, next) => missingPathDecision(exec, bridgedProviders) ?? next())
}
