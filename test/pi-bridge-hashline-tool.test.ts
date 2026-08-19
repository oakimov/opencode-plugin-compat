import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { activateHashlineTool, HASHLINE_TOOL, registerHashlineTool } from "../packages/pi-bridge/src/hashline-tool.ts"
import { resetHashlineCoalesce, setHashlineCoalesceWindowMsForTests } from "../packages/pi-bridge/src/hashline-coalesce.ts"
import { resetHashlineOverlapClaims } from "../packages/pi-bridge/src/hashline-overlap.ts"
import type { PiExtensionApi, PiRegisterToolDefinition } from "../packages/pi-bridge/src/pi-provider-types.ts"

function fakePi(): PiExtensionApi & {
  registered: PiRegisterToolDefinition[]
  sessionHandlers: Array<() => void | Promise<void>>
  active: string[]
} {
  let active = ["read", "bash", "edit"]
  const registered: PiRegisterToolDefinition[] = []
  const sessionHandlers: Array<() => void | Promise<void>> = []
  return {
    registered,
    sessionHandlers,
    get active() {
      return active
    },
    registerProvider: () => {},
    registerTool: tool => {
      registered.push(tool)
    },
    on: (event, handler) => {
      if (event === "session_start") sessionHandlers.push(handler as () => void | Promise<void>)
    },
    getActiveTools: () => active,
    getAllTools: () => [...active, ...registered.map(tool => tool.name)],
    setActiveTools: async names => {
      active = [...names]
    },
  }
}

afterEach(() => {
  resetHashlineOverlapClaims()
  resetHashlineCoalesce()
  setHashlineCoalesceWindowMsForTests(25)
})

beforeEach(() => {
  resetHashlineOverlapClaims()
  resetHashlineCoalesce()
  setHashlineCoalesceWindowMsForTests(0)
})

