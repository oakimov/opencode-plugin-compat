import { describe, expect, test } from "bun:test"
import { installMissingPathGuard, missingPathDecision, missingPathReason } from "../packages/dsh-bridge/src/missing-path.ts"

const HOME = "/Users/me"
const WORKSPACE = "/work/project"
const present = new Set([
  "/", "/Users", HOME, `${HOME}/Projects`, `${HOME}/Projects/repo`, `${HOME}/Projects/repo/guide.md`,
  "/work", WORKSPACE, `${WORKSPACE}/src`, `${WORKSPACE}/src/a.ts`,
])
const exists = (target: string) => present.has(target)
const reason = (value: unknown) => missingPathReason({ value, cwd: WORKSPACE, home: HOME, exists })

describe("missing path reasons", () => {
  test("existing and unresolvable paths pass through to the host", () => {
    expect(reason(`${HOME}/Projects/repo/guide.md`)).toBeUndefined()
    expect(reason("src/a.ts")).toBeUndefined()
    expect(missingPathReason({ value: "relative.txt", cwd: undefined, home: HOME, exists })).toBeUndefined()
    expect(reason("https://example.com/x")).toBeUndefined()
    expect(reason(`${WORKSPACE}/src/*.ts`)).toBeUndefined()
    expect(reason(undefined)).toBeUndefined()
    expect(reason("")).toBeUndefined()
  })

  test("an unexpanded ~ names the absolute path to retry", () => {
    const text = reason("~/Projects/repo/guide.md")!
    expect(text).toContain(`resolved it to "${WORKSPACE}/~/Projects/repo/guide.md"`)
    expect(text).toContain(`Retry with the absolute path "${HOME}/Projects/repo/guide.md".`)
    const missing = reason("~/Projects/repo/nope.md")!
    expect(missing).toContain(`The home directory is "${HOME}"`)
    expect(missing).toContain(`glob (pattern "**/nope.md", path "${HOME}/Projects/repo")`)
  })

  test("a guessed home directory names the real one", () => {
    expect(reason("/Users/another-user/Projects/repo/guide.md"))
      .toBe(`"/Users/another-user/Projects/repo/guide.md" does not exist. The home directory is "${HOME}"; retry with "${HOME}/Projects/repo/guide.md".`)
  })

  test("any other missing path names the glob lookup from its nearest existing directory", () => {
    expect(reason("src/b.ts"))
      .toBe(`"${WORKSPACE}/src/b.ts" does not exist. Find it with glob (pattern "**/b.ts", path "${WORKSPACE}/src") and retry with a path it returns.`)
    expect(reason("/nowhere/deep/file.md")).toContain(`path "/")`)
  })
})

describe("missing path guard", () => {
  const agent = (provider: string, cwd: string = WORKSPACE) => ({ options: { provider }, session: { header: { cwd } } })
  const bridged = new Set(["cursor-opencode"])
  const decide = (exec: Parameters<typeof missingPathDecision>[0]) => missingPathDecision(exec, bridged, { home: HOME, exists })

  test("denies a bridged call whose existing-path argument is missing", () => {
    expect(decide({ name: "read", arguments: { file_path: "~/Projects/repo/guide.md" }, agent: agent("cursor-opencode") })?.kind).toBe("deny")
    expect(decide({ name: "grep", arguments: { pattern: "x", path: "/Users/other/Projects/repo" }, agent: agent("cursor-opencode") })?.reason)
      .toContain(`retry with "${HOME}/Projects/repo"`)
    expect(decide({ name: "bash", arguments: { command: "pwd", workdir: "/tmp/gone" }, agent: agent("cursor-opencode") })?.kind).toBe("deny")
    const viaHeader = { session: { header: { cwd: WORKSPACE }, requestHeader: () => ({ config: { provider: "cursor-opencode" } }) } }
    expect(decide({ name: "edit", arguments: { file_path: "src/missing.ts" }, agent: viaHeader })?.kind).toBe("deny")
  })

  test("leaves other providers, nested dispatches, creations, remote workspaces and present paths alone", () => {
    const missing = { file_path: "/nowhere/file.md" }
    expect(decide({ name: "read", arguments: missing, agent: agent("deepseek-official") })).toBeUndefined()
    expect(decide({ name: "read", arguments: missing, agent: agent("cursor-opencode"), parent: {} })).toBeUndefined()
    expect(decide({ name: "write", arguments: missing, agent: agent("cursor-opencode") })).toBeUndefined()
    expect(decide({ name: "read", arguments: missing, agent: agent("cursor-opencode", "/remote/home/me") })).toBeUndefined()
    expect(decide({ name: "read", arguments: missing })).toBeUndefined()
    expect(decide({ name: "read", arguments: { file_path: "src/a.ts" }, agent: agent("cursor-opencode") })).toBeUndefined()
    expect(decide({ name: "glob", arguments: { pattern: "**/*.ts" }, agent: agent("cursor-opencode") })).toBeUndefined()
  })

  test("the waterfall listener denies before dispatch or delegates", async () => {
    let listener: ((exec: never, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) | undefined
    installMissingPathGuard((event, fn) => {
      expect(event).toBe("tools/pre-execute")
      listener = fn as never
    }, bridged)
    const next = async () => ({ kind: "allow" })
    const cwd = process.cwd()
    const live = { options: { provider: "cursor-opencode" }, session: { header: { cwd } } }
    expect(await listener!({ name: "read", arguments: { file_path: "package.json" }, agent: live } as never, next)).toEqual({ kind: "allow" })
    const denied = await listener!({ name: "read", arguments: { file_path: "no-such-file.ocp" }, agent: live } as never, next)
    expect(denied.kind).toBe("deny")
  })
})
