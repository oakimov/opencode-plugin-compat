/**
 * Adapter vocabulary: question / planEnter / planExit rotations.
 *
 * omp maps `question` → `ask` (plus `multiple` ↔ `multi` and id synthesis).
 * planEnter / planExit are pass-through by default; sparse profile overrides
 * exercise the same catalog/call/prompt paths used for MiMo task/actor.
 */
import { describe, expect, test } from "bun:test"
import {
  buildVocabulary,
  translateCall,
  translateCatalog,
  translatePrompt,
  type Vocabulary,
} from "@opencode-compat/adapter"

/** Sparse profile matching `toolRolesForHostId("omp")`. */
function ompQuestionProfile() {
  return { tools: { question: "ask" as const } }
}

/** Sparse profile that rotates plan tools to catch rename regressions. */
function rotatedPlanProfile() {
  return {
    tools: {
      planEnter: "enter_plan" as const,
      planExit: "leave_plan" as const,
    },
  }
}

function ompVocab(advertised: string[] = ["ask", "read", "bash"]): Vocabulary {
  const vocab = buildVocabulary(ompQuestionProfile(), advertised)
  if (!vocab?.questionHost) throw new Error("expected omp question→ask rotation")
  return vocab
}

function planVocab(
  advertised: string[] = ["enter_plan", "leave_plan", "read"],
): Vocabulary {
  const vocab = buildVocabulary(rotatedPlanProfile(), advertised)
  if (!vocab?.planEnterHost || !vocab?.planExitHost) {
    throw new Error("expected planEnter/planExit rotations")
  }
  return vocab
}

const ASK_SCHEMA = {
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
}

describe("buildVocabulary — question / plan roles", () => {
  test("omp rotates question → ask when ask is advertised", () => {
    const vocab = ompVocab()
    expect(vocab.questionHost).toBe("ask")
    expect(vocab.toHost.get("question")).toBe("ask")
    expect(vocab.subagentHost).toBeUndefined()
    expect(vocab.planEnterHost).toBeUndefined()
  })

  test("omp leaves question untranslated when ask is absent", () => {
    expect(buildVocabulary(ompQuestionProfile(), ["question", "read"])).toBeUndefined()
    expect(buildVocabulary(ompQuestionProfile(), ["read", "bash"])).toBeUndefined()
  })

  test("OpenCode with both question and ask advertised does not rotate", () => {
    // No profile override → ask is an unrelated host tool; question stays itself.
    expect(buildVocabulary({ tools: {} }, ["question", "ask"])).toBeUndefined()
  })

  test("planEnter/planExit rotate only when override host tools are live", () => {
    const vocab = planVocab()
    expect(vocab.planEnterHost).toBe("enter_plan")
    expect(vocab.planExitHost).toBe("leave_plan")
    expect(vocab.toHost.get("plan_enter")).toBe("enter_plan")
    expect(vocab.toHost.get("plan_exit")).toBe("leave_plan")
  })

  test("planEnter alone can rotate while planExit stays unadvertised", () => {
    const vocab = buildVocabulary(rotatedPlanProfile(), ["enter_plan", "read"])
    expect(vocab?.planEnterHost).toBe("enter_plan")
    expect(vocab?.planExitHost).toBeUndefined()
  })

  test("refuses to shadow an independently advertised canonical plan_enter", () => {
    // Host advertises both enter_plan (override target) and plan_enter (canonical).
    // Without vacating plan_enter via another rotation, the enter binding is dropped.
    const vocab = buildVocabulary(rotatedPlanProfile(), [
      "enter_plan",
      "plan_enter",
      "leave_plan",
    ])
    expect(vocab?.planEnterHost).toBeUndefined()
    expect(vocab?.planExitHost).toBe("leave_plan")
  })
})

describe("translateCatalog — question / plan", () => {
  test("replaces ask with canonical question schema (header + multiple)", () => {
    const tools = [
      { type: "function", name: "read", inputSchema: { type: "object" } },
      {
        type: "function",
        name: "ask",
        description: "omp ask",
        inputSchema: ASK_SCHEMA,
      },
    ]
    const out = translateCatalog(tools, ompVocab())
    const names = out.map((t) => (t as { name: string }).name).sort()
    expect(names).toEqual(["question", "read"])
    expect(out.find((t) => (t as { name: string }).name === "ask")).toBeUndefined()

    const question = out.find((t) => (t as { name: string }).name === "question") as {
      description: string
      inputSchema: {
        properties: {
          questions: {
            items: { properties: Record<string, unknown>; required: string[] }
          }
        }
        required: string[]
      }
    }
    expect(question.description).toContain("clarifying questions")
    expect(question.inputSchema.required).toEqual(["questions"])
    expect(question.inputSchema.properties.questions.items.required).toEqual([
      "question",
      "header",
      "options",
    ])
    expect(question.inputSchema.properties.questions.items.properties["multiple"]).toBeDefined()
    expect(question.inputSchema.properties.questions.items.properties["multi"]).toBeUndefined()
    expect(question.inputSchema.properties.questions.items.properties["id"]).toBeUndefined()
  })

  test("planEnter/planExit catalog uses emptyish object schemas with explanations", () => {
    const tools = [
      { type: "function", name: "enter_plan", description: "host enter", inputSchema: { type: "object" } },
      { type: "function", name: "leave_plan", description: "host leave", inputSchema: { type: "object" } },
    ]
    const out = translateCatalog(tools, planVocab())
    const names = out.map((t) => (t as { name: string }).name).sort()
    expect(names).toEqual(["plan_enter", "plan_exit"])

    const enter = out.find((t) => (t as { name: string }).name === "plan_enter") as {
      description: string
      inputSchema: { properties: Record<string, unknown> }
    }
    const exit = out.find((t) => (t as { name: string }).name === "plan_exit") as {
      description: string
      inputSchema: { properties: Record<string, unknown> }
    }
    expect(enter.description).toContain("Enter plan mode")
    expect(exit.description).toContain("Leave plan mode")
    expect(enter.inputSchema.properties["explanation"]).toBeDefined()
    expect(exit.inputSchema.properties["explanation"]).toBeDefined()
  })
})

