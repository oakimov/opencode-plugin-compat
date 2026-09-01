import { runClone, unshimClone, type CloneHost } from "./clone.ts"
import { runDsh, unshimDsh } from "./dsh-family.ts"
import { familyOf, HOSTS, installedHosts, isHostId, type HostId, type WireMode } from "./hosts.ts"
import { defaultProviderPath } from "./paths.ts"
import { runPi, unshimPi, type PiHost } from "./pi-family.ts"
import { isStockDirty, repairStock } from "./stock.ts"

function die(message: string): never {
  console.error(`ocp-dev: ${message}`)
  process.exit(1)
}

function usage(): void {
  console.log(`Usage: ocp-dev.sh <run|unshim> [hosts...] [--mode local|npm]

  run      Wire hosts to this OCP checkout + cursor provider (local)
           or published packages (--mode npm). Existing host config is
           preserved; only the OCP/provider slot is inserted or replaced.
  unshim   Remove that slot and restore factory package state. Other
           host config is left untouched.

Hosts: ${HOSTS.join(", ")}. With no host names, act on every installed host.

Environment:
  OCP_DEV_PROVIDER_PATH   cursor-opencode-provider checkout
  OCP_DEV_PLUGIN          provider package name (default: cursor-opencode-provider)
  OCP_DEV_STATE_DIR       wrapper/manifest root (default: ~/.cache/ocp-dev)
  OCP_DEV_BRIDGE_VERSION  npm pi-bridge version (default: latest)
  OCP_DEV_PLUGIN_VERSION  npm provider version (default: latest)
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

async function resolveTargets(requested: string[]): Promise<HostId[]> {
  if (requested.length === 0 || requested[0] === "--all" || requested[0] === "all") {
    const found = await installedHosts()
    if (found.length === 0) die(`no supported hosts found on PATH (looked for: ${HOSTS.join(" ")})`)
    return found
  }
  const targets: HostId[] = []
  for (const name of requested) {
    if (!isHostId(name)) die(`unknown host: ${name} (expected ${HOSTS.join("|")})`)
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
  const targets = await resolveTargets(hosts)
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
  const targets = await resolveTargets(hosts)
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

async function main(): Promise<void> {
  const { command, hosts, mode } = parseArgs(process.argv)
  if (command === "run" || command === "shim") await cmdRun(hosts, mode)
  else if (command === "unshim") await cmdUnshim(hosts)
  else if (command === "-h" || command === "--help" || command === "help" || command === "") usage()
  else die(`unknown command: ${command}`)
}

await main()
