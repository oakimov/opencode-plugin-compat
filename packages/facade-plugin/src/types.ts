/**
 * Portable classic plugin types for OCP facades.
 * Structurally aligned with @opencode-ai/plugin@1.18.3 Hooks keys;
 * SDK entity shapes are intentionally loose so facades do not hard-depend
 * on a single fork’s generated client types.
 */
import type { Auth } from "@opencode-compat/facade-sdk"
import type { ToolDefinition } from "./tool"

/** Opaque host client — OpenCode `createOpencodeClient` / MiMo residual / Kilo `createKiloClient`. */
export type HostClient = {
  readonly [key: string]: unknown
}

export type Project = {
  id: string
  worktree: string
  vcsDir?: string
  vcs?: "git"
  time: {
    created: number
    initialized?: number
  }
}

export type Model = {
  id: string
  providerID: string
  name: string
  [key: string]: unknown
}

export type Provider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, Model>
  [key: string]: unknown
}

export type ProviderV2 = {
  id: string
  name?: string
  [key: string]: unknown
}

export type ModelV2 = {
  id: string
  providerID?: string
  [key: string]: unknown
}

export type Permission = {
  id: string
  type: string
  pattern?: string | string[]
  sessionID: string
  messageID: string
  callID?: string
  title: string
  metadata: Record<string, unknown>
  time: { created: number }
}

export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string }
  [key: string]: unknown
}

export type Message = UserMessage | { role: string; id: string; [key: string]: unknown }

export type Part = {
  id?: string
  type?: string
  [key: string]: unknown
}

export type Event = {
  type: string
  properties?: unknown
}

export type BunShell = {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown
  [key: string]: unknown
}

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, unknown>
}

export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export type WorkspaceTarget =
  | { type: "local"; directory: string }
  | {
      type: "remote"
      url: string | URL
      headers?: Record<string, string>
    }

export type WorkspaceAdapter = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(
    config: WorkspaceInfo,
    env: Record<string, string | undefined>,
    from?: WorkspaceInfo,
  ): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export type PluginInput = {
  client: HostClient
  project: Project
  directory: string
  worktree: string
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void
  }
  serverUrl: URL
  $: BunShell
}

export type PluginOptions = Record<string, unknown>

export type Config = {
  plugin?: Array<string | [string, PluginOptions]>
  [key: string]: unknown
}

export type Plugin = (
  input: PluginInput,
  options?: PluginOptions,
) => Promise<Hooks>

export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type AuthHook = {
  provider: string
  loader?: (
    auth: () => Promise<Auth>,
    provider: Provider,
  ) => Promise<Record<string, unknown>>
  methods: Array<
    | {
        type: "oauth"
        label: string
        prompts?: AuthPrompt[]
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: AuthPrompt[]
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
              metadata?: Record<string, string>
            }
          | { type: "failed" }
        >
      }
  >
}

export type AuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      validate?: (value: string) => string | undefined
      /** @deprecated Use `when` instead */
      condition?: (inputs: Record<string, string>) => boolean
      when?: Rule
    }
  | {
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      /** @deprecated Use `when` instead */
      condition?: (inputs: Record<string, string>) => boolean
      when?: Rule
    }

export type AuthOAuthResult = {
  url: string
  instructions: string
} & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | { type: "failed" }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | { type: "failed" }
      >
    }
)

/** @deprecated Use AuthOAuthResult instead. */
export type AuthOuathResult = AuthOAuthResult

export type ProviderHookContext = {
  auth?: Auth
}

export type ProviderHook = {
  id: string
  models?: (
    provider: ProviderV2,
    ctx: ProviderHookContext,
  ) => Promise<Record<string, ModelV2>>
}

/** OCP 0.1 portable classic Hooks (OpenCode ∩ Kilo core; MiMo gaps accepted). */
export interface Hooks {
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  auth?: AuthHook
  provider?: ProviderHook
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  "chat.params"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
    },
    output: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, unknown>
    },
  ) => Promise<void>
  "chat.headers"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
    },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (
    input: Permission,
    output: { status: "ask" | "deny" | "allow" },
  ) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: { messages: { info: Message; parts: Part[] }[] },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: { system: string[] },
  ) => Promise<void>
  "experimental.provider.small_model"?: (
    input: { provider: ProviderV2 },
    output: { model?: ModelV2 },
  ) => Promise<void>
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.compaction.autocontinue"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
      overflow: boolean
    },
    output: { enabled: boolean },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  "tool.definition"?: (
    input: { toolID: string },
    output: { description: string; parameters: unknown },
  ) => Promise<void>
}