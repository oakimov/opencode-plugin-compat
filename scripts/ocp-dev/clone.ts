import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { applyCloneSlot, revertCloneSlot, type CloneManifest } from "./config-slot.ts"
import { configFile, packagesDir, resolveCli, type HostId, type WireMode } from "./hosts.ts"
import { assertManaged, defaultProviderPath, hostStateDir, manifestPath, pluginName, readText, repoRoot, wrapperDir } from "./paths.ts"
import { assertSafeProvider, assertStockClean, ensureStockBuild } from "./stock.ts"
import { buildWrapper } from "./wrapper.ts"

export type CloneHost = Exclude<HostId, "pi" | "omp">

function assertPackagesDir(dir: string): void {
  if (!dir || dir === "/" || dir === process.env.HOME) {
    throw new Error(`refusing unsafe host packages path: ${dir || "<empty>"}`)
  }
  if (basename(dir) !== "packages") throw new Error(`host cache target must end in /packages: ${dir}`)
}

export function cleanPluginInstalls(packages: string, plugin: string): void {
  assertPackagesDir(packages)
  if (!plugin || plugin.startsWith("/") || plugin.includes("..")) {
    throw new Error(`refusing unsafe plugin name: ${plugin || "<empty>"}`)
  }
  if (!existsSync(packages)) return
  const parent = dirname(join(packages, plugin))
  if (!existsSync(parent)) return
  const leaf = basename(plugin)
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(`${leaf}@`)) continue
    const candidate = join(parent, name)
    if (dirname(candidate) !== parent) continue
    rmSync(candidate, { recursive: true, force: true })
    console.log(`ocp-dev: removed cached plugin install ${candidate}`)
  }
  const rootModule = join(packages, "node_modules", plugin)
  if (existsSync(rootModule)) {
    rmSync(rootModule, { recursive: true, force: true })
    console.log(`ocp-dev: removed root cached module ${rootModule}`)
  }
}

function linkCache(moduleDir: string, target: string): void {
  mkdirSync(dirname(moduleDir), { recursive: true })
  rmSync(moduleDir, { recursive: true, force: true })
  symlinkSync(target, moduleDir)
  console.log(`ocp-dev: cache module → ${target}`)
}

function runOcpSetup(host: CloneHost, mode: "file" | "npm", packages: string): void {
  const cli = join(repoRoot(), "packages/ocp/bin/ocp.ts")
  console.log(`ocp-dev: ocp setup --host ${host} --mode ${mode}`)
  const result = Bun.spawnSync({
    cmd: ["bun", cli, "setup", "--host", host, "--mode", mode, "--dir", packages],
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error("ocp setup failed")
}

function installPluginNpm(hostCli: string, plugin: string): void {
  console.log(`ocp-dev: ${hostCli} plugin -g ${plugin}@latest -f`)
  const result = Bun.spawnSync({
    cmd: [hostCli, "plugin", "-g", `${plugin}@latest`, "-f"],
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error("host plugin install failed")
}

export async function runClone(host: CloneHost, mode: WireMode): Promise<void> {
  const stock = defaultProviderPath()
  const plugin = pluginName()
  const packages = packagesDir(host)
  const hostCli = await resolveCli(host)
  const configPath = configFile(host)
  assertSafeProvider(stock)
  assertStockClean(stock)
  ensureStockBuild(stock)
  cleanPluginInstalls(packages, plugin)

  if (mode === "local") {
    const wrapper = await buildWrapper(host, stock)
    const pkgRoot = join(packages, `${plugin}@latest`)
    linkCache(join(pkgRoot, "node_modules", plugin), wrapperDir(host))
    applyCloneSlot({
      configPath,
      manifestPath: manifestPath(host),
      host,
      mode,
      pluginEntry: wrapper,
      providerNpm: `file://${wrapper}`,
      stock,
      wrapper: wrapperDir(host),
    })
    runOcpSetup(host, "file", packages)
    assertStockClean(stock)
    console.log(`\nocp-dev: ${host} is on LOCAL OCP + LOCAL ${plugin}`)
    console.log(`  wrapper:  ${wrapper}`)
    console.log(`  stock:    ${stock}  (untouched)`)
    console.log(`  config:   ${configPath}`)
    console.log(`  verify:   ${hostCli} models`)
    return
  }

  applyCloneSlot({
    configPath,
    manifestPath: manifestPath(host),
    host,
    mode,
    pluginEntry: `${plugin}@latest`,
    providerNpm: plugin,
    stock,
    wrapper: "",
  })
  installPluginNpm(hostCli, plugin)
  runOcpSetup(host, "npm", packages)
  const wrapper = wrapperDir(host)
  if (existsSync(wrapper)) {
    assertManaged(wrapper)
    rmSync(wrapper, { recursive: true, force: true })
    console.log(`ocp-dev: removed stale local wrapper ${wrapper}`)
  }
  console.log(`\nocp-dev: ${host} is on published npm OCP + npm ${plugin}`)
  console.log(`  stock:  ${stock}  (untouched)`)
  console.log(`  verify: ${hostCli} models`)
}

export function unshimClone(host: CloneHost): void {
  const path = manifestPath(host)
  const raw = readText(path)
  if (!raw) {
    console.log(`ocp-dev: ${host} is not wired (no manifest)`)
    return
  }
  const manifest = JSON.parse(raw) as CloneManifest
  revertCloneSlot(manifest)
  const dir = hostStateDir(host)
  assertManaged(dir)
  rmSync(dir, { recursive: true, force: true })
  console.log(`ocp-dev: reverted ${host} slot in ${manifest.config.path}`)
  console.log(`ocp-dev: removed dev state ${dir}`)
}
