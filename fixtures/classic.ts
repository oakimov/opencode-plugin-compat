import type { Hooks, PluginInput } from "@opencode-compat/facade-plugin"
import { fail, pass, skip, type Fixture } from "./types.ts"

function fakeInput(): PluginInput {
  return {
    client: {},
    project: {
      id: "proj",
      worktree: "/tmp/proj",
      time: { created: 0 },
    },
    directory: "/tmp/proj",
    worktree: "/tmp/proj",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: Object.assign(() => ({}), {}) as PluginInput["$"],
  }
}

export const classicAuthOauthShape: Fixture = {
  id: "classic.auth.oauth-shape",
  tier: "T1",
  description: "Auth hook types load; authorize path smoke",
  async run(ctx) {
    if (!ctx.profile.capabilities.classicHooks) {
      return skip(this, ctx.host, "host lacks classicHooks")
    }
    const plugin = async (): Promise<Hooks> => ({
      auth: {
        provider: "ocp-fixture",
        methods: [
          {
            type: "oauth",
            label: "OAuth",
            async authorize() {
              return {
                url: "https://example.test/oauth",
                instructions: "open url",
                method: "auto" as const,
                async callback() {
                  return {
                    type: "success" as const,
                    refresh: "r",
                    access: "a",
                    expires: Date.now() + 60_000,
                  }
                },
              }
            },
          },
        ],
      },
    })
    const hooks = await plugin(fakeInput())
    const method = hooks.auth?.methods[0]
    if (!method || method.type !== "oauth") {
      return fail(this, ctx.host, "oauth method missing")
    }
    const result = await method.authorize()
    if (result.method !== "auto" || !result.url.includes("oauth")) {
      return fail(this, ctx.host, "authorize shape invalid", JSON.stringify(result))
    }
    const cb = await result.callback()
    if (cb.type !== "success" || !("access" in cb)) {
      return fail(this, ctx.host, "oauth callback failed", JSON.stringify(cb))
    }
    return pass(this, ctx.host, "oauth authorize + callback ok")
  },
}

export const classicConfigMutate: Fixture = {
  id: "classic.config-mutate",
  tier: "T1",
  description: "config hook runs and may mutate input",
  async run(ctx) {
    if (!ctx.profile.capabilities.classicHooks) {
      return skip(this, ctx.host, "host lacks classicHooks")
    }
    const plugin = async (): Promise<Hooks> => ({
      async config(input) {
        ;(input as { fixtureFlag?: boolean }).fixtureFlag = true
      },
    })
    const hooks = await plugin(fakeInput())
    const config: Record<string, unknown> = { model: "demo" }
    await hooks.config?.(config as never)
    if (config.fixtureFlag !== true) {
      return fail(this, ctx.host, "config hook did not mutate")
    }
    return pass(this, ctx.host, "config hook mutated input")
  },
}

export const classicToolBeforeAfter: Fixture = {
  id: "classic.tool-before-after",
  tier: "T1",
  description: "tool.execute.before / after hooks run",
  async run(ctx) {
    if (!ctx.profile.capabilities.classicHooks) {
      return skip(this, ctx.host, "host lacks classicHooks")
    }
    const seen: string[] = []
    const plugin = async (): Promise<Hooks> => ({
      async "tool.execute.before"(_input, output) {
        seen.push("before")
        output.args = { ...(output.args as object), tagged: true }
      },
      async "tool.execute.after"() {
        seen.push("after")
      },
    })
    const hooks = await plugin(fakeInput())
    const argsOut: { args: Record<string, unknown> } = { args: { x: 1 } }
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "s", callID: "c" },
      argsOut,
    )
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "s", callID: "c", args: argsOut.args },
      { title: "t", output: "o", metadata: {} },
    )
    if (seen.join(",") !== "before,after" || argsOut.args.tagged !== true) {
      return fail(this, ctx.host, "tool hooks incomplete", JSON.stringify({ seen, argsOut }))
    }
    return pass(this, ctx.host, "tool before/after ok")
  },
}

export const classicChatParams: Fixture = {
  id: "classic.chat-params",
  tier: "T1",
  description: "chat.params mutates options",
  async run(ctx) {
    if (!ctx.profile.capabilities.classicHooks) {
      return skip(this, ctx.host, "host lacks classicHooks")
    }
    const plugin = async (): Promise<Hooks> => ({
      async "chat.params"(_input, output) {
        output.options = { ...output.options, fixture: true }
        output.temperature = 0.2
      },
    })
    const hooks = await plugin(fakeInput())
    const output = {
      temperature: 1,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined as number | undefined,
      options: {} as Record<string, unknown>,
    }
    await hooks["chat.params"]?.(
      {
        sessionID: "s",
        agent: "build",
        model: { id: "m", providerID: "p", name: "m" },
        provider: {
          source: "config",
          info: {
            id: "p",
            name: "p",
            source: "config",
            env: [],
            options: {},
            models: {},
          },
          options: {},
        },
        message: {
          id: "msg",
          sessionID: "s",
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        },
      },
      output,
    )
    if (output.options.fixture !== true || output.temperature !== 0.2) {
      return fail(this, ctx.host, "chat.params did not mutate", JSON.stringify(output))
    }
    return pass(this, ctx.host, "chat.params mutated options")
  },
}