describe("translateCall — questionCallInput edge cases", () => {
  test("maps question → ask and multiple → multi with synthesized ids", () => {
    const translated = translateCall(
      "c1",
      "question",
      {
        questions: [
          {
            question: "Ship it?",
            header: "Ship",
            options: [{ label: "Yes", description: "" }],
            multiple: true,
          },
          {
            question: "Also?",
            header: "Also",
            options: [{ label: "Ok", description: "" }],
          },
        ],
      },
      ompVocab(),
    )
    expect(translated).toEqual([
      {
        toolCallId: "c1",
        toolName: "ask",
        input: {
          questions: [
            {
              question: "Ship it?",
              header: "Ship",
              options: [{ label: "Yes", description: "" }],
              id: "q1",
              multi: true,
            },
            {
              question: "Also?",
              header: "Also",
              options: [{ label: "Ok", description: "" }],
              id: "q2",
            },
          ],
        },
      },
    ])
  })

  test("preserves an existing id and does not clobber multi when both flags present", () => {
    const translated = translateCall(
      "c2",
      "question",
      {
        questions: [
          {
            id: "custom",
            question: "Keep?",
            header: "Keep",
            options: [{ label: "A", description: "" }],
            multiple: true,
            multi: false,
          },
        ],
      },
      ompVocab(),
    )
    const q = (translated?.[0]?.input.questions as Array<Record<string, unknown>>)[0]
    expect(q["id"]).toBe("custom")
    // multiple→multi only when multi is absent; existing multi wins.
    expect(q["multi"]).toBe(false)
    expect(q["multiple"]).toBe(true)
  })

  test("empty string id is treated as missing and synthesized", () => {
    const translated = translateCall(
      "c3",
      "question",
      {
        questions: [{ id: "", question: "Q", header: "Q", options: [] }],
      },
      ompVocab(),
    )
    expect((translated?.[0]?.input.questions as Array<{ id: string }>)[0].id).toBe("q1")
  })

  test("non-array questions pass through unchanged (no crash)", () => {
    const input = { questions: "not-an-array", extra: 1 }
    const translated = translateCall("c4", "question", input, ompVocab())
    expect(translated).toEqual([{ toolCallId: "c4", toolName: "ask", input }])
  })

  test("non-record question entries are preserved as-is", () => {
    const translated = translateCall(
      "c5",
      "question",
      { questions: [null, "x", { question: "ok", header: "ok", options: [] }] },
      ompVocab(),
    )
    const qs = translated?.[0]?.input.questions as unknown[]
    expect(qs[0]).toBeNull()
    expect(qs[1]).toBe("x")
    expect((qs[2] as { id: string }).id).toBe("q3")
  })

  test("unrelated tool names are not translated", () => {
    expect(translateCall("c6", "ask", { questions: [] }, ompVocab())).toBeUndefined()
    expect(translateCall("c7", "read", {}, ompVocab())).toBeUndefined()
  })

  test("plan_enter / plan_exit rename to host tools and keep input", () => {
    const enter = translateCall(
      "p1",
      "plan_enter",
      { explanation: "design first" },
      planVocab(),
    )
    expect(enter).toEqual([
      { toolCallId: "p1", toolName: "enter_plan", input: { explanation: "design first" } },
    ])
    const exit = translateCall("p2", "plan_exit", {}, planVocab())
    expect(exit).toEqual([{ toolCallId: "p2", toolName: "leave_plan", input: {} }])
  })
})

describe("translatePrompt — question / plan history restatement", () => {
  test("restates ask tool-call/result under canonical question name", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ask",
            input: {
              questions: [
                {
                  id: "q1",
                  question: "Ready?",
                  options: [{ label: "Yes" }],
                  multi: true,
                },
              ],
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "ask",
            output: '{"answers":["Yes"]}',
          },
        ],
      },
    ]
    const out = translatePrompt(prompt, ompVocab())
    const call = (out[0] as { content: Array<{ toolName: string; input: unknown }> }).content[0]
    const result = (out[1] as { content: Array<{ toolName: string }> }).content[0]
    expect(call.toolName).toBe("question")
    expect(result.toolName).toBe("question")
    // Adapter prompt restatement renames only; schema reshape is provider→host on call.
    expect(call.input).toEqual({
      questions: [
        {
          id: "q1",
          question: "Ready?",
          options: [{ label: "Yes" }],
          multi: true,
        },
      ],
    })
  })

  test("restates enter_plan / leave_plan under plan_enter / plan_exit", () => {
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "e1",
            toolName: "enter_plan",
            input: { explanation: "x" },
          },
          {
            type: "tool-call",
            toolCallId: "x1",
            toolName: "leave_plan",
            input: {},
          },
        ],
      },
    ]
    const out = translatePrompt(prompt, planVocab())
    const parts = (out[0] as { content: Array<{ toolName: string }> }).content
    expect(parts.map((p) => p.toolName)).toEqual(["plan_enter", "plan_exit"])
  })

  test("unrelated history tools pass through unchanged", () => {
    const prompt = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "r1", toolName: "read", input: { path: "a" } }],
      },
    ]
    const out = translatePrompt(prompt, ompVocab())
    expect(out[0]).toEqual(prompt[0])
  })
})
