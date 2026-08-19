import { describe, expect, test } from "bun:test"
import {
  claimHashlinePatch,
  hasHashlineTagMinted,
  parseHashlinePatch,
  rangesOverlap,
  recordHashlineTagMinted,
  releaseHashlinePatch,
  resetHashlineOverlapClaims,
  restateEvictedSessionHashlineError,
  restateEvictedSessionHashlineFailure,
} from "../packages/pi-bridge/src/hashline-overlap.ts"

describe("hashline overlap", () => {
  test("parses path, tag, and PUT ranges", () => {
    expect(parseHashlinePatch(
      "[/tmp/a.ts#A222]\nPUT 13.=15:\n+one\n+two\n+three\n",
    )).toEqual({
      path: "/tmp/a.ts",
      tag: "A222",
      ranges: [{ start: 13, end: 15 }],
    })
  })

  test("detects overlapping ranges", () => {
    expect(rangesOverlap([{ start: 10, end: 12 }], [{ start: 12, end: 14 }])).toBe(true)
    expect(rangesOverlap([{ start: 10, end: 12 }], [{ start: 40, end: 42 }])).toBe(false)
  })

  test("rejects a same-tag overlapping sibling and allows a disjoint one", () => {
    resetHashlineOverlapClaims()
    const first = parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 10.=12:\n+a\n")
    const overlap = parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 11.=13:\n+b\n")
    const disjoint = parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 40.=42:\n+c\n")
    claimHashlinePatch(first)
    expect(() => claimHashlinePatch(overlap)).toThrow(/overlaps/)
    expect(() => claimHashlinePatch(disjoint)).not.toThrow()
    releaseHashlinePatch(first)
    expect(() => claimHashlinePatch(overlap)).not.toThrow()
  })

  test("preserves claims belonging to other tags on the same path", () => {
    resetHashlineOverlapClaims()
    const oldTag = parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 10.=12:\n+a\n")
    const newTag = parseHashlinePatch("[/tmp/a.ts#B333]\nPUT 40.=42:\n+b\n")
    const oldTagOverlap = parseHashlinePatch("[/tmp/a.ts#A222]\nPUT 11.=13:\n+c\n")
    claimHashlinePatch(oldTag)
    claimHashlinePatch(newTag)
    expect(() => claimHashlinePatch(oldTagOverlap)).toThrow(/overlaps/)
  })

  test("tracks tags minted this session and resets with the registry", () => {
    resetHashlineOverlapClaims()
    expect(hasHashlineTagMinted("/tmp/a.ts", "A222")).toBe(false)
    recordHashlineTagMinted("/tmp/a.ts", "a222")
    expect(hasHashlineTagMinted("/tmp/a.ts", "A222")).toBe(true)
    // Relative/absolute path drift still matches when the basename agrees.
    expect(hasHashlineTagMinted("a.ts", "A222")).toBe(true)
    // A short hash collision on another file must not be treated as this path.
    expect(hasHashlineTagMinted("/tmp/b.ts", "A222")).toBe(false)
    expect(hasHashlineTagMinted("/other/a.ts", "A222")).toBe(false)
    recordHashlineTagMinted("src/a.ts", "B333")
    expect(hasHashlineTagMinted("other/src/a.ts", "B333")).toBe(false)
    expect(hasHashlineTagMinted("/tmp/a.ts", "C444")).toBe(false)
    resetHashlineOverlapClaims()
    expect(hasHashlineTagMinted("/tmp/a.ts", "A222")).toBe(false)
  })

  test("restates a rejection when the tag was minted this session, keeps it otherwise", () => {
    resetHashlineOverlapClaims()
    const rejection =
      "Edit rejected for /tmp/a.ts: hash #A222 is not from this session.\n" +
      "The current file hashes to #B333. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.\n\n" +
      "  1: line one\n" +
      " *2: line two\n"

    // Never minted: host message passes through untouched.
    const unknown = new Error(rejection)
    expect(restateEvictedSessionHashlineError({ path: "/tmp/a.ts", tag: "A222" }, unknown)).toBe(unknown)

    recordHashlineTagMinted("/tmp/a.ts", "A222")
    const restated = restateEvictedSessionHashlineError(
      { path: "/tmp/a.ts", tag: "A222" },
      new Error(rejection),
    )
    expect(restated).toBeInstanceOf(Error)
    const text = (restated as Error).message
    expect(text).toContain("was recorded earlier in this session")
    expect(text).toContain("The file now hashes to #B333.")
    expect(text).toContain("line two")
    expect(text).not.toContain("never invent")
    expect(text).not.toContain("is not from this session")
  })

  test("restates rejects a string error and keeps the anchored-context trailer", () => {
    resetHashlineOverlapClaims()
    recordHashlineTagMinted("/tmp/a.ts", "A222")
    const result = restateEvictedSessionHashlineError(
      { path: "/tmp/a.ts", tag: "A222" },
      "Edit rejected for /tmp/a.ts: hash #A222 is not from this session.\nThe current file hashes to #B333. boom",
    )
    expect((result as Error).message).toContain("was recorded earlier in this session")
  })

  test("restatement drops the host header lines but keeps tail context", () => {
    const text = restateEvictedSessionHashlineFailure(
      "/tmp/a.ts",
      "A222",
      "Edit rejected for /tmp/a.ts: hash #A222 is not from this session.\n" +
        "The current file hashes to #B333. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.\n\n" +
        "  9: tail line\n",
    )
    expect(text.startsWith("Write rejected for /tmp/a.ts:")).toBe(true)
    expect(text).toContain("The file now hashes to #B333.")
    expect(text).toContain("  9: tail line")
    expect(text).not.toContain("Edit rejected for /tmp/a.ts")
    expect(text).not.toContain("never invent")
  })
})
