import { describe, expect, test } from "bun:test"
import { translateGenerateOptionsToPrompt, translateTools } from "../packages/dsh-bridge/src/translate/context.ts"
import { collectV3ToDsh } from "../packages/dsh-bridge/src/translate/stream.ts"
import { cursorFinishUsage } from "../packages/dsh-bridge/src/translate/cursor-usage.ts"
import { rewriteProviderToolCall } from "../packages/dsh-bridge/src/translate/tools.ts"

function parts(streamParts: unknown[]): ReadableStream<never> {
  return new ReadableStream({
    start(controller) {
      for (const part of streamParts) controller.enqueue(part as never)
      controller.close()
    },
  })
}

describe("dsh-bridge message translation", () => {
  test("system + user text", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }],
    })
    expect(prompt).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("assistant tool-call then user tool-result becomes V3 tool turn with recovered name", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
          source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
        },
        {
          role: "user",
          content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
          source: { kind: "tool", callId: "c1" },
        },
      ],
    })
    expect(prompt).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: { type: "text", value: "ok" },
        }],
      },
    ])
  })

  test("user text plus tool-result stays two turns, text first", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }], source: { kind: "model", provider: "cursor-opencode", model: "composer-2" } },
        {
          role: "user",
          content: [
            { type: "text", text: "note" },
            { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }], isError: true },
          ],
          source: { kind: "user" },
        },
      ],
    })
    expect(prompt).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
      { role: "user", content: [{ type: "text", text: "note" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: { type: "error-text", value: "done" },
        }],
      },
    ])
  })

  test("tool results without a matching tool call are dropped, not named unknown", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "note" },
            { type: "tool-result", toolCallId: "gone", content: [{ type: "text", text: "done" }] },
          ],
          source: { kind: "user" },
        },
        { role: "tool", toolCallId: "gone-too", content: [{ type: "text", text: "x" }] },
      ],
    } as never)
    expect(prompt).toEqual([{ role: "user", content: [{ type: "text", text: "note" }] }])
  })

  test("image blocks become text placeholders, not empty files", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [{
        role: "user",
        content: [{ type: "image", attachment: { mediaType: "image/png", width: 8, height: 4 } }],
        source: { kind: "user" },
      }],
    })
    expect(prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "[image image/png 8x4]" }] },
    ])
  })

  test("tools sort by canonical name, not declaration order", () => {
    const tools = translateTools([
      { name: "write", description: "w", parameters: {} },
      { name: "bash", description: "b", parameters: {} },
    ])
    expect(tools?.map(t => t.name)).toEqual(["bash", "write"])
  })

  test("schema property keys serialize in sorted order", () => {
    const tools = translateTools([{
      name: "read",
      description: "r",
      parameters: {
        type: "object",
        properties: {
          offset: { type: "number" },
          file_path: { type: "string" },
        },
        required: ["offset", "file_path"],
      },
    }])
    expect(Object.keys(
      (tools?.[0]?.inputSchema as { properties: Record<string, unknown> }).properties,
    )).toEqual(["filePath", "offset"])
    expect((tools?.[0]?.inputSchema as { required: string[] }).required).toEqual(["filePath", "offset"])
  })

  test("read/write/edit advertise filePath and keep glob search-root path", () => {
    const tools = translateTools([
      {
        name: "read",
        description: "r",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Path to read" },
            offset: { type: "number" },
          },
          required: ["file_path"],
        },
      },
      {
        name: "glob",
        description: "g",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          required: ["pattern"],
        },
      },
    ])
    // UTF-16 code-unit order: glob sorts before read.
    const byName = new Map((tools ?? []).map(t => [t.name, t.inputSchema]))
    expect(byName.get("read")).toEqual({
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to read" },
        offset: { type: "number" },
      },
      required: ["filePath"],
    })
    expect(byName.get("glob")).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    })
  })

  test("bash catalog drops required description and renames timeoutMs", () => {
    const tools = translateTools([{
      name: "bash",
      description: "b",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: { type: "string" },
          timeoutMs: { type: "number" },
          workdir: { type: "string" },
        },
        required: ["command", "description"],
      },
    }])
    expect(tools?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
        timeout: { type: "number" },
        workdir: { type: "string" },
      },
      required: ["command"],
    })
  })

  test("subagent advertises OpenCode foreground semantics and replays DSH background calls", () => {
    const [tool] = translateTools([{
      name: "subagent",
      description: "It runs in the background by default and returns a subagent id.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
          run_in_background: { type: "boolean", description: "Defaults to true." },
        },
        required: ["description", "prompt"],
      },
    }]) ?? []
    expect(tool?.description).toContain("Waits for the subagent and returns its result")
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort()).toEqual(["background", "description", "prompt"])
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "default",
      messages: [{
        role: "assistant",
        source: { kind: "model" },
        content: [{
          type: "tool-call",
          id: "c1",
          name: "subagent",
          arguments: JSON.stringify({ description: "Scan", prompt: "Scan repo", run_in_background: true }),
        }],
      }],
    })
    expect(prompt).toEqual([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "subagent", input: { description: "Scan", prompt: "Scan repo", background: true } }],
    }])
  })

  test("todo_write and ask_user_question advertise OpenCode names", () => {
    const tools = translateTools([
      {
        name: "todo_write",
        description: "todos",
        parameters: {
          type: "object",
          properties: { todos: { type: "array" } },
          required: ["todos"],
        },
      },
      {
        name: "ask_user_question",
        description: "ask the user",
        parameters: {
          type: "object",
          properties: { questions: { type: "array" } },
          required: ["questions"],
        },
      },
      { name: "write", description: "w", parameters: {} },
    ])
    expect(tools?.map(t => t.name)).toEqual(["question", "todowrite", "write"])
    const question = tools?.find(t => t.name === "question")
    expect(question?.description).toContain("named question")
    expect(question?.description).toContain("visible waiting-for-answer prompt")
    expect(question?.inputSchema).toEqual({
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
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
    })
  })

  test("keeps DSH plan exit stable in the provider catalog and history", () => {
    const tools = translateTools([
      {
        name: "exit_plan_mode",
        description: "Present a completed plan for review.",
        parameters: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
      { name: "read", description: "read", parameters: {} },
    ])
    expect(tools?.map(tool => tool.name)).toEqual(["exit_plan_mode", "read"])
    expect(tools?.[0]?.inputSchema).toMatchObject({ required: ["plan"] })

    const prompt = translateGenerateOptionsToPrompt({
      provider: "devin-opencode",
      model: "swe-1-6",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            id: "plan-1",
            name: "exit_plan_mode",
            arguments: JSON.stringify({ plan: "# Tiny plan\n\nEdit the scratch file." }),
          }],
          source: { kind: "model", provider: "devin-opencode", model: "swe-1-6" },
        },
        {
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: "plan-1",
            content: [{ type: "text", text: "Plan approved" }],
          }],
          source: { kind: "tool", callId: "plan-1" },
        },
      ],
    })

    expect(prompt[0]).toMatchObject({
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "plan-1",
        toolName: "exit_plan_mode",
        input: { plan: "# Tiny plan\n\nEdit the scratch file." },
      }],
    })
    expect(prompt[1]).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "plan-1", toolName: "exit_plan_mode" }],
    })
    expect(JSON.stringify(prompt)).toContain("Plan approved")
  })

  test("stored host ask_user_question replays as OpenCode question", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [{
        role: "assistant",
        content: [{
          type: "tool-call",
          id: "c1",
          name: "ask_user_question",
          arguments: JSON.stringify({
            questions: [{
              id: "q1",
              question: "Continue?",
              header: "Confirm",
              options: [{ label: "Yes" }],
              multi_select: true,
            }],
          }),
        }],
        source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
      }],
    })
    expect(prompt).toEqual([{
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "c1",
        toolName: "question",
        input: {
          questions: [{
            question: "Continue?",
            header: "Confirm",
            options: [{ label: "Yes", description: "" }],
            multiple: true,
          }],
        },
      }],
    }])
  })

  test("DSH tool-role ask_user_question JSON becomes OpenCode question prose", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            id: "c1",
            name: "ask_user_question",
            arguments: JSON.stringify({
              questions: [{
                id: "q1",
                question: "Which scratch label should I use?",
                header: "Label",
                options: [{ label: "alpha" }, { label: "beta" }],
              }],
            }),
          }],
          source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
        },
        {
          role: "tool",
          toolCallId: "c1",
          content: [{ type: "text", text: "{\"answers\":[{\"id\":\"q1\",\"selected\":[\"alpha\"]}]}" }],
          source: { kind: "tool", callId: "c1" },
        },
      ],
    })
    expect(prompt.find(m => m.role === "tool")).toEqual({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "c1",
        toolName: "question",
        output: {
          type: "text",
          value:
            'User has answered your questions: "Which scratch label should I use?"="alpha". You can now continue with the user\'s answers in mind.',
        },
      }],
    })
  })

  test("DSH ask_user_question JSON result becomes OpenCode question prose", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            id: "c1",
            name: "ask_user_question",
            arguments: JSON.stringify({
              questions: [{
                id: "q1",
                question: "Which approach should I use?",
                header: "Approach",
                options: [{ label: "Small" }, { label: "Broad" }],
              }],
            }),
          }],
          source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
        },
        {
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: "c1",
            content: [{ type: "text", text: "{\"answers\":[{\"id\":\"q1\",\"selected\":[\"Small\"]}]}" }],
          }],
          source: { kind: "tool", callId: "c1" },
        },
      ],
    })
    const toolMsg = prompt.find(m => m.role === "tool")
    expect(toolMsg).toEqual({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "c1",
        toolName: "question",
        output: {
          type: "text",
          value:
            'User has answered your questions: "Which approach should I use?"="Small". You can now continue with the user\'s answers in mind.',
        },
      }],
    })
  })

  test("stored host file_path replays as OpenCode filePath", () => {
    const prompt = translateGenerateOptionsToPrompt({
      provider: "cursor-opencode",
      model: "composer-2",
      messages: [{
        role: "assistant",
        content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{\"file_path\":\"/tmp/a.ts\",\"offset\":2}" }],
        source: { kind: "model", provider: "cursor-opencode", model: "composer-2" },
      }],
    })
    expect(prompt).toEqual([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/tmp/a.ts", offset: 2 } }],
    }])
  })
})

