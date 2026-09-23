import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runClone, unshimClone, type CloneHost } from "./clone.ts"
import { runDsh, unshimDsh } from "./dsh-family.ts"
import { configFile, familyOf, HOSTS, installedHosts, isHostId, type HostId, type WireMode } from "./hosts.ts"
import { assertManaged, defaultProviderPath, hostStateDir } from "./paths.ts"
import { runPi, unshimPi, type PiHost } from "./pi-family.ts"
import { assertSafeProvider, assertStockClean, ensureStockBuild, isStockDirty, repairStock } from "./stock.ts"
import { buildWrapper } from "./wrapper.ts"

function die(message: string): never {
  console.error(`ocp-dev: ${message}`)
  process.exit(1)
}

function usage(): void {
  console.log(`Usage: ocp-dev.sh <run|unshim> [hosts...] [--mode local|npm]

  run      Wire hosts to this OCP checkout + cursor provider (local)
           or published packages (--mode npm). Existing host config is
           preserved; only the OCP/provider slot is inserted or replaced.
  refresh-provider <mimo|kilo> <checkout> <wrapper-name>
           Rebuild an existing additional provider wrapper without changing config.
  unshim   Remove that slot and restore factory package state. Other
           host config is left untouched.

Shim hosts: mimo, kilo, pi, omp, dsh. OpenCode is native — run skips it;
named "run opencode" is an error. With no host names, act on every installed
shim host.

Environment:
  OCP_DEV_PROVIDER_PATH   cursor-opencode-provider checkout
  OCP_DEV_DEVIN_PROVIDER_PATH  devin-opencode-provider checkout (DSH extra row)
  OCP_DEV_PLUGIN          provider package name (default: cursor-opencode-provider)
  OCP_DEV_STATE_DIR       wrapper/manifest root (default: ~/.cache/ocp-dev)
  OCP_DEV_BRIDGE_VERSION  npm pi-bridge version (default: latest)
  OCP_DEV_PLUGIN_VERSION  npm provider version (default: latest)
  DSH_HARNESS_ROOT        deepseek-harness checkout (else OCP sibling)
  DSH_HOME                DSH data/config root (default ~/.dsh)
`)
}

function parseArgs(argv: string[]): { command: string; hosts: string[]; mode: WireMode } {
  const rest = argv.slice(2)
  const command = rest[0] ?? ""
  const hosts: string[] = []
  let mode: WireMode = "local"
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i]!
    if (arg === "--mode") {
      const value = rest[i + 1]
      if (value !== "local" && value !== "npm") die("--mode expects local or npm")
      mode = value
      i += 1
      continue
    }
    if (arg === "--local") {
      mode = "local"
      continue
    }
    if (arg === "--npm") {
      mode = "npm"
      continue
    }
    if (arg === "-h" || arg === "--help") {
      usage()
      process.exit(0)
    }
    hosts.push(arg)
  }
  return { command, hosts, mode }
}

const NATIVE_NO_SHIM: ReadonlySet<HostId> = new Set(["opencode"])

async function resolveTargets(requested: string[], command: "run" | "unshim"): Promise<HostId[]> {
  if (requested.length === 0 || requested[0] === "--all" || requested[0] === "all") {
    const found = await installedHosts()
    const targets = command === "run" ? found.filter((host) => !NATIVE_NO_SHIM.has(host)) : found
    if (targets.length === 0) {
      die(`no shim hosts found (looked for: mimo kilo pi omp dsh)`)
    }
    if (command === "run" && found.some((host) => NATIVE_NO_SHIM.has(host))) {
      console.log("ocp-dev: skipping native OpenCode (loads provider dist/ directly)")
    }
    return targets
  }
  const targets: HostId[] = []
  for (const name of requested) {
    if (!isHostId(name)) die(`unknown host: ${name} (expected ${HOSTS.join("|")})`)
    if (command === "run" && NATIVE_NO_SHIM.has(name)) {
      die("opencode is native and does not need an ocp-dev shim (loads the provider checkout dist/ directly)")
    }
    targets.push(name)
  }
  return targets
}

async function runHost(host: HostId, mode: WireMode): Promise<void> {
  const fam = familyOf(host)
  if (fam === "clone") await runClone(host as CloneHost, mode)
  else if (fam === "pi") await runPi(host as PiHost, mode)
  else await runDsh(host as never, mode)
}

