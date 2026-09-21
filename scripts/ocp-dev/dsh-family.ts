import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { runDshTsdown } from "./dsh-tsdown.ts"
import { configDir, dshBuiltCli, dshHarnessRoot, type HostId, type WireMode } from "./hosts.ts"
import { defaultDevinProviderPath, defaultProviderPath, pluginName, repoRoot } from "./paths.ts"
import { hostStateDir, writeAtomic } from "./paths.ts"

export type DshHost = Extract<HostId, "dsh">

function run(cwd: string | undefined, cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`)
}

function dshBridgePath(): string {
  return join(repoRoot(), "packages/dsh-bridge")
}

function syncDistTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    const from = join(src, name)
    const to = join(dest, name)
    const st = statSync(from)
    if (st.isDirectory()) {
      syncDistTree(from, to)
      continue
    }
    if (existsSync(to)) {
      const dt = statSync(to)
      if (dt.ino === st.ino && dt.dev === st.dev) continue
    }
    copyFileSync(from, to)
  }
}

/**
 * pnpm `file:` copies the package into the profile `node_modules` tree.
 * Existing files stay hardlinked (in-place tsc writes show up), but *new*
 * dist files do not — DSH then fails to load the bridge and drops Cursor.
 * `fs.cpSync` also throws `ERR_FS_CP_EEXIST` on those hardlinks, so copy
 * file-by-file and skip same-inode pairs.
 */
export function syncInstalledFilePackageDist(sourcePkg: string, destPkg: string): boolean {
  const src = join(sourcePkg, "dist")
  if (!existsSync(src) || !existsSync(destPkg)) return false
  syncDistTree(src, join(destPkg, "dist"))
  return true
}

function syncLocalBridgeIntoProfile(): void {
  const profileNm = join(configDir("dsh"), "node_modules/@opencode-compat")
  const root = repoRoot()
  for (const name of ["dsh-bridge", "opencode-loader"] as const) {
    const dest = join(profileNm, name)
    if (syncInstalledFilePackageDist(join(root, "packages", name), dest)) {
      console.log(`ocp-dev: synced ${name} dist into ${dest}`)
    }
  }
}

async function buildHarness(harness: string): Promise<void> {
  console.log(`ocp-dev: installing dsh harness dependencies in ${harness}`)
  run(harness, ["pnpm", "install"])
  console.log("ocp-dev: building dsh native-system")
  run(harness, ["pnpm", "run", "build:native-system"])
  console.log("ocp-dev: building dsh host lib (tsc + tsdown)")
  run(harness, ["node", "--max-old-space-size=4096", "./node_modules/typescript/bin/tsc", "-b", "tsconfig.host.json"])
  await runDshTsdown(harness, "host")
  console.log("ocp-dev: building dsh client lib (tsc + tsdown)")
  run(harness, ["./node_modules/typescript/bin/tsc", "-b", "tsconfig.client.json"])
  await runDshTsdown(harness, "client")
  console.log("ocp-dev: building dsh web frontend")
  run(harness, ["pnpm", "run", "build:web"])
}

function buildProviderPackage(provider: string, label: string): void {
  console.log(`ocp-dev: installing local ${label} dependencies`)
  if (existsSync(join(provider, "bun.lock"))) run(provider, ["bun", "install", "--frozen-lockfile"])
  else if (existsSync(join(provider, "package-lock.json"))) run(provider, ["npm", "ci"])
  else run(provider, ["bun", "install"])
  console.log(`ocp-dev: building local ${label}`)
  run(provider, ["bun", "run", "build"])
  if (!existsSync(join(provider, "dist", "index.js"))) throw new Error(`${label} entry missing after build`)
}

function buildLocal(providers: ReadonlyArray<{ path: string; label: string }>): void {
  const root = repoRoot()
  const bridge = dshBridgePath()
  const loader = join(root, "packages/opencode-loader")
  console.log("ocp-dev: installing locked OCP workspace dependencies")
  run(root, ["bun", "install", "--frozen-lockfile"])
  console.log("ocp-dev: building local opencode-loader")
  run(loader, ["bun", "run", "build"])
  console.log("ocp-dev: building local dsh-bridge")
  run(bridge, ["bun", "run", "build"])
  for (const entry of ["index.js"]) {
    if (!existsSync(join(bridge, "dist", entry))) throw new Error(`dsh-bridge entry missing after build: ${entry}`)
  }
  syncLocalBridgeIntoProfile()
  for (const provider of providers) buildProviderPackage(provider.path, provider.label)
}

export type DshProviderRow = { package: string; apiKey: string }

export function formatDshBridgePatch(rows: readonly DshProviderRow[], header = ""): string {
  if (rows.length === 0) throw new Error("dsh-bridge patch needs at least one provider")
  const providers = rows
    .map((row) => `      - package: '${row.package}'\n        apiKey: ${row.apiKey}`)
    .join("\n")
  return `${header}- id: ocp-dsh-bridge\n  config:\n    providers:\n${providers}\n`
}

export function localDshProviderRows(): DshProviderRow[] {
  const rows: DshProviderRow[] = [{
    package: resolve(join(defaultProviderPath(), "dist", "index.js")),
    apiKey: "CURSOR_API_KEY",
  }]
  const devin = defaultDevinProviderPath()
  if (devin) {
    rows.push({
      package: resolve(join(devin, "dist", "index.js")),
      apiKey: "DEVIN_API_KEY",
    })
  }
  return rows
}

function devPatchPath(): string {
  return join(hostStateDir("dsh"), "patch.yml")
}

function writeDevPatch(rows: readonly DshProviderRow[]): string {
  // For --patch overlay, use the bundle name (installed via `dsh plugin add` below).
  // Absolute dist paths as `name` break client module composition.
  const yaml = formatDshBridgePatch(rows, `# Generated by ocp-dev.sh run dsh (local) — do not edit manually
# Persistent profile already has the bridge bundle; this overlay is only for
# ad-hoc \`node <harness>/apps/cli/lib/bin.js web --patch ${devPatchPath()}\` testing.
# The web profile's own cordis.patch.yml is the primary dev surface.
`)
  const out = devPatchPath()
  mkdirSync(join(out, ".."), { recursive: true })
  writeAtomic(out, yaml)
  return out
}

function persistentPatchPath(): string {
  return join(configDir("dsh"), "cordis.patch.yml")
}

export async function runDsh(host: DshHost, mode: WireMode): Promise<void> {
  const provider = defaultProviderPath()
  const plugin = pluginName()
  const harness = dshHarnessRoot()

  if (mode === "local") {
    if (!harness) {
      throw new Error("dsh harness checkout not found; set DSH_HARNESS_ROOT to a deepseek-harness tree")
    }
    await buildHarness(harness)
    const extra = defaultDevinProviderPath()
    const providers = [{ path: provider, label: plugin }]
    if (extra) providers.push({ path: extra, label: "devin-opencode-provider" })
    buildLocal(providers)
    // Persistent install via `dsh plugin add file:` — the profile's bundle name is `@opencode-compat/dsh-bridge`
    // (its cordis.patch.yml inserts the bridge row). This avoids absolute `name:` in --patch which breaks client modules.
    const dshBin = Bun.which("dsh") ?? (harness ? join(harness, "node_modules/.bin/dsh") : undefined)
    const pluginAdd = (pkg: string) => {
      // Prefer `pnpm dsh plugin` from harness repo (works without global dsh)
      if (harness) {
        try { run(harness, ["pnpm", "dsh", "plugin", "--profile", "web", "add", `file:${pkg}`]); return } catch {}
      }
      if (dshBin) run(undefined, [dshBin, "plugin", "--profile", "web", "add", `file:${pkg}`])
      else throw new Error("dsh CLI not found and no harness repo")
    }
    try {
      // opencode-loader as plain dep (no bundle) must be first so dsh-bridge's file dep resolves
      const loaderPath = join(repoRoot(), "packages/opencode-loader")
      try { pluginAdd(loaderPath) } catch (e) { console.log(`ocp-dev: opencode-loader add note: ${e instanceof Error ? e.message : e}`) }
      pluginAdd(dshBridgePath())
    } catch (e) {
      console.log(`ocp-dev: dsh plugin add failed (${e instanceof Error ? e.message : e}) — falling back to --patch overlay`)
    }
    // Write persistent profile patch (primary) and ad-hoc --patch overlay
    const rows = localDshProviderRows()
    const persistent = persistentPatchPath()
    mkdirSync(join(persistent, ".."), { recursive: true })
    writeAtomic(persistent, formatDshBridgePatch(rows))
    const patch = writeDevPatch(rows)
    console.log(`\nocp-dev: dsh is on LOCAL dsh-bridge + LOCAL ${rows.map((row) => row.package).join(" + ")}`)
    console.log(`  bridge: ${dshBridgePath()}/dist/index.js`)
    for (const row of rows) console.log(`  provider: ${row.package} (${row.apiKey})`)
    console.log(`  persistent patch: ${persistent}`)
    console.log(`  dev overlay: ${patch} (for ad-hoc node apps/cli/lib/bin.js web --patch)`)
    console.log(`\n  Verify:`)
    if (harness) {
      const cli = dshBuiltCli(harness)
      console.log(`    node ${cli} --profile web --dump-config | grep -A3 ocp-dsh`)
      console.log(`  Run:`)
      console.log(`    node ${cli} web`)
      console.log(`    # built CLI, not checkout pnpm dsh (tsx source launcher dual-loads dsh-tools)`)
      console.log(`    # (no --patch needed — profile already has the bridge)`)
    } else {
      console.log(`    dsh --profile web --dump-config   # set DSH_HARNESS_ROOT to the harness checkout`)
      console.log(`  Run:`)
      console.log(`    dsh web`)
    }
    return
  }

  // npm mode — published packages
  const bridgeVersion = process.env.OCP_DEV_BRIDGE_VERSION || "latest"
  const pluginVersion = process.env.OCP_DEV_PLUGIN_VERSION || "latest"
  console.log(`ocp-dev: dsh npm mode would run:`)
  console.log(`  dsh plugin --profile web add @opencode-compat/dsh-bridge@${bridgeVersion}`)
  console.log(`  dsh plugin --profile web add ${plugin}@${pluginVersion}`)
  console.log(`  (then ensure cordis.patch.yml has providers: [{package: "${plugin}"}, {package: "devin-opencode-provider"}])`)
  // Try to run if dsh is on PATH
  const dshBin = Bun.which("dsh")
  if (dshBin) {
    console.log(`\n  Attempting npm installs via ${dshBin}...`)
    const harness = dshHarnessRoot()
    const cwd = harness ?? undefined
    // Use dsh plugin add which forwards to pnpm in profile dir; fall back to pnpm dsh if needed
    try {
      run(cwd, [dshBin, "plugin", "--profile", "web", "add", `@opencode-compat/dsh-bridge@${bridgeVersion}`])
      run(cwd, [dshBin, "plugin", "--profile", "web", "add", `${plugin}@${pluginVersion}`])
      const npmRows: DshProviderRow[] = [
        { package: plugin, apiKey: "CURSOR_API_KEY" },
        { package: "devin-opencode-provider", apiKey: "DEVIN_API_KEY" },
      ]
      const persistent = persistentPatchPath()
      mkdirSync(join(persistent, ".."), { recursive: true })
      writeAtomic(persistent, formatDshBridgePatch(npmRows))
      console.log(`\nocp-dev: dsh is on NPM dsh-bridge@${bridgeVersion} + NPM ${plugin}@${pluginVersion} + NPM devin-opencode-provider`)
      console.log(`  persistent patch: ${persistent}`)
    } catch {
      console.log(`ocp-dev: dsh plugin add failed — edit ${persistentPatchPath()} manually`)
    }
  } else {
    console.log(`\n  dsh not on PATH — run from harness repo:`)
    console.log(`    pnpm dsh plugin --profile web add @opencode-compat/dsh-bridge@${bridgeVersion}`)
  }
}

export async function unshimDsh(host: DshHost): Promise<void> {
  const patch = devPatchPath()
  try {
    const { rmSync } = await import("node:fs")
    rmSync(patch, { force: true })
    console.log(`ocp-dev: removed dev patch ${patch}`)
  } catch {}
  // Also try to remove persistent plugin if present
  const dshBin = Bun.which("dsh")
  const harness = dshHarnessRoot()
  const cwd = harness ?? undefined
  const plugin = pluginName()
  if (dshBin) {
    try { run(cwd, [dshBin, "plugin", "--profile", "web", "remove", "@opencode-compat/dsh-bridge"]) } catch {}
    try { run(cwd, [dshBin, "plugin", "--profile", "web", "remove", plugin]) } catch {}
  }
  console.log(`ocp-dev: dsh returned to factory state (dev patch removed)`)
  console.log(`  If you used persistent install, also check ${persistentPatchPath()}`)
}
