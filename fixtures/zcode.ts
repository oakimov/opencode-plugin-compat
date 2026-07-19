import { detect } from "@opencode-compat/profile"
import { fail, pass, skip, type Fixture } from "./types.ts"

export const zcodeT0Doctor: Fixture = {
  id: "zcode.t0-doctor",
  tier: "T0",
  description: "ZCode detection yields T0 doctor message only",
  async run(ctx) {
    if (ctx.host !== "zcode") {
      return skip(this, ctx.host, "fixture only applies to zcode host cell")
    }
    const result = detect({
      env: { OPENCODE_COMPAT_HOST: "zcode" },
      home: "/tmp/ocp-fixture",
    })
    if (result.supported) {
      return fail(this, ctx.host, "zcode must not be OCP-loadable")
    }
    if (!result.message?.includes("marketplace") || !result.message.includes("T0")) {
      return fail(this, ctx.host, "doctor message incomplete", result.message)
    }
    return pass(this, ctx.host, "T0 doctor message ok")
  },
}
