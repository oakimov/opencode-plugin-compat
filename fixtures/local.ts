import { fail, pass, skip, type Fixture } from "./types.ts"

export const localDotOpencodeScan: Fixture = {
  id: "local.dot-opencode-scan",
  tier: "T2",
  description: ".opencode project dir scan (native or compat expectation)",
  async run(ctx) {
    if (ctx.host === "zcode" || ctx.host === "unknown") {
      return skip(this, ctx.host, "not an OCP plugin host")
    }
    if (ctx.profile.capabilities.scansDotOpencode) {
      return pass(this, ctx.host, "host natively scans .opencode")
    }
    const compat = ctx.profile.paths.compatProjectDirs ?? []
    if (compat.includes(".opencode") && ctx.compatScanEnabled) {
      return pass(
        this,
        ctx.host,
        "compatProjectDirs expectation exercised (--compat-scan)",
        compat.join(","),
      )
    }
    if (compat.includes(".opencode")) {
      return skip(
        this,
        ctx.host,
        "scansDotOpencode=false; compat scan not enabled in this run",
        "set compatScanEnabled / --compat-scan, or copy/symlink into host-native project dirs",
      )
    }
    return fail(
      this,
      ctx.host,
      "no .opencode scan and no compatProjectDirs declared",
    )
  },
}