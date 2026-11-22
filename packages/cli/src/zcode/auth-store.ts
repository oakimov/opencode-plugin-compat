/**
 * Durable, private upstream auth for one plugin/provider within one binding.
 *
 * OpenCode plugins persist refreshed credentials through `client.auth.set`
 * from inside `auth.loader`. Several loaders can be in flight at once (one per
 * model request), and an explicit `ocp zcode auth` login may land meanwhile.
 * Every record carries a generation; a write made by an operation that read an
 * older generation is discarded, so an in-flight loader can never reseed a
 * stale snapshot over a newer login. `serve` and `auth` are separate
 * processes, so the generation check and the file replacement run under a
 * cross-process lock file next to the record.
 */
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AuthStore, OpenCodeAuth } from "@opencode-compat/opencode-loader"

type Record_ = { generation: number; auth?: OpenCodeAuth }

function isAuth(value: unknown): value is OpenCodeAuth {
  if (!value || typeof value !== "object") return false
  const auth = value as { type?: unknown; access?: unknown; key?: unknown }
  return (auth.type === "oauth" && typeof auth.access === "string") || (auth.type === "api" && typeof auth.key === "string")
}

const LOCK_TIMEOUT_MS = 10_000
const LOCK_STALE_MS = 30_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Holder `pid time` is stale when its process is gone or it is implausibly old. */
function isStaleLock(content: string, now = Date.now()): boolean {
  const [pidText, timeText] = content.trim().split(" ")
  const pid = Number(pidText)
  const time = Number(timeText)
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(time)) return true
  return !processAlive(pid) || now - time > LOCK_STALE_MS
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Exclusive lock file (O_EXCL create). A stale lock is moved aside atomically
 * and removed only if it is still the stale holder that was observed;
 * otherwise it is linked back without overwriting a newer lock.
 */
export async function withFileLock<T>(lockFile: string, run: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString("hex")}`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      const fd = openSync(lockFile, "wx", 0o600)
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const observed = readText(lockFile)
    if (observed !== undefined && isStaleLock(observed)) {
      const aside = `${lockFile}.stale.${randomBytes(6).toString("hex")}`
      try {
        renameSync(lockFile, aside)
        if (readText(aside) === observed) rmSync(aside, { force: true })
        else {
          try {
            linkSync(aside, lockFile)
          } catch {
            // A newer holder already exists; the moved file is not ours to keep.
          }
          rmSync(aside, { force: true })
        }
      } catch {
        // Another waiter moved it first.
      }
      continue
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for auth lock ${lockFile}`)
    await Bun.sleep(5 + Math.floor(Math.random() * 15))
  }
  try {
    return await run()
  } finally {
    if (readText(lockFile) === token) rmSync(lockFile, { force: true })
  }
}

export class DurableAuthStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  /**
   * One file per (binding, plugin, provider). The name hashes the complete
   * tuple, so distinct tuples never share a file whatever their characters.
   */
  static forPlugin(stateDir: string, bindingId: string, pluginId: string, providerId: string): DurableAuthStore {
    const digest = createHash("sha256").update(JSON.stringify([bindingId, pluginId, providerId])).digest("hex").slice(0, 32)
    const label = bindingId.replace(/[^A-Za-z0-9._-]/g, "_")
    return new DurableAuthStore(join(stateDir, "auth", `${label}.${digest}.json`))
  }

  private locked<T>(run: () => T): Promise<T> {
    const next = this.chain.then(() => withFileLock(`${this.file}.lock`, run))
    this.chain = next.catch(() => undefined)
    return next
  }

  read(): Record_ {
    let text: string
    try {
      text = readFileSync(this.file, "utf8")
    } catch {
      return { generation: 0 }
    }
    const parsed = JSON.parse(text) as { generation?: unknown; auth?: unknown }
    const generation = typeof parsed.generation === "number" && Number.isInteger(parsed.generation) ? parsed.generation : 0
    return isAuth(parsed.auth) ? { generation, auth: parsed.auth } : { generation }
  }

  /**
   * Replace the stored credential. With `expectedGeneration`, the write only
   * applies when nothing newer was stored since that generation was read.
   * Returns whether the write was applied.
   */
  replace(auth: OpenCodeAuth | undefined, expectedGeneration?: number): Promise<boolean> {
    return this.locked(() => {
      const current = this.read()
      if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return false
      this.write({ generation: current.generation + 1, ...(auth ? { auth } : {}) })
      return true
    })
  }

  remove(): Promise<void> {
    return this.locked(() => {
      const current = this.read()
      if (current.generation === 0 && !current.auth) return
      this.write({ generation: current.generation + 1 })
    })
  }

  private write(record: Record_): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } finally {
      rmSync(tmp, { force: true })
    }
  }
}

/**
 * An {@link AuthStore} view for one operation (a model request or a login).
 * Reads pin the generation they observed; writes are compare-and-set against
 * it, and an accepted write advances the pin so the same operation can chain
 * refreshes.
 */
export function generationAuthView(store: DurableAuthStore): AuthStore & { readonly generation: () => number } {
  let pinned: number | undefined
  let local: OpenCodeAuth | undefined
  return {
    generation: () => pinned ?? store.read().generation,
    async get() {
      if (pinned === undefined) {
        const record = store.read()
        pinned = record.generation
        local = record.auth
      }
      return local
    },
    async set(auth) {
      if (pinned === undefined) {
        const record = store.read()
        pinned = record.generation
        local = record.auth
      }
      // auth.loader re-seeds the credential it was handed; only real changes are writes.
      if (JSON.stringify(auth) === JSON.stringify(local)) return
      local = auth
      if (await store.replace(auth, pinned)) pinned += 1
    },
  }
}
