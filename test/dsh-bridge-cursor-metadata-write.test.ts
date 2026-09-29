import { describe, expect, test } from "bun:test"
import { cursorMetadataWriteToolInputs, isCursorAgentToolSpillPath } from "../packages/dsh-bridge/src/cursor-metadata-write.ts"
import { cursorPlanToolInputs } from "../packages/dsh-bridge/src/cursor-plan-tools.ts"
import { rewriteProviderToolCall } from "../packages/dsh-bridge/src/translate/tools.ts"
import type { DshGenerateOptions } from "../packages/dsh-bridge/src/translate/context.ts"

const cacheRoot = "/Users/test/.cache/opencode"
const spill = `${cacheRoot}/projects/Users-test-project/agent-tools/01f08b05-86e5-4bec-bbdb-7eacd1489a97.txt`
const options: DshGenerateOptions = {
  provider: "cursor-opencode",
  model: "default",
  messages: [],
  tools: [{
    name: "write",
    description: "Write file",
    parameters: { type: "object", properties: {
      file_path: { type: "string" },
      content: { type: "string" },
      sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
    } },
  }],
}

describe("Cursor agent-tools spill on DSH", () => {
  test("recognizes only a metadata file under the host cache", () => {
    expect(isCursorAgentToolSpillPath(spill, cacheRoot)).toBe(true)
    expect(isCursorAgentToolSpillPath(`${cacheRoot}/projects/other/assets/a.txt`, cacheRoot)).toBe(false)
    expect(isCursorAgentToolSpillPath("/tmp/agent-tools/01f08b05-86e5-4bec-bbdb-7eacd1489a97.txt", cacheRoot)).toBe(false)
    expect(isCursorAgentToolSpillPath(`${cacheRoot}/projects/other/agent-tools/../../outside.txt`, cacheRoot)).toBe(false)
    expect(isCursorAgentToolSpillPath(`${cacheRoot}/projects/other/agent-tools/note.txt`, cacheRoot)).toBe(false)
  })

  test("uses DSH's advertised escalation for an automatic cache write", () => {
    const vocabulary = cursorMetadataWriteToolInputs(options, cursorPlanToolInputs, cacheRoot)
    expect(rewriteProviderToolCall("write", { filePath: spill, content: "catalog" }, { toolInputs: vocabulary })).toEqual({
      name: "write",
      input: {
        file_path: spill,
        content: "catalog",
        sandbox_permissions: "danger-full-access",
        justification: "Save Cursor's generated tool catalog in the host cache outside this workspace.",
      },
    })
    expect(rewriteProviderToolCall("write", { filePath: "/Users/test/project/a.txt", content: "x" }, { toolInputs: vocabulary }).input)
      .toEqual({ file_path: "/Users/test/project/a.txt", content: "x" })
  })

  test("preserves caller escalation and never invents unavailable schema fields", () => {
    const vocabulary = cursorMetadataWriteToolInputs(options, cursorPlanToolInputs, cacheRoot)
    expect(rewriteProviderToolCall("write", {
      filePath: spill, content: "catalog", sandbox_permissions: "workspace-write", justification: "User choice",
    }, { toolInputs: vocabulary }).input).toMatchObject({ sandbox_permissions: "workspace-write", justification: "User choice" })
    const withoutEscalation = cursorMetadataWriteToolInputs({ ...options, tools: [{ ...options.tools![0]!, parameters: {} }] }, cursorPlanToolInputs, cacheRoot)
    expect(withoutEscalation).toBe(cursorPlanToolInputs)
  })
})
