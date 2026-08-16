/**
 * Pi-family interactive prompt ↔ OpenCode's canonical `question` tool.
 *
 * omp advertises `ask` with `{questions:[{id, question, options, multi?}]}`.
 * OpenCode plugins expect `question` with
 * `{questions:[{question, header, options[{label,description}], multiple?}]}`.
 *
 * Activated only when the host profile declares `tools.question` and the named
 * tool is live in the current catalog — same gate as the subagent role.
 */
import type { PiHostProfile } from "../host/profile.js"
import type { PiTool } from "../pi-provider-types.js"

export const CANONICAL_QUESTION_TOOL = "question"

export type PiQuestionVocabulary = {
  hostToolName: string
  hostDescription: string
}

export type TranslatedQuestionCall = {
  toolName: string
  input: Record<string, unknown>
}

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

export function canonicalQuestionDescription(vocabulary: PiQuestionVocabulary): string {
  return (
    "Ask the user one or more clarifying questions before continuing. " +
    `Host tool: ${vocabulary.hostToolName}. ${vocabulary.hostDescription}`
  )
}

/** Resolve the live question role from catalog + profile. */
export function buildPiQuestionVocabulary(
  tools: readonly PiTool[] | undefined,
  profile: PiHostProfile,
): PiQuestionVocabulary | undefined {
  if (!tools || tools.length === 0) return undefined
  const configured = profile.tools?.question
  if (!configured) return undefined
  const hostTool = tools.find((tool) => tool.name === configured.name)
  if (!hostTool) return undefined
  return {
    hostToolName: configured.name,
    hostDescription: hostTool.description,
  }
}

function headerFromQuestion(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= 30) return trimmed || "Question"
  return trimmed.slice(0, 29).trimEnd() + "…"
}

/** Provider `question` → host `ask` (add id, map multiple → multi). */
export function translateCanonicalQuestionCall(
  toolName: string,
  input: Record<string, unknown>,
  vocabulary: PiQuestionVocabulary | undefined,
): TranslatedQuestionCall | undefined {
  if (!vocabulary || toolName !== CANONICAL_QUESTION_TOOL) return undefined

  const questions = input["questions"]
  if (!Array.isArray(questions)) {
    return { toolName: vocabulary.hostToolName, input }
  }

  return {
    toolName: vocabulary.hostToolName,
    input: {
      ...input,
      questions: questions.map((entry, index) => {
        if (!isRecord(entry)) return entry
        const out: Record<string, unknown> = { ...entry }
        if (typeof out["id"] !== "string" || !out["id"]) {
          out["id"] = `q${index + 1}`
        }
        if (Object.hasOwn(out, "multiple") && !Object.hasOwn(out, "multi")) {
          out["multi"] = out["multiple"]
          delete out["multiple"]
        }
        // omp options are `{label, description?, preview?}`; drop required
        // OpenCode `description: ""` only when absent on the host side is fine —
        // keep description when present.
        return out
      }),
    },
  }
}

/** Host `ask` → provider `question` for history replay. */
export function translateHostQuestionCall(
  toolName: string,
  input: Record<string, unknown>,
  vocabulary: PiQuestionVocabulary | undefined,
): TranslatedQuestionCall | undefined {
  if (!vocabulary || toolName !== vocabulary.hostToolName) return undefined

  const questions = input["questions"]
  if (!Array.isArray(questions)) {
    return { toolName: CANONICAL_QUESTION_TOOL, input }
  }

  return {
    toolName: CANONICAL_QUESTION_TOOL,
    input: {
      questions: questions.map((entry) => {
        if (!isRecord(entry)) return entry
        const questionText =
          typeof entry["question"] === "string" ? entry["question"] : ""
        const header =
          typeof entry["header"] === "string" && entry["header"]
            ? entry["header"]
            : headerFromQuestion(questionText)
        const options = Array.isArray(entry["options"])
          ? entry["options"].map((option) => {
              if (!isRecord(option)) return option
              return {
                label: typeof option["label"] === "string" ? option["label"] : String(option),
                description:
                  typeof option["description"] === "string" ? option["description"] : "",
              }
            })
          : []
        const out: Record<string, unknown> = {
          question: questionText,
          header,
          options,
        }
        if (entry["multi"] === true || entry["multiple"] === true) {
          out["multiple"] = true
        }
        return out
      }),
    },
  }
}

export function canonicalQuestionToolName(
  toolName: string,
  vocabulary: PiQuestionVocabulary | undefined,
): string {
  if (!vocabulary) return toolName
  if (toolName === vocabulary.hostToolName) return CANONICAL_QUESTION_TOOL
  return toolName
}
