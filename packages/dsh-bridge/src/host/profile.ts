/**
 * DSH host profile — single host, variance as data.
 * Mirrors `packages/pi-bridge/src/host/profile.ts` (PiHostProfile) but for DeepSeek Harness.
 * One profile, one package, no per-host fork.
 */

export type DshHostId = "dsh"

export type DshToolInputProfile = {
  /** Provider-emitted argument name → host argument name. */
  inputAliases: Readonly<Record<string, string>>
  /** Host argument name → advertised OpenCode name (catalog + history replay). */
  providerKeys: Readonly<Record<string, string>>
  /**
   * Host `required` fields that OpenCode does not collect. Dropped from the
   * advertised schema; filled on the host call when missing.
   */
  dropRequired?: readonly string[]
  /** Provider-facing tool name when the host uses a different name. */
  providerName?: string
  /** Optional structural adaptation for contracts that are not key renames. */
  toHostInput?: (input: Record<string, unknown>) => Record<string, unknown>
  toProviderInput?: (input: Record<string, unknown>) => Record<string, unknown>
  providerSchema?: Record<string, unknown>
  providerDescription?: string
}

export type DshHostProfile = {
  id: DshHostId
  name: string
  /** Cordis plugin package providing the LLM service. */
  llmPackage: string
  /** Credential scope for OAuth grants stored via ctx.credentials. */
  credentialScope: string
  /** Provider ids DSH already ships (collision guard). */
  reservedProviderIds: readonly string[]
  /** Wire ids DSH reserves for built-in APIs. */
  reservedApis: readonly string[]
  tools?: {
    /**
     * OpenCode plugins emit `filePath` / `path` / `oldString`. DSH validates
     * `file_path` / `old_string` (`packages/fs/tool-fs/src/{read,write,edit}.ts`,
     * `read-image.ts`). Without this map the model call arrives missing the
     * host key and DSH rejects `missing required property "file_path"`.
     */
    inputs?: Readonly<Record<string, DshToolInputProfile>>
  }
  /**
   * Host tool → argument names that must name an existing path before a
   * bridged model's call runs (`missing-path.ts`). File creation targets
   * (`write`) are absent: they may not exist yet.
   */
  existingPaths?: Readonly<Record<string, readonly string[]>>
  /** Whether host file tools expand a leading `~` (`packages/fs/tool-fs/src/session-cwd.ts`). */
  fileToolsExpandTilde: boolean
}

/**
 * Advertise OpenCode 1.x `filePath` (DSH ships `bash`, not OpenCode 2 `shell`).
 * Accept both `filePath` and `path` on the way back — OpenCode 2.0 file tools
 * use `path`.
 *
 * glob/grep already use OpenCode `pattern` + search-root `path`; do not fold
 * those `path` fields into `file_path`.
 */
