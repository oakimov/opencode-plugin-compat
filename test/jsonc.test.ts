import { describe, expect, test } from "bun:test"
import { deletePath, parseJsonc, setPath, toValue } from "../scripts/ocp-dev/jsonc.ts"

describe("jsonc parser", () => {
  test("keeps strings that contain comment markers", () => {
    const text = `{ "url": "https://example.com/path", "note": "use /* later */" }`
    expect(toValue(parseJsonc(text))).toEqual({
      url: "https://example.com/path",
      note: "use /* later */",
    })
  })

  test("accepts line comments, block comments, and trailing commas", () => {
    const text = `{
  // keep
  "a": 1, /* block */
  "b": [true, null, "x",],
}`
    expect(toValue(parseJsonc(text))).toEqual({ a: 1, b: [true, null, "x"] })
  })

  test("parses escapes and unicode", () => {
    const text = `{ "q": "say \\"hi\\"\\n\\u0041" }`
    expect(toValue(parseJsonc(text))).toEqual({ q: "say \"hi\"\nA" })
  })
})

describe("jsonc surgical edits", () => {
  const fixture = `{
  // keep me
  "$schema": "https://app.kilo.ai/config.json",
  "permission": { "bash": { "*": "ask" } },
  /* block */
  "mcp": { "playwright": { "enabled": false } },
}
`

  test("inserts plugin without rewriting the rest of the file", () => {
    const next = setPath(fixture, ["plugin"], ["/wrapper/dist/index.js"])
    expect(next).toContain("// keep me")
    expect(next).toContain("/* block */")
    expect(next).toContain('"$schema": "https://app.kilo.ai/config.json"')
    expect(next).toContain('"permission": { "bash": { "*": "ask" } }')
    expect(next).toContain('"mcp": { "playwright": { "enabled": false } }')
    expect(toValue(parseJsonc(next))).toMatchObject({
      plugin: ["/wrapper/dist/index.js"],
    })
  })

  test("deletePath removes only the inserted key", () => {
    const next = deletePath(setPath(fixture, ["plugin"], ["/wrapper/dist/index.js"]), ["plugin"])
    expect(next).toContain("// keep me")
    expect(next).toContain('"mcp": { "playwright": { "enabled": false } }')
    expect((toValue(parseJsonc(next)) as { plugin?: unknown }).plugin).toBeUndefined()
  })

  test("nested set creates missing objects and leaves siblings", () => {
    const next = setPath(fixture, ["provider", "cursor", "npm"], "file:///wrapper")
    const value = toValue(parseJsonc(next)) as { provider: { cursor: { npm: string } }; mcp: unknown }
    expect(value.provider.cursor.npm).toBe("file:///wrapper")
    expect(value.mcp).toEqual({ playwright: { enabled: false } })
    expect(next).toContain("// keep me")
  })
})