async function unshimHost(host: HostId): Promise<void> {
  const fam = familyOf(host)
  if (fam === "clone") unshimClone(host as CloneHost)
  else if (fam === "pi") {
    try {
      await unshimPi(host as PiHost)
    } catch (error) {
      console.error(`ocp-dev: ${host} unshim reported an error (continuing)`)
      if (error instanceof Error) console.error(`  ${error.message}`)
    }
    unshimClone(host as never)
  } else {
    try {
      await unshimDsh(host as never)
    } catch (error) {
      console.error(`ocp-dev: ${host} unshim reported an error (continuing)`)
      if (error instanceof Error) console.error(`  ${error.message}`)
    }
  }
}

async function cmdRun(hosts: string[], mode: WireMode): Promise<void> {
  const targets = await resolveTargets(hosts, "run")
  console.log(`ocp-dev: wiring ${targets.length} host(s) in ${mode} mode: ${targets.join(" ")}`)
  const ok: string[] = []
  const failed: string[] = []
  for (const host of targets) {
    console.log(`\n=== ${host} (${mode}) ===`)
    try {
      await runHost(host, mode)
      ok.push(host)
    } catch (error) {
      failed.push(host)
      console.error(`ocp-dev: ${host} failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  console.log(`\nocp-dev: wired ${ok.length} host(s)${ok[0] ? `: ${ok.join(" ")}` : ""}`)
  if (failed.length > 0) die(`FAILED ${failed.length} host(s): ${failed.join(" ")}`)
}

async function cmdUnshim(hosts: string[]): Promise<void> {
  const targets = await resolveTargets(hosts, "unshim")
  console.log(`ocp-dev: unshimming ${targets.length} host(s): ${targets.join(" ")}`)
  for (const host of targets) {
    console.log(`\n=== ${host} ===`)
    await unshimHost(host)
  }
  try {
    const provider = defaultProviderPath()
    if (isStockDirty(provider)) {
      console.log("ocp-dev: provider checkout is dirty — restoring it as part of unshim")
      repairStock(provider)
    } else {
      console.log(`ocp-dev: provider checkout already clean: ${provider}`)
    }
  } catch (error) {
    console.log(`ocp-dev: no provider checkout to inspect (${error instanceof Error ? error.message : error})`)
  }
  console.log("\nocp-dev: factory state restored")
}

async function cmdRefreshProvider(args: string[]): Promise<void> {
  if (args.length !== 3) die("refresh-provider expects <mimo|kilo> <checkout> <wrapper-name>")
  const [host, stock, name] = args as [string, string, string]
  if (host !== "mimo" && host !== "kilo") die("refresh-provider supports clone hosts only")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name === "provider") die("invalid additional wrapper name")
  const wrapper = join(hostStateDir(host), name)
  assertManaged(wrapper)
  if (!existsSync(join(wrapper, "package.json"))) die(`existing wrapper missing: ${wrapper}`)
  const config = configFile(host)
  if (!existsSync(config) || !readFileSync(config, "utf8").includes(join(wrapper, "dist", "index.js"))) {
    die(`host config does not reference existing wrapper: ${wrapper}`)
  }
  assertSafeProvider(stock)
  assertStockClean(stock)
  const sourcePackage = JSON.parse(readFileSync(join(stock, "package.json"), "utf8")) as { name?: string }
  const wrapperPackage = JSON.parse(readFileSync(join(wrapper, "package.json"), "utf8")) as { name?: string }
  if (!sourcePackage.name || sourcePackage.name !== wrapperPackage.name) {
    die(`wrapper package differs from checkout: ${wrapper}`)
  }
  ensureStockBuild(stock)
  await buildWrapper(host, stock, wrapper)
  console.log(`ocp-dev: refreshed ${sourcePackage.name} for ${host}: ${wrapper}`)
}

async function main(): Promise<void> {
  const { command, hosts, mode } = parseArgs(process.argv)
  if (command === "run" || command === "shim") await cmdRun(hosts, mode)
  else if (command === "refresh-provider") await cmdRefreshProvider(hosts)
  else if (command === "unshim") await cmdUnshim(hosts)
  else if (command === "-h" || command === "--help" || command === "help" || command === "") usage()
  else die(`unknown command: ${command}`)
}

await main()
