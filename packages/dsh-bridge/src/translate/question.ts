/**
 * DSH `ask_user_question` ↔ OpenCode `question`.
 *
 * Host (`packages/interaction/tool-ask-user/src/index.ts`):
 *   `{questions:[{id, question, header?, options?, multi_select?}]}`
 * OpenCode / Cursor:
 *   `{questions:[{question, header, options[{label,description}], multiple?}]}`
 *
 * Do not import pi-bridge — copy only the OpenCode catalog contract.
 */

export const CANONICAL_QUESTION_TOOL = "question"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** OpenCode `question` schema — what plugins / providers see. */
export function canonicalQuestionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to ask",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "Complete question" },
            header: { type: "string", description: "Very short label (max 30 chars)" },
            options: {
              type: "array",
              description: "Available choices",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Display text (1-5 words, concise)" },
                  description: { type: "string", description: "Explanation of choice" },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiple: {
              type: "boolean",
              description: "Allow selecting multiple choices",
            },
          },
          required: ["question", "header", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  }
}

export function canonicalQuestionDescription(): string {
  return (
    "Ask the user one or more clarifying questions before continuing. " +
    "This session tool is named question (host may call it ask_user_question). " +
    "Use it for human choices — do not look for AskQuestion, and do not open MCP catalogs to find a substitute."
  )
}

function headerFromQuestion(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 30) return trimmed || "Question"
  return trimmed.slice(0, 29).trimEnd() + "…"
}

/** Provider `question` → host `ask_user_question` (add id, map multiple → multi_select). */
export function translateToHostQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  const questions = input["questions"]
  if (!Array.isArray(questions)) return input
  return {
    ...input,
    questions: questions.map((entry, index) => {
      if (!isRecord(entry)) return entry
      const out: Record<string, unknown> = { ...entry }
      if (typeof out["id"] !== "string" || !out["id"]) out["id"] = `q${index + 1}`
      if (Object.hasOwn(out, "multiple")) {
        if (!Object.hasOwn(out, "multi_select")) out["multi_select"] = out["multiple"]
        delete out["multiple"]
      }
      return out
    }),
  }
}

export type HostQuestionPrompt = { id?: string; question: string }

/** Pull `{id, question}` from a host or OpenCode question-call payload. */
export function questionPromptsFromInput(input: unknown): HostQuestionPrompt[] {
  if (!isRecord(input)) return []
  const questions = input["questions"]
  if (!Array.isArray(questions)) return []
  const out: HostQuestionPrompt[] = []
  for (const entry of questions) {
    if (!isRecord(entry)) continue
    const question = typeof entry["question"] === "string" ? entry["question"] : ""
    if (!question) continue
    const id = typeof entry["id"] === "string" && entry["id"] ? entry["id"] : undefined
    out.push(id ? { id, question } : { question })
  }
  return out
}

type DshQuestionAnswer = { id?: string; selected: string[]; custom?: string }

function parseDshQuestionAnswers(resultText: string): DshQuestionAnswer[] | undefined {
  const trimmed = resultText.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isRecord(parsed) || !Array.isArray(parsed["answers"])) return undefined
    const rows: DshQuestionAnswer[] = []
    for (const entry of parsed["answers"]) {
      if (!isRecord(entry)) continue
      const selected = Array.isArray(entry["selected"])
        ? entry["selected"].filter((value): value is string => typeof value === "string")
        : []
      const custom = typeof entry["custom"] === "string" && entry["custom"] ? entry["custom"] : undefined
      const id = typeof entry["id"] === "string" && entry["id"] ? entry["id"] : undefined
      rows.push(id ? { id, selected, ...(custom ? { custom } : {}) } : { selected, ...(custom ? { custom } : {}) })
    }
    return rows
  } catch {
    return undefined
  }
}

/**
 * DSH projects `{answers:[{id, selected}]}` (`packages/interaction/tool-ask-user`).
 * OpenCode `question` (and Cursor CreatePlan/SwitchMode parsers) expect
 * `User has answered your questions: "<prompt>"="<answer>"…`.
 */
export function formatOpenCodeQuestionResult(
  questions: readonly HostQuestionPrompt[],
  resultText: string,
): string | undefined {
  const rows = parseDshQuestionAnswers(resultText)
  if (!rows || questions.length === 0) return undefined
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < questions.length; index++) {
    const prompt = questions[index]!
    const row = (prompt.id ? rows.find(answer => answer.id === prompt.id) : undefined) ?? rows[index]
    const parts = row ? [...row.selected, ...row.custom ? [row.custom] : []] : []
    pairs.push([prompt.question, parts.join(", ") || "Unanswered"])
  }
  const formatted = pairs.map(([question, answer]) => `"${question}"="${answer}"`).join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

/** Host `ask_user_question` → provider `question` for history replay. */
export function translateToProviderQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  const questions = input["questions"]
  if (!Array.isArray(questions)) return input
  return {
    questions: questions.map((entry) => {
      if (!isRecord(entry)) return entry
      const questionText = typeof entry["question"] === "string" ? entry["question"] : ""
      const header =
        typeof entry["header"] === "string" && entry["header"]
          ? entry["header"]
          : headerFromQuestion(questionText)
      const options = Array.isArray(entry["options"])
        ? entry["options"].map((option) => {
          if (!isRecord(option)) return option
          return {
            label: typeof option["label"] === "string" ? option["label"] : String(option),
            description: typeof option["description"] === "string" ? option["description"] : "",
          }
        })
        : []
      const out: Record<string, unknown> = { question: questionText, header, options }
      if (entry["multi_select"] === true || entry["multiple"] === true) out["multiple"] = true
      return out
    }),
  }
}
