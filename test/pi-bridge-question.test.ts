/**
 * omp `ask` ↔ OpenCode `question` vocabulary.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import {
  buildPiQuestionVocabulary,
  CANONICAL_QUESTION_TOOL,
  translateCanonicalQuestionCall,
  translateCanonicalToolCall,
  translateHostQuestionCall,
  translateTools,
} from "../packages/pi-bridge/src/index.ts"
import { installPiPathBridge } from "../packages/pi-bridge/src/path-bridge.ts"

const ASK_TOOL = {
  name: "ask",
  description: "Prompt the interactive user for answers.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            options: { type: "array" },
            multi: { type: "boolean" },
          },
        },
      },
    },
  },
} as const

const toSchema = (tool: { parameters?: unknown }) =>
  (tool.parameters ?? { type: "object" }) as Record<string, unknown>

describe("pi-bridge ask ↔ question", () => {
  test("omp activates question vocabulary when ask is live", () => {
    const vocabulary = buildPiQuestionVocabulary([ASK_TOOL] as never, ompProfile())
    expect(vocabulary?.hostToolName).toBe("ask")
  })

  test("pi has no question role by default", () => {
    expect(buildPiQuestionVocabulary([ASK_TOOL] as never, piProfile())).toBeUndefined()
  })

  test("catalog remaps ask to canonical question schema", () => {
    const question = buildPiQuestionVocabulary([ASK_TOOL] as never, ompProfile())
    const tools = translateTools([ASK_TOOL] as never, toSchema, undefined, undefined, question)
    expect(tools?.[0]).toMatchObject({
      name: CANONICAL_QUESTION_TOOL,
    })
    const schema = tools?.[0]?.inputSchema as {
      properties: { questions: { items: { properties: Record<string, unknown>; required: string[] } } }
    }
    expect(schema.properties.questions.items.required).toEqual(["question", "header", "options"])
    expect(schema.properties.questions.items.properties["multiple"]).toBeDefined()
    expect(schema.properties.questions.items.properties["multi"]).toBeUndefined()
  })

  test("provider question call becomes host ask with id + multi", () => {
    const question = buildPiQuestionVocabulary([ASK_TOOL] as never, ompProfile())!
    const translated = translateCanonicalQuestionCall(
      "question",
      {
        questions: [
          {
            question: "Ship it?",
            header: "Ship",
            options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
            multiple: true,
          },
        ],
      },
      question,
    )
    expect(translated).toEqual({
      toolName: "ask",
      input: {
        questions: [
          {
            id: "q1",
            question: "Ship it?",
            header: "Ship",
            options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
            multi: true,
          },
        ],
      },
    })
  })

  test("translateCanonicalToolCall routes question through ask", () => {
    const question = buildPiQuestionVocabulary([ASK_TOOL] as never, ompProfile())
    const translated = translateCanonicalToolCall(
      "question",
      {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "OK", description: "" }],
          },
        ],
      },
      undefined,
      undefined,
      question,
    )
    expect(translated?.toolName).toBe("ask")
    expect((translated?.input.questions as Array<{ id: string }>)[0]?.id).toBe("q1")
  })

  test("host ask history restates as OpenCode question", () => {
    const question = buildPiQuestionVocabulary([ASK_TOOL] as never, ompProfile())!
    const translated = translateHostQuestionCall(
      "ask",
      {
        questions: [
          {
            id: "q1",
            question: "Which path?",
            options: [{ label: "A" }, { label: "B", description: "second" }],
            multi: true,
          },
        ],
      },
      question,
    )
    expect(translated).toEqual({
      toolName: "question",
      input: {
        questions: [
          {
            question: "Which path?",
            header: "Which path?",
            options: [
              { label: "A", description: "" },
              { label: "B", description: "second" },
            ],
            multiple: true,
          },
        ],
      },
    })
  })
})

describe("installPiPathBridge", () => {
  test("installs .omp project + agent global dirs", () => {
    const key = Symbol.for("opencode.host.path-bridge")
    delete (globalThis as Record<PropertyKey, unknown>)[key]
    installPiPathBridge("omp", { HOME: "/tmp/home-omp" })
    const bridge = (globalThis as Record<PropertyKey, unknown>)[key] as {
      projectConfigDirs: (root: string) => string[]
      globalConfigDirs: () => string[]
      configFileNames: string[]
    }
    expect(bridge.projectConfigDirs("/ws")).toEqual(["/ws/.omp"])
    expect(bridge.globalConfigDirs()).toEqual(["/tmp/home-omp/.omp/agent"])
    expect(bridge.configFileNames).toEqual(["settings.json", "pi-bridge.json"])
  })

  test("pi uses .pi and honors PI_CODING_AGENT_DIR", () => {
    const key = Symbol.for("opencode.host.path-bridge")
    installPiPathBridge("pi", {
      HOME: "/tmp/home-pi",
      PI_CODING_AGENT_DIR: "/custom/agent",
    })
    const bridge = (globalThis as Record<PropertyKey, unknown>)[key] as {
      projectConfigDirs: (root: string) => string[]
      globalConfigDirs: () => string[]
    }
    expect(bridge.projectConfigDirs("/ws")).toEqual(["/ws/.pi"])
    expect(bridge.globalConfigDirs()).toEqual(["/custom/agent"])
  })

  test("data/cache roots use the host agent root and dual-write the legacy key", () => {
    const key = Symbol.for("opencode.host.path-bridge")
    const legacy = Symbol.for("opencode.compat.path-bridge")
    delete (globalThis as Record<PropertyKey, unknown>)[legacy]
    installPiPathBridge("omp", {
      HOME: "/tmp/home",
      XDG_CACHE_HOME: "/xdg/cache",
    })
    const bridge = (globalThis as Record<PropertyKey, unknown>)[key] as {
      globalDataDir: () => string
      globalCacheDir: () => string
    }
    expect(bridge.globalDataDir()).toBe("/tmp/home/.omp/agent")
    expect(bridge.globalCacheDir()).toBe("/tmp/home/.omp/agent/cache/opencode-providers")
    expect((globalThis as Record<PropertyKey, unknown>)[legacy])
      .toBe((globalThis as Record<PropertyKey, unknown>)[key])
  })
})
