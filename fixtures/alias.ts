import { PKG as facadePkg, tool } from "@opencode-compat/facade-plugin"
import { PKG as sdkPkg } from "@opencode-compat/facade-sdk"
import { fail, pass, skip, type Fixture } from "./types.ts"

export const aliasResolvePlugin: Fixture = {
  id: "alias.resolve-plugin",
  tier: "T1",
  description: "@opencode-ai/plugin resolves via facade override surface",
  async run(ctx) {
    if (ctx.host === "zcode" || ctx.host === "unknown") {
      return skip(this, ctx.host, "no OCP facade path on this host")
    }
    if (facadePkg !== "@opencode-compat/facade-plugin") {
      return fail(this, ctx.host, "facade-plugin identity mismatch", facadePkg)
    }
    if (sdkPkg !== "@opencode-compat/facade-sdk") {
      return fail(this, ctx.host, "facade-sdk identity mismatch", sdkPkg)
    }
    const def = tool({
      description: "alias-smoke",
      args: {},
      async execute() {
        return "ok"
      },
    })
    if (def.description !== "alias-smoke") {
      return fail(this, ctx.host, "tool export broken")
    }
    return pass(
      this,
      ctx.host,
      "facade-plugin + facade-sdk + tool export resolvable",
      `override target nativePlugin=${ctx.profile.nativePlugin}`,
    )
  },
}