describe("omp hashline tool", () => {
  test("registers hashline and delegates execute to the host edit tool", async () => {
    const calls: unknown[] = []
    const pi = fakePi()
    expect(registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          calls.push({ toolCallId, params, onUpdate, ctx, signal })
          return { content: [{ type: "text", text: "ok" }] }
        },
      }),
    })).toEqual([HASHLINE_TOOL])
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)
    expect(tool?.approval).toBe("write")
    const signal = new AbortController().signal
    await expect(tool?.execute("c1", { input: "[a.ts]\n1: x" }, signal, "upd", { cwd: "/tmp" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    })
    expect(calls).toEqual([{
      toolCallId: "c1",
      params: { input: "[a.ts]\n1: x" },
      onUpdate: "upd",
      ctx: { cwd: "/tmp" },
      signal,
    }])
  })

  test("rejects an empty patch and missing host edit", async () => {
    const pi = fakePi()
    registerHashlineTool(pi, { resolveEdit: async () => undefined })
    const tool = pi.registered[0]!
    await expect(tool.execute("c1", { input: "   " }, undefined, undefined, {})).rejects.toThrow("non-empty")
    await expect(tool.execute("c1", { input: "[a.ts]\n1: x" }, undefined, undefined, {})).rejects.toThrow("unavailable")
  })

  test("activates hashline on session_start", async () => {
    const pi = fakePi()
    activateHashlineTool(pi, registerHashlineTool(pi, { resolveEdit: async () => undefined }))
    await pi.sessionHandlers[0]!()
    expect(pi.active).toContain(HASHLINE_TOOL)
  })

  test("restates a 'not from this session' rejection for a tag minted this session", async () => {
    resetHashlineOverlapClaims()
    let stage: "success" | "reject" = "success"
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async () => {
          if (stage === "success") {
            return { content: [{ type: "text", text: "[/tmp/a.ts#A222]\n1: one\n2: two\n" }] }
          }
          throw new Error(
            "Edit rejected for /tmp/a.ts: hash #A222 is not from this session.\n" +
              "The current file hashes to #B333. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.\n\n" +
              "  1: one\n" +
              " *2: two\n",
          )
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    await tool.execute("c1", { input: "[/tmp/a.ts#A222]\n1: one\n" }, undefined, undefined, {})
    stage = "reject"
    const error = await tool
      .execute("c2", { input: "[/tmp/a.ts#A222]\n1: one\n" }, undefined, undefined, {})
      .then(() => null, err => err)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain("was recorded earlier in this session")
    expect(message).toContain("The file now hashes to #B333.")
    expect(message).toContain("2: two")
    expect(message).not.toContain("never invent")
    expect(message).not.toContain("is not from this session")
  })

  test("passes through the host rejection when the tag was never minted", async () => {
    resetHashlineOverlapClaims()
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async () => {
          throw new Error(
            "Edit rejected for /tmp/a.ts: hash #C444 is not from this session.\n" +
              "The current file hashes to #B333. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.\n\n" +
              "  1: one\n",
          )
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    const error = await tool
      .execute("c1", { input: "[/tmp/a.ts#C444]\n1: one\n" }, undefined, undefined, {})
      .then(() => null, err => err)
    expect((error as Error).message).toContain("never invent")
    expect((error as Error).message).toContain("is not from this session")
  })

  test("restates a non-throwing isError result for a minted tag", async () => {
    resetHashlineOverlapClaims()
    let stage: "success" | "reject" = "success"
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async () => {
          if (stage === "success") {
            return { content: [{ type: "text", text: "[/tmp/a.ts#A222]\n1: one\n" }] }
          }
          return {
            isError: true,
            content: [{
              type: "text",
              text:
                "Edit rejected for /tmp/a.ts: hash #A222 is not from this session.\n" +
                "The current file hashes to #B333. Re-read the file with `read` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.\n\n" +
                "  1: one\n",
            }],
          }
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    await tool.execute("c1", { input: "[/tmp/a.ts#A222]\n1: one\n" }, undefined, undefined, {})
    stage = "reject"
    const result = await tool.execute("c2", { input: "[/tmp/a.ts#A222]\n1: one\n" }, undefined, undefined, {})
    expect((result as { isError: boolean }).isError).toBe(true)
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain("was recorded earlier in this session")
    expect(text).not.toContain("never invent")
  })

  test("releases an overlap claim after an ordinary non-throwing isError result", async () => {
    resetHashlineOverlapClaims()
    let attempts = 0
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async () => {
          attempts++
          if (attempts === 1) {
            return { isError: true, content: [{ type: "text", text: "context mismatch" }] }
          }
          return { content: [{ type: "text", text: "[/tmp/a.ts#B333]\n1: one\n" }] }
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    const patch = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    const first = await tool.execute("c1", { input: patch }, undefined, undefined, {})
    expect((first as { isError: boolean }).isError).toBe(true)
    await expect(tool.execute("c2", { input: patch }, undefined, undefined, {})).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  test("coalesces parallel same-tag hunks into one host edit", async () => {
    resetHashlineOverlapClaims()
    setHashlineCoalesceWindowMsForTests(0)
    const calls: unknown[] = []
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async (_toolCallId, params) => {
          calls.push(params)
          return { content: [{ type: "text", text: "[/tmp/a.ts#B333]\n1: one\n" }] }
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    const first = "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n"
    const second = "[/tmp/a.ts#A222]\nPUT 40.=42:\n+two\n"
    const [left, right] = await Promise.all([
      tool.execute("c1", { input: first }, undefined, undefined, {}),
      tool.execute("c2", { input: second }, undefined, undefined, {}),
    ])
    expect(calls).toHaveLength(1)
    const merged = (calls[0] as { input: string }).input
    expect(merged).toContain("PUT 1.=1:")
    expect(merged).toContain("PUT 40.=42:")
    expect(left).toEqual(right)
  })

  test("does not coalesce parallel hunks on different tags", async () => {
    resetHashlineOverlapClaims()
    setHashlineCoalesceWindowMsForTests(0)
    const calls: unknown[] = []
    const pi = fakePi()
    registerHashlineTool(pi, {
      resolveEdit: async () => ({
        execute: async (_toolCallId, params) => {
          calls.push(params)
          return { content: [{ type: "text", text: "ok" }] }
        },
      }),
    })
    const tool = pi.registered.find(entry => entry.name === HASHLINE_TOOL)!
    await Promise.all([
      tool.execute("c1", { input: "[/tmp/a.ts#A222]\nPUT 1.=1:\n+one\n" }, undefined, undefined, {}),
      tool.execute("c2", { input: "[/tmp/a.ts#B333]\nPUT 40.=42:\n+two\n" }, undefined, undefined, {}),
    ])
    expect(calls).toHaveLength(2)
  })
})
