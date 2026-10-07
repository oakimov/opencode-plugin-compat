import { describe, expect, test } from "bun:test"
import { mimoProfile } from "@opencode-compat/profile"
import { buildVocabulary, translatePrompt } from "@opencode-compat/adapter"
import { translateSystemToolNames } from "../packages/adapter/src/vocabulary.ts"
import { translatePromptToolNames } from "../packages/opencode-loader/src/prompt-tool-names.ts"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt } from "../packages/pi-bridge/src/translate/context.ts"
import { buildPiToolInputVocabulary } from "../packages/pi-bridge/src/translate/subagent.ts"
import { translateGenerateOptionsToPrompt } from "../packages/dsh-bridge/src/translate/context.ts"

const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } })

describe("translatePromptToolNames", () => {
  const renames = new Map([["actor", "task"], ["task", "todowrite"], ["find", "glob"]])

  test("rewrites whole-name code spans in one pass, so swaps never chain", () => {
    expect(translatePromptToolNames("Work tracking: `task`. Subagents: `actor`.", renames))
      .toBe("Work tracking: `todowrite`. Subagents: `task`.")
  })

  test("leaves prose, partial spans and unknown names alone", () => {
    const text = "find the method; the task is large; run `find .` or `task list`; use `read`."
    expect(translatePromptToolNames(text, renames)).toBe(text)
  })

  test("rewrites tool-list lines only when asked", () => {
    const text = "Available tools:\n- find: Find files by pattern\n- read: Read a file"
    expect(translatePromptToolNames(text, renames)).toBe(text)
    expect(translatePromptToolNames(text, renames, { toolListItems: true }))
      .toBe("Available tools:\n- glob: Find files by pattern\n- read: Read a file")
  })

  for (const [name, translate] of [["bridges", translatePromptToolNames], ["clones", translateSystemToolNames]] as const) {
    test(`${name}: preserves escaped literals and fenced examples`, () => {
      const text = "Use `find`. Literal \\`find`.\n```sh\n`find`\n- find: literal\n```\n~~~md\n`task`\n~~~\nUse `actor`."
      expect(translate(text, renames, { toolListItems: true })).toBe(
        "Use `glob`. Literal \\`find`.\n```sh\n`find`\n- find: literal\n```\n~~~md\n`task`\n~~~\nUse `task`.",
      )
    })

    test(`${name}: does not treat part of a longer backtick span as a tool reference`, () => {
      const text = "Literal ``prefix `find` suffix``; use ``find``."
      expect(translate(text, renames)).toBe("Literal ``prefix `find` suffix``; use ``glob``.")
    })
  }
})

describe("host prompts follow the canonical catalog", () => {
  test("MiMo: `task`/`actor` in the system prompt match the swapped catalog", () => {
    const vocab = buildVocabulary(mimoProfile(), ["read", "actor", "task"])!
    const [system] = translatePrompt(
      [{ role: "system", content: "- Work tracking: `task` (see below).\n- Subagents: `actor` (see below)." }],
      vocab,
    ) as Array<{ content: string }>
    expect(system!.content).toBe("- Work tracking: `todowrite` (see below).\n- Subagents: `task` (see below).")
  })

  test("pi: the tool list and folded developer text name canonical tools", () => {
    const tools = [tool("read"), tool("find")]
    const prompt = translateContextToPrompt(
      {
        systemPrompt: "Available tools:\n- find: Find files\n- read: Read files",
        tools,
        messages: [{ role: "developer", content: "Prefer `find` over bash." } as never],
      },
      undefined,
      piProfile(),
      buildPiToolInputVocabulary(tools, piProfile()),
    ) as Array<{ role: string; content: unknown }>
    expect(prompt[0]!.content).toBe("Available tools:\n- glob: Find files\n- read: Read files")
    expect(prompt[1]!.content).toBe("Prefer `glob` over bash.")
  })

  test("omp: a `todo` reference names the canonical todowrite", () => {
    const tools = [tool("read"), tool("todo")]
    const prompt = translateContextToPrompt(
      { systemPrompt: "Track phases with `todo`.", tools, messages: [] },
      undefined,
      ompProfile(),
      buildPiToolInputVocabulary(tools, ompProfile()),
    ) as Array<{ content: unknown }>
    expect(prompt[0]!.content).toBe("Track phases with `todowrite`.")
  })

  test("DSH: system text and system messages name canonical tools", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "fixture",
      model: "test",
      system: "Record work with `todo_write`.",
      tools: [tool("todo_write"), tool("read")],
      messages: [{ role: "system", source: { kind: "system" }, content: [{ type: "text", text: "Ask with `ask_user_question`." }] }],
    }) as Array<{ content: unknown }>
    // A file tool is offered, so DSH's home-directory note follows the system text.
    expect(prompt[0]!.content).toStartWith("Record work with `todowrite`.\n\nHost file tools do not expand \"~\".")
    // ask_user_question is not advertised in this call, so it is not renamed.
    expect(prompt[1]!.content).toBe("Ask with `ask_user_question`.")
  })
})
