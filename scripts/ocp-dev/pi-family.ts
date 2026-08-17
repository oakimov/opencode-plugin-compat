import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { configFile, resolveCli, type HostId, type WireMode } from "./hosts.ts"
import { defaultProviderPath, pluginName, repoRoot } from "./paths.ts"
import { removePiProvider, upsertPiProvider } from "./pi-config.ts"

export type PiHost = Extract<HostId, "pi" | "omp">

function run(cwd: string | undefined, cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`)
}

function capture(cmd: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" })
  const output = `${result.stdout}${result.stderr}`
  return { ok: result.exitCode === 0, output }
}

function bridgePath(): string {
  return join(repoRoot(), "packages/pi-bridge")
}

function prepareLocal(provider: string): void {
  const root = repoRoot()
  const bridge = bridgePath()
  if (!existsSync(join(bridge, "package.json"))) throw new Error(`pi-bridge package.json missing: ${bridge}`)
  if (!existsSync(join(provider, "package.json"))) throw new Error(`provider package.json missing: ${provider}`)
  console.log("ocp-dev: installing locked OCP workspace dependencies")
  run(root, ["bun", "install", "--frozen-lockfile"])
  console.log("ocp-dev: building local pi-bridge")
  run(bridge, ["bun", "run", "build"])
  console.log("ocp-dev: installing local provider dependencies")
  if (existsSync(join(provider, "bun.lock"))) run(provider, ["bun", "install", "--frozen-lockfile"])
  else if (existsSync(join(provider, "package-lock.json"))) run(provider, ["npm", "ci"])
  else run(provider, ["bun", "install"])
  console.log("ocp-dev: building local provider")
  run(provider, ["bun", "run", "build"])
  for (const entry of ["extension.js", "extension-pi.js", "extension-omp.js"]) {
    if (!existsSync(join(bridge, "dist", entry))) throw new Error(`pi-bridge entry missing after build: ${entry}`)
  }
  if (!existsSync(join(provider, "dist", "index.js"))) throw new Error("provider entry missing after build")
}

function aiPackage(host: PiHost): string {
  return host === "pi" ? "@earendil-works/pi-ai" : "@oh-my-pi/pi-ai"
}

function linkHostAi(host: PiHost, hostCli: string): void {
  const pkg = aiPackage(host)
  const cliReal = realpathSync(hostCli)
  const nested = join(dirname(cliReal), "..", "node_modules", pkg)
  const hoisted = join(dirname(cliReal), "../../..", pkg)
  const source = existsSync(join(nested, "package.json")) ? realpathSync(nested)
    : existsSync(join(hoisted, "package.json")) ? realpathSync(hoisted)
    : undefined
  if (!source) throw new Error(`cannot locate ${pkg} beside host CLI ${cliReal}`)
  const target = join(bridgePath(), "node_modules", pkg)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) && !lstatSync(target).isSymbolicLink() && existsSync(join(target, "package.json"))) {
    console.log(`ocp-dev: ${pkg} already resolves inside local pi-bridge`)
    return
  }
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
    throw new Error(`refusing to replace non-package host peer target: ${target}`)
  }
  if (existsSync(target)) rmSync(target)
  symlinkSync(source, target)
  console.log(`ocp-dev: ${pkg} → host runtime ${source}`)
}

function piRemoveIfPresent(hostCli: string, source: string): void {
  const result = capture([hostCli, "remove", source])
  if (result.ok) {
    if (result.output.trim()) process.stdout.write(result.output)
    return
  }
  if (result.output.includes("No matching package found")) return
  process.stderr.write(result.output)
  throw new Error(`failed to remove Pi package source: ${source}`)
}

function ompRemoveIfPresent(hostCli: string, packageName: string): void {
  const result = capture([hostCli, "plugin", "uninstall", packageName])
  if (result.ok) {
    if (result.output.trim()) process.stdout.write(result.output)
    return
  }
  const output = result.output.toLowerCase()
  if (output.includes("not installed") || output.includes("no such") || output.includes("not found")) return
  process.stderr.write(result.output)
  throw new Error(`failed to uninstall OMP plugin: ${packageName}`)
}

export async function runPi(host: PiHost, mode: WireMode): Promise<void> {
  const hostCli = await resolveCli(host)
  const plugin = pluginName()
  const configPath = configFile(host)
  const bridge = bridgePath()
  if (mode === "local") {
    const provider = defaultProviderPath()
    prepareLocal(provider)
    linkHostAi(host, hostCli)
    if (host === "pi") {
      piRemoveIfPresent(hostCli, "npm:@opencode-compat/pi-bridge")
      piRemoveIfPresent(hostCli, `npm:${plugin}`)
      run(undefined, [hostCli, "install", bridge])
    } else {
      ompRemoveIfPresent(hostCli, "@opencode-compat/pi-bridge")
      ompRemoveIfPresent(hostCli, plugin)
      run(undefined, [hostCli, "plugin", "install", bridge])
    }
    upsertPiProvider(configPath, join(provider, "dist", "index.js"), plugin)
  } else {
    const bridgeVersion = process.env.OCP_DEV_BRIDGE_VERSION || "latest"
    const pluginVersion = process.env.OCP_DEV_PLUGIN_VERSION || "latest"
    if (host === "pi") {
      piRemoveIfPresent(hostCli, bridge)
      run(undefined, [hostCli, "install", `npm:@opencode-compat/pi-bridge@${bridgeVersion}`])
      run(undefined, [hostCli, "install", `npm:${plugin}@${pluginVersion}`])
    } else {
      ompRemoveIfPresent(hostCli, "@opencode-compat/pi-bridge")
      ompRemoveIfPresent(hostCli, plugin)
      run(undefined, [hostCli, "plugin", "install", `@opencode-compat/pi-bridge@${bridgeVersion}`, "--force"])
      run(undefined, [hostCli, "plugin", "install", `${plugin}@${pluginVersion}`, "--force"])
    }
    upsertPiProvider(configPath, plugin, plugin)
  }
  console.log(`\nocp-dev: ${host} is on ${mode.toUpperCase()} pi-bridge + ${mode.toUpperCase()} ${plugin}`)
  console.log(`  config: ${configPath}`)
  console.log(`  verify: restart ${host}, then open its model picker`)
}

export async function unshimPi(host: PiHost): Promise<void> {
  const hostCli = await resolveCli(host)
  const plugin = pluginName()
  const bridge = bridgePath()
  if (host === "pi") {
    piRemoveIfPresent(hostCli, "npm:@opencode-compat/pi-bridge")
    piRemoveIfPresent(hostCli, `npm:${plugin}`)
    piRemoveIfPresent(hostCli, bridge)
  } else {
    ompRemoveIfPresent(hostCli, "@opencode-compat/pi-bridge")
    ompRemoveIfPresent(hostCli, plugin)
  }
  removePiProvider(configFile(host), plugin)
  const target = join(bridge, "node_modules", aiPackage(host))
  try {
    if (lstatSync(target).isSymbolicLink()) {
      rmSync(target)
      console.log(`ocp-dev: unlinked ${aiPackage(host)} from ${bridge}`)
    }
  } catch {
    // absent
  }
  console.log(`ocp-dev: ${host} returned to factory state`)
}


