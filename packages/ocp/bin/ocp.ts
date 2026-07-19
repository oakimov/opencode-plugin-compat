#!/usr/bin/env bun
/**
 * `ocp` — umbrella CLI. Default command is `setup` (ADR-10).
 * Also forwards doctor / overrides / matrix / migrate-zcode to the bridge CLI.
 */
import { mainAsync } from "@opencode-compat/cli"

const argv = process.argv.slice()
// bun bin/ocp.ts [command] ...  → inject default "setup" when omitted
const userArgs = argv.slice(2)
const known = new Set([
  "setup",
  "doctor",
  "overrides",
  "matrix",
  "migrate-zcode",
  "help",
  "--help",
  "-h",
])
if (userArgs.length === 0 || !known.has(userArgs[0]!)) {
  argv.splice(2, 0, "setup")
}

process.exit(await mainAsync(argv))
