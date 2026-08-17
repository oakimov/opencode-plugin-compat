/**
 * MCP resource tools pass through the generic Pi-family bridge unchanged.
 *
 * Cursor's agent protocol shares two tool names with OpenCode's MCP-resource
 * tools (`list_mcp_resources` / `read_mcp_resource`). `cursor-opencode-provider`
 * now settles Cursor's native fields 17/18 internally before the AI-SDK
 * `doStream` boundary, so pi-bridge only ever sees ordinary AI-SDK tool calls.
 * These tests pin the bridge side of that contract: no provider-specific code,
 * no name table — any tool a host actually advertises under those names (and
 * any ordinary MCP tool) is passed through with its name, arguments, call id,
 * and result content intact, on the catalog, call, and result path alike.
 *
 * If any of these regress, the bridge is renaming/dropping tools, not OCP.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { translateContextToPrompt, translateTools } from "../packages/pi-bridge/src/translate/context.ts"
import { runV3StreamToPi } from "../packages/pi-bridge/src/translate/stream.ts"
import { buildPiSubagentVocabulary } from "../packages/pi-bridge/src/translate/subagent.ts"

class FakeAssistantMessageEventStream {
  events: unknown[] = []
  push(event: unknown) {
    this.events.push(event)
  }
  end() {}
  fail() {}
  async result() {
    return (this.events.find((event) => (event as { type?: string }).type === "done") as { message: unknown } | undefined)?.message
  }
  async *[Symbol.asyncIterator]() {
    yield* this.events
  }
}

const MODEL = {
  id: "acme-large",
  name: "Acme Large",
  api: "acme-bridge",
  provider: "acme",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as never

async function* v3Parts(parts: unknown[]) {
  for (const p of parts) yield p
}

/** OMP-shaped catalog: a subagent `task` plus MCP resource + ordinary MCP tools. */
function resourceTools() {
  return [
    {
      name: "task",
      description: "Launch a specialized agent.",
      parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } } },
    },
    {
      name: "list_mcp_resources",
      description: "List MCP resources",
      parameters: { type: "object", properties: { server: { type: "string" } } },
    },
    {
      name: "read_mcp_resource",
      description: "Read an MCP resource",
      parameters: { type: "object", properties: { server: { type: "string" }, uri: { type: "string" } } },
    },
    {
      name: "everything_echo",
      description: "Echo",
      parameters: { type: "object", properties: {} },
    },
  ] as never[]
}

