import { afterEach, describe, expect, test } from "bun:test"
import {
  coalesceSameTagHashline,
  hashlineCoalesceKey,
  resetHashlineCoalesce,
  setHashlineCoalesceWindowMsForTests,
} from "../packages/pi-bridge/src/hashline-coalesce.ts"
import { parseHashlinePatch } from "../packages/pi-bridge/src/hashline-overlap.ts"

afterEach(() => {
  resetHashlineCoalesce()
  setHashlineCoalesceWindowMsForTests(25)
})

describe("hashline same-tag coalesce", () => {
  test("keys on path#tag and skips untagged patches", () => {
    expect(hashlineCoalesceKey(parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 1.=1:\n+x\n"))).toBe("/tmp/a.ts#A222")
    expect(hashlineCoalesceKey(parseHashlinePatch("[/tmp/a.ts]\nPUT 1.=1:\n+x\n"))).toBeUndefined()
  })

  test("merges parallel same-tag hunks into one apply", async () => {
    setHashlineCoalesceWindowMsForTests(0)
    const calls: string[] = []
    const apply = async (merged: string) => {
      calls.push(merged)
      return "ok"
    }
    const a = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    const b = "[/tmp/a.ts#A222]\nPUT 40.=42:\n+two\n"
    const [left, right] = await Promise.all([
      coalesceSameTagHashline({ input: a, meta: parseHashlinePatch(a) }, apply),
      coalesceSameTagHashline({ input: b, meta: parseHashlinePatch(b) }, apply),
    ])
    expect(left).toBe("ok")
    expect(right).toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("PUT 1.=1:")
    expect(calls[0]).toContain("PUT 40.=42:")
    expect(calls[0]).toContain("[/tmp/a.ts#A222]")
  })

  test("does not merge different tags or paths", async () => {
    setHashlineCoalesceWindowMsForTests(0)
    const calls: string[] = []
    const apply = async (merged: string) => {
      calls.push(merged)
      return merged
    }
    const a = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    const b = "[/tmp/a.ts#B333]\nPUT 40.=42:\n+two\n"
    const c = "[/tmp/b.ts#A222]\nPUT 1.=1:\n+three\n"
    await Promise.all([
      coalesceSameTagHashline({ input: a, meta: parseHashlinePatch(a) }, apply),
      coalesceSameTagHashline({ input: b, meta: parseHashlinePatch(b) }, apply),
      coalesceSameTagHashline({ input: c, meta: parseHashlinePatch(c) }, apply),
    ])
    expect(calls).toHaveLength(3)
  })

  test("applies an untagged patch immediately", async () => {
    const calls: string[] = []
    const input = "[/tmp/a.ts]\nPUT 1.=1:\n+x\n"
    const result = await coalesceSameTagHashline(
      { input, meta: parseHashlinePatch(input) },
      async merged => {
        calls.push(merged)
        return "solo"
      },
    )
    expect(result).toBe("solo")
    expect(calls).toEqual([input])
  })

  test("drops an aborted member before flush and applies the rest", async () => {
    setHashlineCoalesceWindowMsForTests(20)
    const calls: string[] = []
    const apply = async (merged: string) => {
      calls.push(merged)
      return "ok"
    }
    const controller = new AbortController()
    const a = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    const b = "[/tmp/a.ts#A222]\nPUT 40.=42:\n+two\n"
    const aborted = coalesceSameTagHashline(
      { input: a, meta: parseHashlinePatch(a), signal: controller.signal },
      apply,
    )
    const kept = coalesceSameTagHashline({ input: b, meta: parseHashlinePatch(b) }, apply)
    controller.abort()
    await expect(aborted).rejects.toThrow(/aborted/)
    await expect(kept).resolves.toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("PUT 40.=42:")
    expect(calls[0]).not.toContain("PUT 1.=1:")
  })

  test("rejects already-aborted members without joining", async () => {
    const controller = new AbortController()
    controller.abort()
    const input = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    await expect(coalesceSameTagHashline(
      { input, meta: parseHashlinePatch(input), signal: controller.signal },
      async () => "nope",
    )).rejects.toThrow(/aborted/)
  })
})
