import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildStreamSimple } from "../packages/pi-bridge/src/bridge.ts"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import type { PiEventStreamLike, PiRuntime } from "../packages/pi-bridge/src/host/runtime.ts"
import { registerCursorHostTools } from "../packages/pi-bridge/src/cursor-host-tools.ts"

type StreamCall = {
  tools?: Array<{ name: string }>
  headers?: Record<string, string>
  abortSignal?: AbortSignal
}

function awaitBunFile(relative: string): string {
  return readFileSync(path.join(import.meta.dir, "..", relative), "utf-8")
}

class FakeEventStream implements PiEventStreamLike {
  events: unknown[] = []
  push(event: unknown) { this.events.push(event) }
  end() {}
  fail(error: unknown) { throw error }
  async result() { return undefined }
  async *[Symbol.asyncIterator]() { yield* this.events }
}

const MODEL = {
  id: "generic-model",
  api: "generic-bridge",
  provider: "generic",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as never

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
})

function makeCallAwaiter(target: number) {
  let resolve: (() => void) | undefined
  let settled = false
  let count = 0
  const gate = new Promise<void>((res) => { resolve = res })
  return {
    arrived: () => {
      count += 1
      if (count >= target && !settled) {
        settled = true
        resolve?.()
      }
    },
    wait: () => gate,
  }
}

describe.each([
  ["omp", ompProfile(), [tool("read"), tool("ask"), tool("task"), tool("plan_enter"), tool("plan_exit"), tool("custom-tool")]],
  ["pi", piProfile(), [tool("read"), tool("subagent"), tool("find"), tool("custom-tool")]],
] as const)("Pi-family catalog affinity — %s", (_host, profile, fullCatalog) => {
  test("keeps lifecycle/full calls correlated without inventing lifecycle tools", async () => {
    const calls: StreamCall[] = []
    const arrived = makeCallAwaiter(2)
    const streamSimple = buildStreamSimple(
      {
        name: "generic",
        api: "generic-bridge",
        baseUrl: "https://example.invalid",
        getLanguageModel: async () => ({
          specificationVersion: "v3",
          provider: "generic",
          modelId: "generic-model",
          supportedUrls: {},
          doGenerate: async () => { throw new Error("not used") },
          doStream: async (call: StreamCall) => {
            calls.push(call)
            arrived.arrived()
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 0, text: 0, reasoning: 0 },
                    },
                  })
                  controller.close()
                },
              }),
            }
          },
        } as never),
      },
      {
        profile,
        createAssistantMessageEventStream: () => new FakeEventStream(),
        toolSchema: value => value.parameters as Record<string, unknown>,
      } satisfies PiRuntime,
    )

    const signal = new AbortController().signal
    const options = {
      sessionId: "same-provider-session",
      headers: { "x-provider": "generic" },
      signal,
    }
    streamSimple(MODEL, { messages: [] } as never, options)
    streamSimple(MODEL, { messages: [], tools: [...fullCatalog] } as never, options)
    await arrived.wait()

    expect(calls[0]?.tools).toBeUndefined()
    expect(calls[0]?.headers).toEqual({
      "x-provider": "generic",
      "x-opencode-session": "same-provider-session",
    })
    expect(calls[1]?.headers).toEqual(calls[0]?.headers)
    expect(calls[0]?.abortSignal).toBe(signal)
    expect(calls[1]?.abortSignal).toBe(signal)

    const names = calls[1]?.tools?.map((value: { name: string }) => value.name)
    expect(names).toContain("read")
    expect(names).toContain("custom-tool")
    expect(names).toEqual([...(names ?? [])].sort())
    if (profile.id === "omp") {
      expect(names).toEqual(["custom-tool", "plan_enter", "plan_exit", "question", "read", "task"])
    } else {
      expect(names).toEqual(["custom-tool", "glob", "read", "task"])
    }

    // OCP translates a call view; the host-owned source catalog is untouched.
    expect(fullCatalog.map(value => value.name)).toEqual(
      profile.id === "omp"
        ? ["read", "ask", "task", "plan_enter", "plan_exit", "custom-tool"]
        : ["read", "subagent", "find", "custom-tool"],
    )
  })
})

// Cursor-specific host affordances stay outside the generic Pi provider bridge.
// OCP may know this consumer contract while buildStreamSimple remains reusable
// by every AI-SDK/OpenCode provider loaded through pi-bridge.
describe("Cursor host tools remain an optional OCP layer", () => {
  test("generic Pi entry code has no static Cursor-host-tool import", () => {
    const source = awaitBunFile("packages/pi-bridge/src/extension.ts")
    expect(source).not.toMatch(/^\s*import\s+[^;]*from\s+["']\.\/cursor-host-tools\.js["']/m)
    expect(source).toMatch(/await import\(["']\.\/cursor-host-tools\.js["']\)/)
  })
  test.each([
    ["omp", ["plan_enter", "plan_exit", "cursor_plan_stage", "cursor_image_save"]],
    ["pi", ["cursor_image_save"]],
  ] as const)("%s registers only its supported optional host tools", (hostId, expected) => {
    const registered: string[] = []
    registerCursorHostTools(
      { registerTool: (definition: { name: string }) => registered.push(definition.name) } as never,
      {
        hostId,
        executeImageSave: async () => "saved",
        resolvePlanHost: async () => undefined,
      },
    )
    expect(registered).toEqual([...expected])
  })
})