describe("MCP resource tool pass-through (fields 17/18 owned by the provider)", () => {
  test("catalog: list_mcp_resources / read_mcp_resource keep exact names, schemas, and descriptions", () => {
    const tools = translateTools(
      resourceTools(),
      tool => (tool as { parameters: unknown }).parameters as Record<string, unknown>,
      buildPiSubagentVocabulary(resourceTools(), tool => (tool as { parameters: unknown }).parameters as Record<string, unknown>, ompProfile()),
    )
    const names = (tools ?? []).map(tool => tool.name)
    expect(names).toEqual(["everything_echo", "list_mcp_resources", "read_mcp_resource", "task"])
    expect(tools?.[1]).toMatchObject({
      name: "list_mcp_resources",
      description: "List MCP resources",
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
    })
    expect(tools?.[2]).toMatchObject({
      name: "read_mcp_resource",
      description: "Read an MCP resource",
      inputSchema: { type: "object", properties: { server: { type: "string" }, uri: { type: "string" } } },
    })
  })

  test("call: { server, uri } arguments survive call translation under the exact tool names", async () => {
    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "call_list_1", toolName: "list_mcp_resources", input: '{"server":"everything"}' },
        { type: "tool-call", toolCallId: "call_read_1", toolName: "read_mcp_resource", input: '{"server":"everything","uri":"demo://resource/dynamic/text/1"}' },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })

    const endEvents = (piStream.events as Array<{ type: string; toolCall?: unknown }>).filter(e => e.type === "toolcall_end")
    expect(endEvents).toHaveLength(2)
    expect(endEvents[0]!.toolCall).toEqual({
      type: "toolCall",
      id: "call_list_1",
      name: "list_mcp_resources",
      arguments: { server: "everything" },
    })
    expect(endEvents[1]!.toolCall).toEqual({
      type: "toolCall",
      id: "call_read_1",
      name: "read_mcp_resource",
      arguments: { server: "everything", uri: "demo://resource/dynamic/text/1" },
    })
  })

  test("round trip: a read_mcp_resource call id survives into the next toolResult turn", async () => {
    const TOOL_CALL_ID = "cursor_pi-session_9"
    const turn1Stream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: TOOL_CALL_ID, toolName: "read_mcp_resource", input: '{"server":"everything","uri":"demo://resource/dynamic/text/1"}' },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: turn1Stream as never,
    })
    const assistantMessage = await turn1Stream.result()

    const context = {
      messages: [
        { role: "user", content: "read resource 1", timestamp: 1 },
        assistantMessage,
        {
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
          toolName: "read_mcp_resource",
          content: [{ type: "text", text: "Resource 1: hello" }],
          isError: false,
          timestamp: 2,
        },
      ],
    }

    const prompt = translateContextToPrompt(context as never)
    const toolCall = prompt[1]!
    expect(toolCall).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: TOOL_CALL_ID,
          toolName: "read_mcp_resource",
          input: { server: "everything", uri: "demo://resource/dynamic/text/1" },
        },
      ],
    })
    const toolMessage = prompt[2] as { role: string; content: Array<{ toolCallId: string; toolName: string; output: unknown }> }
    expect(toolMessage.role).toBe("tool")
    expect(toolMessage.content[0]!.toolCallId).toBe(TOOL_CALL_ID)
    expect(toolMessage.content[0]!.toolName).toBe("read_mcp_resource")
    expect(toolMessage.content[0]!.output).toEqual({ type: "text", value: "Resource 1: hello" })
  })

  test("result: text, error-text, and image/file content survive result translation", () => {
    const text = translateContextToPrompt({
      messages: [
        { role: "toolResult", toolCallId: "c1", toolName: "read_mcp_resource", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
      ],
    } as never)
    expect((text[0] as { content: Array<{ output: unknown }> }).content[0]!.output).toEqual({ type: "text", value: "ok" })

    const error = translateContextToPrompt({
      messages: [
        { role: "toolResult", toolCallId: "c1", toolName: "read_mcp_resource", content: [{ type: "text", text: 'Server "x" not found' }], isError: true, timestamp: 2 },
      ],
    } as never)
    expect((error[0] as { content: Array<{ output: unknown }> }).content[0]!.output).toEqual({
      type: "error-text",
      value: 'Server "x" not found',
    })

    const image = translateContextToPrompt({
      messages: [
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read_mcp_resource",
          content: [
            { type: "text", text: "[Image attached]" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    } as never)
    expect((image[0] as { content: Array<{ output: unknown }> }).content[0]!.output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "[Image attached]" },
        { type: "file-data", data: "iVBORw0KGgo=", mediaType: "image/png" },
      ],
    })
  })

  test("ordinary MCP tools remain unaffected on the same paths", async () => {
    const tools = translateTools(resourceTools().slice(3, 4), tool => (tool as { parameters: unknown }).parameters as Record<string, unknown>)
    expect(tools?.[0]).toMatchObject({ name: "everything_echo", description: "Echo" })

    const piStream = new FakeAssistantMessageEventStream()
    await runV3StreamToPi({
      model: MODEL,
      v3Stream: v3Parts([
        { type: "tool-call", toolCallId: "call_1", toolName: "everything_echo", input: '{"message":"hi"}' },
        { type: "finish", usage: { inputTokens: {}, outputTokens: {} }, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
      ]) as never,
      piStream: piStream as never,
    })
    const endEvents = (piStream.events as Array<{ type: string; toolCall?: { name: string; arguments: unknown; id: string } }>).filter(e => e.type === "toolcall_end")
    expect(endEvents[0]!.toolCall).toMatchObject({
      id: "call_1",
      name: "everything_echo",
      arguments: { message: "hi" },
    })

    const prompt = translateContextToPrompt({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "everything_echo",
          content: [{ type: "text", text: "echoed" }],
          isError: false,
          timestamp: 2,
        },
      ],
    } as never)
    expect((prompt[0] as { content: Array<{ toolCallId: string; toolName: string; output: unknown }> }).content[0]).toMatchObject({
      toolCallId: "call_1",
      toolName: "everything_echo",
      output: { type: "text", value: "echoed" },
    })
  })
})