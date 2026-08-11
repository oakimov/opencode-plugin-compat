/**
 * Lazily import the detected host's `pi-ai` runtime values.
 *
 * Both hosts export what we need from their package **root**, so there is one
 * import per process and no subpath guessing:
 *   • omp — root re-exports `./utils/event-stream` and `./utils/schema` (which
 *     re-exports `./wire`), so both values are present.
 *   • pi  — root exports `createAssistantMessageEventStream`; it has no
 *     `toolWireSchema` because its `Tool.parameters` is a TypeBox `TSchema`,
 *     which is already a JSON Schema object at runtime.
 *
 * The import is dynamic and deferred: `@oh-my-pi/pi-ai` / `@earendil-works/pi-ai`
 * are optional peers that only exist inside a real host, so nothing here may be
 * imported at module load time.
 */
import { detectPiHost } from "./detect.js"
import type { PiHostProfile } from "./profile.js"

/** Structural stand-in for the host's `AssistantMessageEventStream`. */
export type PiEventStreamLike = {
  push(event: unknown): void
  end(result?: unknown): void
  fail(err: unknown): void
  result(): Promise<unknown>
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

export type ToolSchemaFn = (tool: { name: string; description: string; parameters: unknown }) => Record<string, unknown>

export type PiRuntime = {
  profile: PiHostProfile
  createAssistantMessageEventStream: () => PiEventStreamLike
  /** Resolve a host `Tool`'s parameters to a JSON Schema object. */
  toolSchema: ToolSchemaFn
}

/**
 * Portable fallback for hosts without a `toolWireSchema` helper (pi).
 * Handles, in order: an explicit converter method (ArkType / zod v4 style),
 * then a schema object used as-is (TypeBox emits plain JSON Schema).
 */
function fallbackToolSchema(tool: { parameters: unknown }): Record<string, unknown> {
  const params = tool.parameters
  if (params && typeof (params as { toJsonSchema?: unknown }).toJsonSchema === "function") {
    return (params as { toJsonSchema: () => Record<string, unknown> }).toJsonSchema()
  }
  if (params && typeof params === "object") return params as Record<string, unknown>
  return { type: "object", properties: {} }
}

let cached: Promise<PiRuntime> | undefined

export function loadPiRuntime(options: { fresh?: boolean } = {}): Promise<PiRuntime> {
  if (cached && !options.fresh) return cached
  const runtime = (async (): Promise<PiRuntime> => {
    const { profile } = await detectPiHost()
    const mod = (await import(profile.aiPackage)) as Record<string, unknown>

    const createStream = mod.createAssistantMessageEventStream
    if (typeof createStream !== "function") {
      throw new Error(`pi-bridge: ${profile.aiPackage} does not export createAssistantMessageEventStream — unsupported host version`)
    }

    const hostToolSchema = mod.toolWireSchema
    const toolSchema: ToolSchemaFn =
      typeof hostToolSchema === "function" ? (hostToolSchema as ToolSchemaFn) : fallbackToolSchema

    return {
      profile,
      createAssistantMessageEventStream: createStream as () => PiEventStreamLike,
      toolSchema,
    }
  })()
  if (!options.fresh) cached = runtime
  return runtime
}

/** Test seam: drop the per-process runtime cache. */
export function resetPiRuntime(): void {
  cached = undefined
}

export { fallbackToolSchema }