const DSH_ESSENTIAL_TOOL_INPUTS: Readonly<Record<string, DshToolInputProfile>> = {
  read: {
    inputAliases: { filePath: "file_path", path: "file_path" },
    providerKeys: { file_path: "filePath" },
  },
  write: {
    inputAliases: {
      filePath: "file_path",
      path: "file_path",
      contents: "content",
      file_text: "content",
      fileText: "content",
    },
    providerKeys: { file_path: "filePath" },
  },
  edit: {
    inputAliases: {
      filePath: "file_path",
      path: "file_path",
      oldString: "old_string",
      newString: "new_string",
      replaceAll: "replace_all",
    },
    providerKeys: {
      file_path: "filePath",
      old_string: "oldString",
      new_string: "newString",
      replace_all: "replaceAll",
    },
  },
  read_image: {
    inputAliases: { filePath: "file_path", path: "file_path" },
    providerKeys: { file_path: "filePath" },
  },
  bash: {
    inputAliases: { working_directory: "workdir", timeout: "timeoutMs" },
    providerKeys: { timeoutMs: "timeout" },
    // DSH requires description (`packages/shell/tool-bash/src/index.ts:246`).
    // OpenCode/Cursor bash is `{command, workdir?, timeout?}` — fill on ingress.
    dropRequired: ["description"],
  },
  glob: {
    inputAliases: { glob_pattern: "pattern", globPattern: "pattern" },
    providerKeys: {},
  },
  // Cursor/OpenCode `todowrite`. Display `update_todos_tool_call` prefers that
  // name and skips the host call when only `todo_write` is advertised.
  // Ingress strips id/priority/merge — DSH items are `{content,status}` with
  // additionalProperties: false (`packages/todo/tool-todo/src/index.ts:154`).
  todo_write: {
    inputAliases: {},
    providerKeys: {},
    providerName: "todowrite",
  },
  // Cursor AskQuestion and OpenCode-compatible question calls look for
  // `question`. Host tool is
  // `ask_user_question` (`packages/interaction/tool-ask-user/src/index.ts:21`)
  // with required nested `id` and `multi_select` instead of `multiple`.
  ask_user_question: {
    inputAliases: {},
    providerKeys: {},
    providerName: "question",
  },
  // OpenCode `subagent`/`task` waits for the child unless `background: true`
  // (`packages/opencode/src/tool/task.ts`), as Cursor Task does. DSH defaults
  // the other way (`run_in_background ?? continuable`,
  // `packages/subagent/tool-subagent/src/index.ts:303`): the caller then gets
  // only "started subagent <id>" and Cursor delegates the same task again.
  // DSH has no agent choice or resume id on this tool (`send_message`
  // continues a child), so `agent` and `sessionID` are not host input.
  subagent: {
    inputAliases: {},
    providerKeys: {},
    providerDescription: "Delegate a self-contained task to a subagent, a separate agent with its own context. "
      + "Waits for the subagent and returns its result. Set background to true only for independent work "
      + "you do not need before your next action; you are then notified when it settles.",
    providerSchema: {
      type: "object",
      properties: {
        background: {
          type: "boolean",
          description: "Defaults to false. True starts the subagent and returns at once.",
        },
        description: { type: "string", description: "A short (3-5 word) description of the delegated task, for display." },
        prompt: {
          type: "string",
          description: "The complete, self-contained task. The subagent does not share this conversation's context.",
        },
      },
      required: ["description", "prompt"],
    },
    toHostInput: ({ agent: _agent, sessionID: _sessionID, background, ...input }) => ({
      ...input,
      run_in_background: background === true,
    }),
    toProviderInput: ({ run_in_background, ...input }) => ({
      ...input,
      ...(run_in_background === true ? { background: true } : {}),
    }),
  },
}

// Host argument names (after ingress aliasing): `packages/fs/tool-fs/src/{read,edit,read-image}.ts`,
// `packages/fs/tool-fs-search/src/{glob,grep}.ts`, `packages/shell/tool-bash/src/index.ts`.
const DSH_EXISTING_PATHS: Readonly<Record<string, readonly string[]>> = {
  read: ["file_path"],
  read_image: ["file_path"],
  edit: ["file_path"],
  glob: ["path"],
  grep: ["path"],
  bash: ["workdir"],
}

const DSH_RESERVED_PROVIDER_IDS = [
  "deepseek-official",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "ollama",
  "cursor",
  "github-copilot",
  "devin",
] as const

const DSH_RESERVED_APIS: readonly string[] = []

export function dshProfile(): DshHostProfile {
  return {
    id: "dsh",
    name: "DeepSeek Harness",
    llmPackage: "@deepseek-ai/dsh-llm",
    credentialScope: "dsh-bridge",
    reservedProviderIds: DSH_RESERVED_PROVIDER_IDS,
    reservedApis: DSH_RESERVED_APIS,
    tools: { inputs: DSH_ESSENTIAL_TOOL_INPUTS },
    existingPaths: DSH_EXISTING_PATHS,
    fileToolsExpandTilde: false,
  }
}

export function dshToolInputs(profile: DshHostProfile = dshProfile()): Readonly<Record<string, DshToolInputProfile>> {
  return profile.tools?.inputs ?? {}
}

export function avoidProviderIdCollision(providerId: string, profile: DshHostProfile, suffix = "-opencode"): string {
  return (profile.reservedProviderIds as readonly string[]).includes(providerId) ? `${providerId}${suffix}` : providerId
}
