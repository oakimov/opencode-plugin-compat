/**
 * Edge cases for omp ask ↔ question and path-bridge integration surfaces.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import {
  buildPiQuestionVocabulary,
  CANONICAL_QUESTION_TOOL,
  translateCanonicalQuestionCall,
  translateCanonicalToolCall,
  translateHostQuestionCall,
  translateContextToPrompt,
  translateToolChoice,
  translateTools,
  type PiQuestionVocabulary,
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
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
} as const

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
} as const

const toSchema = (tool: { parameters?: unknown }) =>
  (tool.parameters ?? { type: "object" }) as Record<string, unknown>

function ompQuestion(): PiQuestionVocabulary {
  const vocabulary = buildPiQuestionVocabulary([ASK_TOOL, READ_TOOL] as never, ompProfile())
  if (!vocabulary) throw new Error("expected omp ask vocabulary")
  return vocabulary
}

describe("buildPiQuestionVocabulary edges", () => {
  test("requires live ask in catalog even when profile declares question role", () => {
    expect(buildPiQuestionVocabulary([READ_TOOL] as never, ompProfile())).toBeUndefined()
    expect(buildPiQuestionVocabulary(undefined, ompProfile())).toBeUndefined()
    expect(buildPiQuestionVocabulary([] as never, ompProfile())).toBeUndefined()
  })

  test("name must match profile.tools.question exactly", () => {
    const wrong = { ...ASK_TOOL, name: "Ask" }
    expect(buildPiQuestionVocabulary([wrong] as never, ompProfile())).toBeUndefined()
  })

  test("pi profile never activates even when ask is advertised", () => {
    expect(buildPiQuestionVocabulary([ASK_TOOL] as never, piProfile())).toBeUndefined()
  })
})

describe("translateCanonicalQuestionCall edges", () => {
  const question = ompQuestion()

  test("returns undefined without vocabulary or wrong tool name", () => {
    expect(translateCanonicalQuestionCall("question", { questions: [] }, undefined)).toBeUndefined()
    expect(translateCanonicalQuestionCall("ask", { questions: [] }, question)).toBeUndefined()
  })

  test("preserves existing id; empty id is synthesized", () => {
    const translated = translateCanonicalQuestionCall(
      "question",
      {
        questions: [
          { id: "keep", question: "A", header: "A", options: [] },
          { id: "", question: "B", header: "B", options: [] },
        ],
      },
      question,
    )
    const qs = translated!.input.questions as Array<{ id: string }>
    expect(qs[0].id).toBe("keep")
    expect(qs[1].id).toBe("q2")
  })

  test("multiple → multi only when multi absent; both flags keep multi", () => {
    const onlyMultiple = translateCanonicalQuestionCall(
      "question",
      {
        questions: [
          {
            question: "Q",
            header: "Q",
            options: [{ label: "a", description: "" }],
            multiple: true,
          },
        ],
      },
      question,
    )
    expect((onlyMultiple!.input.questions as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "q1",
      multi: true,
    })
    expect(
      Object.hasOwn((onlyMultiple!.input.questions as Array<Record<string, unknown>>)[0], "multiple"),
    ).toBe(false)

    const both = translateCanonicalQuestionCall(
      "question",
      {
        questions: [
          {
            question: "Q",
            header: "Q",
            options: [],
            multiple: true,
            multi: false,
          },
        ],
      },
      question,
    )
    const entry = (both!.input.questions as Array<Record<string, unknown>>)[0]
    expect(entry["multi"]).toBe(false)
    expect(entry["multiple"]).toBe(true)
  })

  test("non-array questions and non-record entries do not throw", () => {
    expect(
      translateCanonicalQuestionCall("question", { questions: "x", keep: 1 }, question),
    ).toEqual({ toolName: "ask", input: { questions: "x", keep: 1 } })

    const mixed = translateCanonicalQuestionCall(
      "question",
      { questions: [null, 42, { question: "ok", header: "ok", options: [] }] },
      question,
    )
    const qs = mixed!.input.questions as unknown[]
    expect(qs[0]).toBeNull()
    expect(qs[1]).toBe(42)
    expect((qs[2] as { id: string }).id).toBe("q3")
  })
})

describe("translateHostQuestionCall edges", () => {
  const question = ompQuestion()

  test("maps ask → question, multi → multiple, synthesizes header", () => {
    const long =
      "This is a very long question text that exceeds thirty characters for sure"
    const translated = translateHostQuestionCall(
      "ask",
      {
        questions: [
          {
            id: "q1",
            question: long,
            options: [{ label: "A" }, { label: "B", description: "bee" }, "raw"],
            multi: true,
          },
        ],
      },
      question,
    )
    expect(translated?.toolName).toBe(CANONICAL_QUESTION_TOOL)
    const q = (translated!.input.questions as Array<Record<string, unknown>>)[0]
    expect(q["header"]).toBe("This is a very long question…")
    expect((q["header"] as string).length).toBeLessThanOrEqual(30)
    expect(q["multiple"]).toBe(true)
    expect(q["options"]).toEqual([
      { label: "A", description: "" },
      { label: "B", description: "bee" },
      "raw",
    ])
    expect(Object.hasOwn(q, "id")).toBe(false)
    expect(Object.hasOwn(q, "multi")).toBe(false)
  })

  test("keeps explicit header; ignores wrong tool / missing vocab", () => {
    const translated = translateHostQuestionCall(
      "ask",
      {
        questions: [
          {
            id: "q1",
            question: "Short?",
            header: "Custom",
            options: [{ label: "Y", description: "" }],
          },
        ],
      },
      question,
    )
    expect((translated!.input.questions as Array<{ header: string }>)[0].header).toBe("Custom")

    expect(translateHostQuestionCall("question", { questions: [] }, question)).toBeUndefined()
    expect(translateHostQuestionCall("ask", { questions: [] }, undefined)).toBeUndefined()
  })

  test("empty question text yields header Question", () => {
    const translated = translateHostQuestionCall(
      "ask",
      { questions: [{ id: "q1", question: "   ", options: [] }] },
      question,
    )
    expect((translated!.input.questions as Array<{ header: string }>)[0].header).toBe("Question")
  })
})

describe("catalog / toolChoice / history integration", () => {
  const question = ompQuestion()

  test("translateTools remaps ask and leaves read untouched", () => {
    const tools = translateTools(
      [ASK_TOOL, READ_TOOL] as never,
      toSchema,
      undefined,
      undefined,
      question,
    )
    expect(tools?.map((t) => t.name).sort()).toEqual(["question", "read"])
    const q = tools?.find((t) => t.name === "question")
    expect(q?.description).toContain("ask")
    const schema = q?.inputSchema as {
      properties: { questions: { items: { properties: Record<string, unknown> } } }
    }
    expect(schema.properties.questions.items.properties["multiple"]).toBeDefined()
    expect(schema.properties.questions.items.properties["multi"]).toBeUndefined()
  })

  test("translateTools without question vocab leaves ask as ask", () => {
    const tools = translateTools([ASK_TOOL] as never, toSchema)
    expect(tools?.[0]?.name).toBe("ask")
  })

  test("translateToolChoice remaps named ask → question", () => {
    expect(translateToolChoice({ name: "ask" }, undefined, undefined, question)).toEqual({
      type: "tool",
      toolName: "question",
    })
    expect(translateToolChoice({ name: "read" }, undefined, undefined, question)).toEqual({
      type: "tool",
      toolName: "read",
    })
    expect(translateToolChoice("none", undefined, undefined, question)).toEqual({ type: "none" })
    expect(translateToolChoice("auto", undefined, undefined, question)).toBeUndefined()
  })

  test("history restates host ask as OpenCode question via translateContextToPrompt", () => {
    const prompt = translateContextToPrompt(
      {
        system: "sys",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "ask",
                arguments: {
                  questions: [
                    {
                      id: "q1",
                      question: "Continue?",
                      options: [{ label: "Yes" }],
                      multi: true,
                    },
                  ],
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "ask",
            content: [{ type: "text", text: "Yes" }],
            isError: false,
          },
        ],
      } as never,
      undefined,
      ompProfile(),
      undefined,
      question,
    )

    const assistant = prompt.find((m) => m.role === "assistant") as {
      content: Array<{ type: string; toolName?: string; input?: unknown }>
    }
    const toolMsg = prompt.find((m) => m.role === "tool") as {
      content: Array<{ toolName?: string }>
    }
    const call = assistant.content.find((p) => p.type === "tool-call")
    expect(call?.toolName).toBe("question")
    const q = (call?.input as { questions: Array<Record<string, unknown>> }).questions[0]
    expect(q["multiple"]).toBe(true)
    expect(q["header"]).toBe("Continue?")
    expect(Object.hasOwn(q, "id")).toBe(false)
    expect(toolMsg.content[0]?.toolName).toBe("question")
  })

  test("translateCanonicalToolCall routes question through ask", () => {
    const translated = translateCanonicalToolCall(
      "question",
      {
        questions: [
          {
            question: "Go?",
            header: "Go",
            options: [{ label: "Y", description: "" }],
            multiple: true,
          },
        ],
      },
      undefined,
      undefined,
      question,
    )
    expect(translated?.toolName).toBe("ask")
    expect((translated?.input.questions as Array<{ id: string; multi?: boolean }>)[0]).toEqual({
      question: "Go?",
      header: "Go",
      options: [{ label: "Y", description: "" }],
      id: "q1",
      multi: true,
    })
  })
})

describe("installPiPathBridge edges", () => {
  const key = Symbol.for("opencode.compat.path-bridge")

  test("PI_CONFIG_DIR overrides home segment; coding agent dir wins", () => {
    delete (globalThis as Record<PropertyKey, unknown>)[key]
    installPiPathBridge("omp", {
      HOME: "/tmp/h",
      PI_CONFIG_DIR: ".alt",
    })
    const bridge = (globalThis as Record<PropertyKey, unknown>)[key] as {
      globalConfigDirs: () => string[]
      projectConfigDirs: (root: string) => string[]
    }
    expect(bridge.globalConfigDirs()).toEqual(["/tmp/h/.alt/agent"])
    expect(bridge.projectConfigDirs("/ws")).toEqual(["/ws/.omp"])

    installPiPathBridge("omp", {
      HOME: "/tmp/h",
      PI_CONFIG_DIR: ".alt",
      PI_CODING_AGENT_DIR: "/explicit",
    })
    expect(
      ((globalThis as Record<PropertyKey, unknown>)[key] as typeof bridge).globalConfigDirs(),
    ).toEqual(["/explicit"])
  })

  test("reinstall switches omp → pi project dir", () => {
    installPiPathBridge("omp", { HOME: "/tmp/h" })
    installPiPathBridge("pi", { HOME: "/tmp/h" })
    const bridge = (globalThis as Record<PropertyKey, unknown>)[key] as {
      projectConfigDirs: (root: string) => string[]
      globalConfigDirs: () => string[]
    }
    expect(bridge.projectConfigDirs("/ws")).toEqual(["/ws/.pi"])
    expect(bridge.globalConfigDirs()).toEqual(["/tmp/h/.pi/agent"])
  })
})
