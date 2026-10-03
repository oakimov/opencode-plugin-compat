import { describe, expect, test } from "bun:test"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"
import { foldCursorAgentInstructions } from "../packages/dsh-bridge/src/cursor-instructions.ts"
import type { DshGenerateOptions } from "../packages/dsh-bridge/src/translate/context.ts"

const instructions = (text: string) => ({
  role: "user" as const,
  source: { kind: "agent-instructions" },
  content: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }],
})
const user = (text: string) => ({ role: "user" as const, source: { kind: "user" }, content: [{ type: "text", text }] })

const request = (): DshGenerateOptions => ({
  provider: "fixture",
  model: "test",
  sessionId: "main",
  system: "DSH system prompt",
  messages: [
    instructions("AGENTS.md: answer ZEBRA-42"),
    user("What is the codeword?"),
    instructions("src/AGENTS.md: scoped rule"),
  ],
})

/** The AI-SDK prompt an adapter hands its provider for one request. */
async function providerPrompt(
  prepareOptions: ((options: DshGenerateOptions) => DshGenerateOptions) | undefined,
  options: DshGenerateOptions,
): Promise<any[]> {
  let received: any
  const adapter = new DshLlmAdapter({
    providerName: "fixture",
    ...(prepareOptions ? { prepareOptions } : {}),
    getLanguageModel: () => ({
      doStream: async (call: any) => {
        received = call
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop" })
          controller.close()
        } }) }
      },
    }) as never,
  })
  for await (const _ of adapter.stream(options)) { /* drain */ }
  return received.prompt
}

describe("Cursor workspace instructions on DSH", () => {
  test("folds agent-instructions messages into system in request order", () => {
    const folded = foldCursorAgentInstructions(request())
    expect(folded.system).toBe(
      "DSH system prompt\n\n<system-reminder>\nAGENTS.md: answer ZEBRA-42\n</system-reminder>"
        + "\n\n<system-reminder>\nsrc/AGENTS.md: scoped rule\n</system-reminder>",
    )
    expect(folded.messages).toEqual([user("What is the codeword?")])
  })

  test("leaves a request without instruction messages untouched", () => {
    const options = { ...request(), messages: [user("hi")] }
    expect(foldCursorAgentInstructions(options)).toBe(options)
  })

  test("the Cursor path delivers instructions as system context, not user turns", async () => {
    const prompt = await providerPrompt(foldCursorAgentInstructions, request())
    expect(prompt.filter((message) => message.role === "user")).toHaveLength(1)
    expect(prompt.filter((message) => message.role === "system").map((message) => message.content).join("\n"))
      .toContain("AGENTS.md: answer ZEBRA-42")
  })

  test("other providers keep DSH's native user-role instruction messages", async () => {
    const prompt = await providerPrompt(undefined, request())
    expect(prompt.filter((message) => message.role === "user")).toHaveLength(3)
  })
})