describe("dsh-bridge stream translation", () => {
  test("tool-input then tool-call closes the block once with the name", async () => {
    const chunks = await collectV3ToDsh(parts([
      { type: "tool-input-start", id: "c1", toolName: "bash" } as never,
      { type: "tool-input-delta", id: "c1", delta: "{\"a\":1}" } as never,
      { type: "tool-input-end", id: "c1" } as never,
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { a: 1 } } as never,
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2 } } as never,
    ]))
    const ends = chunks.filter(c => c.type === "block-end")
    expect(ends).toHaveLength(1)
    expect(ends[0]?.type).toBe("block-end")
    if (ends[0]?.type !== "block-end") return
    expect(JSON.parse(String(ends[0].block.arguments))).toEqual({
      a: 1,
      description: "Run shell command",
    })
    const types = chunks.map(c => c.type)
    expect(types.at(-2)).toBe("usage")
    expect(types.at(-1)).toBe("finish")
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "tool-calls" } })
  })

  test("Cursor occupancy-only finishes emit zero usage without adding a full prefix", async () => {
    // DSH token-meter sums every step's sample; one held provider Run serves
    // many steps with a single billed aggregate. Intermediate occupancy
    // snapshots must not each contribute a full prefix.
    const chunks = await collectV3ToDsh(parts([
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: { total: 100000, noCache: 5000, cacheRead: 95000, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        providerMetadata: { cursor: { occupancyOnly: true } },
      } as never,
    ]), undefined, { finishUsage: cursorFinishUsage })
    const usage = chunks.find(c => c.type === "usage")
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })
  })

  test("terminal stop finish reads exact Cursor totals from metadata", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: { total: 54128, noCache: 54128, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        providerMetadata: {
          cursor: {
            inputTokensRaw: 324922,
            outputTokensRaw: 3581,
            cacheReadRaw: 266112,
            reasoningTokensRaw: 2355,
          },
        },
      } as never,
    ]), undefined, { finishUsage: cursorFinishUsage })
    const usage = chunks.find(c => c.type === "usage")
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 58810, outputTokens: 3581, totalTokens: 328503, cacheReadTokens: 266112, cacheWriteTokens: 0, reasoningTokens: 2355 },
    })
  })

  test.each(["stop", "tool-calls"])("generic %s finishes retain disjoint cache buckets and exact totals", async reason => {
    const chunks = await collectV3ToDsh(parts([{
      type: "finish",
      finishReason: { unified: reason },
      usage: {
        inputTokens: { total: 100, noCache: 20, cacheRead: 70, cacheWrite: 10 },
        outputTokens: { total: 15, text: 10, reasoning: 5 },
      },
    }]))
    expect(chunks.find(chunk => chunk.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 115, cacheReadTokens: 70, cacheWriteTokens: 10, reasoningTokens: 5 },
    })
  })

  test("DSH derives uncached input and totals when only V3 aggregate/cache counts are supplied", async () => {
    const chunks = await collectV3ToDsh(parts([{
      type: "finish", finishReason: { unified: "stop" },
      usage: { inputTokens: { total: 100, cacheRead: 70, cacheWrite: 10 }, outputTokens: { text: 10, reasoning: 5 } },
    }]))
    expect(chunks.find(chunk => chunk.type === "usage")).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 115, cacheReadTokens: 70, cacheWriteTokens: 10 },
    })
  })

  test("DSH omits exact totals when V3 aggregate input or output is unavailable", async () => {
    for (const usage of [
      { inputTokens: { noCache: 20, cacheRead: 70 }, outputTokens: { total: 15 } },
      { inputTokens: { total: 100 }, outputTokens: { text: 10 } },
      { inputTokens: {}, outputTokens: {} },
    ]) {
      const chunks = await collectV3ToDsh(parts([{
        type: "finish", finishReason: { unified: "stop" }, usage,
      }]))
      const sample = chunks.find(chunk => chunk.type === "usage")
      expect(sample?.type).toBe("usage")
      if (sample?.type === "usage") expect(sample.usage.totalTokens).toBeUndefined()
    }
  })

  test("DSH derives exact totals from a complete V3 component partition", async () => {
    const chunks = await collectV3ToDsh(parts([{
      type: "finish", finishReason: { unified: "stop" },
      usage: { inputTokens: { noCache: 20, cacheRead: 70, cacheWrite: 10 }, outputTokens: { text: 10, reasoning: 5 } },
    }]))
    expect(chunks.find(chunk => chunk.type === "usage")).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 115 },
    })
  })

  test("generic providers do not reinterpret a cursor metadata key", async () => {
    const chunks = await collectV3ToDsh(parts([{
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      },
      providerMetadata: { cursor: { inputTokensRaw: 999 } },
    } as never]))
    expect(chunks.find(chunk => chunk.type === "usage")).toMatchObject({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 3 },
    })
  })

  test("read path and filePath become host file_path on block-end", async () => {
    const byPath = await collectV3ToDsh(parts([
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "/tmp/a.ts", offset: 3 } } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const readEnd = byPath.find(c => c.type === "block-end")
    expect(readEnd?.type).toBe("block-end")
    if (readEnd?.type !== "block-end") return
    expect(readEnd.block).toMatchObject({ type: "tool-call", name: "read" })
    expect(JSON.parse(String(readEnd.block.arguments))).toEqual({ file_path: "/tmp/a.ts", offset: 3 })

    const byFilePath = await collectV3ToDsh(parts([
      { type: "tool-input-start", id: "c2", toolName: "edit" } as never,
      { type: "tool-input-delta", id: "c2", delta: "{\"filePath\":\"/tmp/a.ts\",\"oldString\":\"a\",\"newString\":\"b\"}" } as never,
      { type: "tool-input-end", id: "c2" } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const editEnd = byFilePath.find(c => c.type === "block-end")
    expect(editEnd?.type).toBe("block-end")
    if (editEnd?.type !== "block-end") return
    expect(editEnd.block).toMatchObject({ type: "tool-call", name: "edit" })
    expect(JSON.parse(String(editEnd.block.arguments))).toEqual({
      file_path: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
    })
  })

  test("glob search-root path is not folded into file_path", async () => {
    const chunks = await collectV3ToDsh(parts([
      { type: "tool-call", toolCallId: "g1", toolName: "glob", input: { path: "/src", pattern: "*.ts" } } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const globEnd = chunks.find(c => c.type === "block-end")
    expect(globEnd?.type).toBe("block-end")
    if (globEnd?.type !== "block-end") return
    expect(JSON.parse(String(globEnd.block.arguments))).toEqual({ path: "/src", pattern: "*.ts" })
  })

  test("bash fills missing description and keeps a provided one", async () => {
    const filled = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "LOG=/tmp/x; test -s \"$LOG\"", timeoutMs: 30000 },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const filledEnd = filled.find(c => c.type === "block-end")
    expect(filledEnd?.type).toBe("block-end")
    if (filledEnd?.type !== "block-end") return
    expect(JSON.parse(String(filledEnd.block.arguments))).toEqual({
      command: "LOG=/tmp/x; test -s \"$LOG\"",
      timeoutMs: 30000,
      description: "Run: LOG=/tmp/x; test -s \"$LOG\"",
    })

    const kept = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "b2",
        toolName: "bash",
        input: { command: "pwd", description: "Print working directory" },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const keptEnd = kept.find(c => c.type === "block-end")
    expect(keptEnd?.type).toBe("block-end")
    if (keptEnd?.type !== "block-end") return
    expect(JSON.parse(String(keptEnd.block.arguments))).toEqual({
      command: "pwd",
      description: "Print working directory",
    })
  })

  test("question becomes ask_user_question with synthesized id and multi_select", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "q1",
        toolName: "question",
        input: {
          questions: [{
            question: "Build Agent?",
            header: "Build Agent",
            options: [
              { label: "Yes", description: "Implement" },
              { label: "No", description: "Stay" },
            ],
            multiple: false,
          }],
        },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const end = chunks.find(c => c.type === "block-end")
    expect(end?.type).toBe("block-end")
    if (end?.type !== "block-end") return
    expect(end.block).toMatchObject({ type: "tool-call", name: "ask_user_question" })
    expect(JSON.parse(String(end.block.arguments))).toEqual({
      questions: [{
        question: "Build Agent?",
        header: "Build Agent",
        options: [
          { label: "Yes", description: "Implement" },
          { label: "No", description: "Stay" },
        ],
        multi_select: false,
        id: "q1",
      }],
    })
  })

  test("question drops the provider multiple alias when host multi_select is already present", () => {
    expect(rewriteProviderToolCall("question", {
      questions: [{
        question: "Pick",
        header: "Pick",
        options: [],
        multiple: false,
        multi_select: true,
      }],
    })).toEqual({
      name: "ask_user_question",
      input: {
        questions: [{
          id: "q1",
          question: "Pick",
          header: "Pick",
          options: [],
          multi_select: true,
        }],
      },
    })
  })

  test("question wording never changes the selected host tool", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "q1",
        toolName: "question",
        input: {
          questions: [{
            question: "Should we proceed with this proposal?",
            header: "Review",
            options: [
              { label: "Yes", description: "Implement" },
              { label: "No", description: "Stay" },
            ],
            detail: "# Held Plan",
          }],
        },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const end = chunks.find(c => c.type === "block-end")
    expect(end?.type).toBe("block-end")
    if (end?.type !== "block-end") return
    expect(end.block).toMatchObject({ type: "tool-call", name: "ask_user_question" })
  })

  test("native exit_plan_mode passes through with its plan unchanged", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "p1",
        toolName: "exit_plan_mode",
        input: { plan: "# Held Plan\n\nImplement it." },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const end = chunks.find(chunk => chunk.type === "block-end")
    expect(end?.type).toBe("block-end")
    if (end?.type !== "block-end") return
    expect(end.block).toMatchObject({ type: "tool-call", name: "exit_plan_mode" })
    expect(JSON.parse(String(end.block.arguments))).toEqual({
      plan: "# Held Plan\n\nImplement it.",
    })
  })

  test("rejects a tool call outside the provider-specific catalog", async () => {
    await expect(collectV3ToDsh(parts([{
      type: "tool-call",
      toolCallId: "foreign-1",
      toolName: "exit_plan_mode",
      input: { plan: "# Foreign" },
    } as never]), undefined, {
      allowedProviderToolNames: new Set(["read"]),
    })).rejects.toThrow('Provider emitted unadvertised tool call "exit_plan_mode"')
  })

  test("canonical subagent waits for the DSH child unless background is requested", async () => {
    const call = async (input: Record<string, unknown>) => {
      const chunks = await collectV3ToDsh(parts([
        { type: "tool-call", toolCallId: "t1", toolName: "subagent", input } as never,
        { type: "finish", finishReason: "tool-calls" } as never,
      ]))
      const end = chunks.find(c => c.type === "block-end")
      if (end?.type !== "block-end") throw new Error("no block-end")
      expect(end.block).toMatchObject({ type: "tool-call", name: "subagent" })
      return JSON.parse(String(end.block.arguments))
    }
    // Shape the provider emits for a Cursor Task (agent + optional sessionID).
    expect(await call({ agent: "explore", description: "Read hello", prompt: "Read hello.txt", sessionID: "child-1" }))
      .toEqual({ description: "Read hello", prompt: "Read hello.txt", run_in_background: false })
    expect(await call({ agent: "general", description: "Scan", prompt: "Scan repo", background: true }))
      .toEqual({ description: "Scan", prompt: "Scan repo", run_in_background: true })
  })

  test("todowrite becomes todo_write", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "todowrite",
        input: { todos: [{ content: "ocp-sv-a", status: "in_progress" }] },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const end = chunks.find(c => c.type === "block-end")
    expect(end?.type).toBe("block-end")
    if (end?.type !== "block-end") return
    expect(end.block).toMatchObject({ type: "tool-call", name: "todo_write" })
    expect(JSON.parse(String(end.block.arguments))).toEqual({
      todos: [{ content: "ocp-sv-a", status: "in_progress" }],
    })
  })

  test("todowrite strips Cursor id/priority/merge and omits cancelled", async () => {
    const chunks = await collectV3ToDsh(parts([
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "todowrite",
        input: {
          merge: true,
          todos: [
            { id: "1", content: "ocp-sv-a", status: "in_progress", priority: "high" },
            { id: "2", content: "ocp-sv-b", status: "pending", priority: "low" },
            { id: "3", content: "ocp-sv-c", status: "cancelled", priority: "medium" },
          ],
        },
      } as never,
      { type: "finish", finishReason: "tool-calls" } as never,
    ]))
    const end = chunks.find(c => c.type === "block-end")
    expect(end?.type).toBe("block-end")
    if (end?.type !== "block-end") return
    expect(JSON.parse(String(end.block.arguments))).toEqual({
      todos: [
        { content: "ocp-sv-a", status: "in_progress" },
        { content: "ocp-sv-b", status: "pending" },
      ],
    })
  })
})
