/**
 * Durable, private upstream auth for one plugin/provider within one binding.
 *
 * OpenCode plugins persist refreshed credentials through `client.auth.set`
 * from inside `auth.loader`. Several loaders can be in flight at once (one per
 * model request), and an explicit `ocp zcode auth` login may land meanwhile.
 * Every record carries a generation; a write made by an operation that read an
 * older generation is discarded, so an in-flight loader can never reseed a
 * stale snapshot over a newer login.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AuthStore, OpenCodeAuth } from "@opencode-compat/opencode-loader"

type Record_ = { generation: number; auth?: OpenCodeAuth }

function isAuth(value: unknown): value is OpenCodeAuth {
  if (!value || typeof value !== "object") return false
  const auth = value as { type?: unknown; access?: unknown; key?: unknown }
  return (auth.type === "oauth" && typeof auth.access === "string") || (auth.type === "api" && typeof auth.key === "string")
}

export class DurableAuthStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  static forPlugin(stateDir: string, bindingId: string, pluginId: string, providerId: string): DurableAuthStore {
    const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_")
    return new DurableAuthStore(join(stateDir, "auth", `${safe(bindingId)}__${safe(pluginId)}__${safe(providerId)}.json`))
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
    const run = this.chain.then(() => {
      const current = this.read()
      if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return false
      this.write({ generation: current.generation + 1, ...(auth ? { auth } : {}) })
      return true
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  remove(): Promise<void> {
    const run = this.chain.then(() => {
      const current = this.read()
      if (current.generation === 0 && !current.auth) return
      this.write({ generation: current.generation + 1 })
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  private write(record: Record_): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
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
