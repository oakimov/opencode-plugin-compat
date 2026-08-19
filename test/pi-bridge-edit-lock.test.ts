import { describe, expect, test } from "bun:test"
import { editLockKey, withEditLock } from "../packages/pi-bridge/src/edit-lock.ts"

describe("edit lock", () => {
  test("serializes overlapping edits of the same path", async () => {
    const order: string[] = []
    let started = 0
    const first = withEditLock("/tmp/a", async () => {
      started++
      order.push("a-start")
      await Promise.resolve()
      order.push("a-end")
    })
    const second = withEditLock("/tmp/a", async () => {
      started++
      order.push("b-start")
      order.push("b-end")
    })
    await Promise.all([first, second])
    expect(started).toBe(2)
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  test("allows edits of different paths to overlap", async () => {
    let releaseA!: () => void
    const holdA = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let bStarted = false
    const first = withEditLock("/tmp/a", async () => {
      await holdA
    })
    const second = withEditLock("/tmp/b", async () => {
      bStarted = true
    })
    await Promise.resolve()
    expect(bStarted).toBe(true)
    releaseA()
    await Promise.all([first, second])
  })

  test("uses one global key when no path is supplied", () => {
    expect(editLockKey(undefined)).toBe("*")
  })
})
