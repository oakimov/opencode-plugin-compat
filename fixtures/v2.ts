import {
  createPluginContext,
  define,
  injectLanguageModel,
  runPromisePlugin,
  type LanguageModelV3Like,
} from "@opencode-compat/host-promise-v2"
import { fail, pass, skip, type Fixture } from "./types.ts"

export const v2AisdkLanguage: Fixture = {
  id: "v2.aisdk.language",
  tier: "T3",
  description: "LanguageModelV3 injection via ctx.aisdk language hook",
  async run(ctx) {
    if (!ctx.profile.capabilities.promiseV2) {
      return skip(
        this,
        ctx.host,
        "promiseV2=false — embed host-promise-v2 (M1) to claim T3",
      )
    }
    const plugin = define({
      async setup(pluginCtx) {
        pluginCtx.aisdk.on("language", async (_input, output) => {
          const model: LanguageModelV3Like = {
            specificationVersion: "v3",
            provider: "ocp-fixture",
            modelId: "fixture-1",
          }
          output.language = model
        })
      },
    })
    const { ctx: pluginCtx } = await runPromisePlugin(plugin, {
      plugin: { id: "v2.aisdk.language" },
    })
    const out = await injectLanguageModel(pluginCtx, {
      providerID: "ocp-fixture",
      modelID: "fixture-1",
    })
    const language = out.language as LanguageModelV3Like | undefined
    if (
      !language ||
      language.specificationVersion !== "v3" ||
      language.modelId !== "fixture-1"
    ) {
      return fail(this, ctx.host, "language injection failed", JSON.stringify(out))
    }
    return pass(this, ctx.host, "aisdk language injection ok")
  },
}

export const v2UnsupportedDomain: Fixture = {
  id: "v2.unsupported-domain",
  tier: "T3",
  description: "unsupported Promise domain throws loud error",
  async run(ctx) {
    // Loud stubs ship with the host kit regardless of host promiseV2 flag —
    // when promiseV2 is false, still verify the kit's stub behavior in-process.
    const pluginCtx = createPluginContext({}, { id: "loud" })
    try {
      pluginCtx.catalog.register("x")
      return fail(this, ctx.host, "expected catalog.register to throw")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes("catalog") || !message.includes("not implemented")) {
        return fail(this, ctx.host, "unexpected error", message)
      }
      const note = ctx.profile.capabilities.promiseV2
        ? "host kit loud stub ok"
        : "host kit loud stub ok (host promiseV2 still false — M1 required for end-to-end T3)"
      return pass(this, ctx.host, note, message)
    }
  },
}
