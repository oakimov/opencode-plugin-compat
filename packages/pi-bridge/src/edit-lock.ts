const locks = new Map<string, Promise<void>>()

export function editLockKey(path: string | undefined): string {
  if (!path) return "*"
  return path
}

export async function withEditLock<T>(path: string | undefined, run: () => Promise<T>): Promise<T> {
  const key = editLockKey(path)
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const queued = previous.then(() => current)
  locks.set(key, queued)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (locks.get(key) === queued) locks.delete(key)
  }
}
