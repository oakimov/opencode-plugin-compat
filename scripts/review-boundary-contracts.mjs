// Trusted review-harness boundary checks, run inside isolate-run.sh against
// the archived subject at /src. They read the subject's source, not its own
// architecture test, so a pull request cannot weaken the check it is judged
// by. No host, no provider and no credential is loaded.
//
// Each case prints BOUNDARY_CONTRACT=<case>:passed|failed|skipped <detail>.
// A case is skipped when its subject files do not exist; the wrapper treats a
// case that passed on the merge base and is skipped on the head as a lost
// capability. The last line is REVIEW_CONTRACT_COMPLETE=BOUNDARY_CONTRACTS:<status>.
//
// The invariants are AGENTS.md's: one-way OCP/consumer dependency, separate
// clone / Pi / DSH mechanisms, exact train pins for foreign file:
// installs, and the neutral path-bridge contract.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const LABEL = "BOUNDARY_CONTRACTS"
const src = process.argv[2]
if (!src || !existsSync(join(src, "package.json"))) {
  console.log(`BOUNDARY_CONTRACT=subject:unavailable no package.json at ${src ?? "<missing argument>"}`)
  process.exit(2)
}

let failed = 0

function report(name, status, detail = "") {
  if (status === "failed") failed += 1
  console.log(`BOUNDARY_CONTRACT=${name}:${status}${detail ? ` ${detail}` : ""}`)
}

function filesUnder(dir, extensions = [".ts", ".mts", ".js", ".mjs"]) {
  const root = join(src, dir)
  if (!existsSync(root)) return undefined
  const out = []
  const walk = path => {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name === "dist") continue
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (extensions.some(ext => full.endsWith(ext))) out.push(full)
    }
  }
  walk(root)
  return out
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex")
}

function violations(files, pattern) {
  const found = []
  for (const file of files) {
    const path = JSON.stringify(relative(src, file))
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    const occurrences = new Map()
    for (const [index, line] of lines.entries()) {
      if (!pattern.test(line)) continue
      const hash = fingerprint(line.trim())
      const occurrence = (occurrences.get(hash) ?? 0) + 1
      occurrences.set(hash, occurrence)
      found.push(`file=${path} fingerprint=${hash} occurrence=${occurrence} line=${index + 1}`)
    }
  }
  return found
}

function reportViolations(name, found) {
  if (found.length === 0) report(name, "passed")
  for (const detail of found) report(name, "failed", detail)
}

function caseNoMatch(name, dir, pattern) {
  const files = filesUnder(dir)
  if (!files) return report(name, "skipped", `${dir} absent`)
  reportViolations(name, violations(files, pattern))
}

// packages/adapter must not contain Pi/OMP/DSH ids, paths, env variables or packages.
caseNoMatch(
  "clone-adapter-has-no-pi-dsh",
  "packages/adapter/src",
  /PI_CODING_AGENT_DIR|PI_CONFIG_DIR|DSH_HOME|DSH_HARNESS_ROOT|@oh-my-pi|@earendil-works|@deepseek-ai|@opencode-compat\/(?:pi|dsh)-bridge|\.omp(?:["'`/])|\.pi(?:["'`/])|\.dsh(?:["'`/])|case\s+["'](?:omp|pi|dsh)["']/,
)

// DSH must not import Pi host packages or the Pi bridge.
caseNoMatch(
  "dsh-bridge-has-no-pi-host",
  "packages/dsh-bridge/src",
  /from\s+["'](?:@oh-my-pi|@earendil-works|@opencode-compat\/pi-bridge)|import\(\s*["'](?:@oh-my-pi|@earendil-works|@opencode-compat\/pi-bridge)/,
)

// Generic Pi entry/core: no static import of the optional Cursor integration or provider.
{
  const generic = ["extension.ts", "bridge.ts", "register.ts", "config.ts", "path-bridge.ts"]
    .map(name => join(src, "packages/pi-bridge/src", name))
    .filter(existsSync)
  if (generic.length === 0) report("pi-generic-has-no-static-cursor", "skipped", "packages/pi-bridge/src absent")
  else reportViolations("pi-generic-has-no-static-cursor", violations(
    generic,
    /^\s*import[^\n]*(?:cursor-host-tools|cursor-opencode-provider|cursor-provider-integration)/,
  ))
}

// Foreign file: installs need exact train pins (never workspace:*).
{
  const train = (() => {
    try {
      return JSON.parse(readFileSync(join(src, "packages/profile/package.json"), "utf8")).version
    } catch {
      return undefined
    }
  })()
  for (const pkg of ["pi-bridge", "dsh-bridge"]) {
    const manifest = join(src, "packages", pkg, "package.json")
    const name = `${pkg}-exact-train-pins`
    if (!existsSync(manifest) || !train) {
      report(name, "skipped", `${pkg} or train version absent`)
      continue
    }
    const deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}
    const bad = Object.entries(deps)
      .filter(([dep, spec]) => dep.startsWith("@opencode-compat/") && spec !== train)
      .map(([dep, spec]) => `file=${JSON.stringify(relative(src, manifest))} dependency=${JSON.stringify(dep)} fingerprint=${fingerprint(JSON.stringify([train, spec]))}`)
    reportViolations(name, bad)
  }
}

// Every path installer publishes the neutral structural symbol.
{
  const installers = [
    "packages/adapter/src/runtime-host.ts",
    "packages/pi-bridge/src/path-bridge.ts",
    "packages/dsh-bridge/src/path-bridge.ts",
  ].filter(file => existsSync(join(src, file)))
  if (installers.length === 0) report("path-bridge-neutral-symbol", "skipped", "no path installers")
  else {
    const missing = installers.filter(file => !readFileSync(join(src, file), "utf8").includes('Symbol.for("opencode.host.path-bridge")'))
    reportViolations("path-bridge-neutral-symbol", missing.map(file => `file=${JSON.stringify(file)}`))
  }
}

const status = failed === 0 ? "passed" : "failed"
console.log(`REVIEW_CONTRACT_COMPLETE=${LABEL}:${status}`)
process.exit(failed === 0 ? 0 : 1)
