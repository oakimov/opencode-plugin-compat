/** Cursor's large tool-catalog spill uses the host cache, outside DSH's workspace sandbox. */
import path from "node:path"
import type { DshGenerateOptions } from "./translate/context.js"
import { translateProviderToolCallInput, type DshToolInputVocabulary } from "./translate/tools.js"

const PATH_BRIDGE_KEY = Symbol.for("opencode.host.path-bridge")
const AGENT_TOOL_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/i

function hostCacheRoot(): string | undefined {
  const bridge = (globalThis as unknown as Record<symbol, unknown>)[PATH_BRIDGE_KEY] as
    | { globalCacheDir?: () => unknown }
    | undefined
  const root = bridge?.globalCacheDir?.()
  return typeof root === "string" && path.isAbsolute(root) ? root : undefined
}

export function isCursorAgentToolSpillPath(filePath: unknown, cacheRoot: string): boolean {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return false
  const parts = path.relative(path.resolve(cacheRoot), path.resolve(filePath)).split(path.sep)
  return parts.length === 4
    && parts[0] === "projects"
    && !!parts[1] && parts[1] !== "." && parts[1] !== ".."
    && parts[2] === "agent-tools"
    && AGENT_TOOL_FILE.test(parts[3] ?? "")
}

/** Keep DSH's native write tool and permission gate; ask only for Cursor's cache spill. */
export function cursorMetadataWriteToolInputs(
  options: DshGenerateOptions,
  base: DshToolInputVocabulary,
  cacheRoot = hostCacheRoot(),
): DshToolInputVocabulary {
  const write = options.tools?.find(tool => tool.name === "write")
  const properties = write?.parameters?.properties as Record<string, unknown> | undefined
  const escalation = properties?.sandbox_permissions as { enum?: unknown } | undefined
  if (!cacheRoot || !Array.isArray(escalation?.enum) || !escalation.enum.includes("danger-full-access")) return base
  const profile = base.write
  if (!profile) return base
  return {
    ...base,
    write: {
      ...profile,
      toHostInput: input => {
        const translated = translateProviderToolCallInput("write", input, base)
        if (translated.sandbox_permissions !== undefined
          || !isCursorAgentToolSpillPath(translated.file_path, cacheRoot)) return translated
        return {
          ...translated,
          sandbox_permissions: "danger-full-access",
          justification: "Save Cursor's generated tool catalog in the host cache outside this workspace.",
        }
      },
    },
  }
}
