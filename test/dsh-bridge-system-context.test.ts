import { describe, expect, test } from "bun:test"
import { dshProfile } from "../packages/dsh-bridge/src/host/profile.ts"
import { homePathNote, translateGenerateOptionsToPrompt, type DshGenerateOptions, type DshMessage } from "../packages/dsh-bridge/src/translate/context.ts"

const catalog = (text: string): DshMessage => ({
  role: "user",
  source: { kind: "skill-catalog", form: "catalog" },
  content: [{ type: "text", text }],
})
const user = (text: string): DshMessage => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] })

describe("DSH skill catalog reaches providers as system context", () => {
  test("the latest catalog joins the system prompt and leaves the user turns", () => {
    const options: DshGenerateOptions = {
      provider: "p",
      model: "m",
      system: "base system",
      messages: [
        user("first request"),
        catalog("<available_skills>\n- `old`: Old\n</available_skills>"),
        user("second request"),
        catalog("<available_skills>\n- `new`: New\n</available_skills>"),
      ],
    }
    const prompt = translateGenerateOptionsToPrompt(options)
    expect(prompt[0]).toEqual({ role: "system", content: "base system\n\n<available_skills>\n- `new`: New\n</available_skills>" })
    expect(prompt.slice(1)).toEqual([
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "user", content: [{ type: "text", text: "second request" }] },
    ])
  })

  test("without a catalog the prompt is unchanged", () => {
    const prompt = translateGenerateOptionsToPrompt({ provider: "p", model: "m", system: "base", messages: [user("hi")] })
    expect(prompt).toEqual([
      { role: "system", content: "base" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })
})

describe("DSH home directory note", () => {
  const read = { name: "read", description: "Read", parameters: { type: "object", properties: {} } }
  const question = { name: "ask_user_question", description: "Ask", parameters: { type: "object", properties: {} } }

  test("a request offering file tools states the home directory", () => {
    expect(homePathNote([read], dshProfile(), "/Users/me"))
      .toBe('Host file tools do not expand "~". The home directory is "/Users/me"; use absolute paths.')
    expect(homePathNote([question], dshProfile(), "/Users/me")).toBeUndefined()
    expect(homePathNote(undefined, dshProfile(), "/Users/me")).toBeUndefined()
    expect(homePathNote([read], { ...dshProfile(), fileToolsExpandTilde: true }, "/Users/me")).toBeUndefined()
  })

  test("the note follows the system prompt and skill catalog", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "p",
      model: "m",
      system: "base",
      tools: [read],
      messages: [catalog("<available_skills></available_skills>"), user("hi")],
    })
    const system = prompt[0] as { role: string; content: string }
    expect(system.role).toBe("system")
    expect(system.content.startsWith("base\n\n<available_skills></available_skills>\n\nHost file tools do not expand \"~\".")).toBe(true)
  })
})
