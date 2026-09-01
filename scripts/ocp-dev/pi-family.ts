import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync } from "node:fs"
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
  const repoSiblingAi = host === "pi"
    ? join(repoRoot(), "..", "pi", "packages", "ai")
    : join(repoRoot(), "..", "oh-my-pi", "packages", "ai")
  const candidates: string[] = []
  candidates.push(join(dirname(cliReal), "..", "node_modules", pkg))
  candidates.push(join(dirname(cliReal), "../../..", pkg))
  // Probe npm cache (repoRoot/node_modules/.bun) for the host package — importable without building natives
  try {
    const bunCache = join(repoRoot(), "node_modules", ".bun")
    for (const entry of readdirSync(bunCache)) {
      if (entry.startsWith(pkg.replace("/", "+") + "@") || entry.startsWith(pkg.replace("@", "").replace("/", "+") + "@")) {
        const candidate = join(bunCache, entry, "node_modules", pkg)
        if (existsSync(join(candidate, "package.json"))) candidates.push(candidate)
      }
      // Also handle @oh-my-pi/pi-ai -> @oh-my-pi+pi-ai@* pattern
      if (pkg === "@oh-my-pi/pi-ai" && entry.startsWith("@oh-my-pi+pi-ai@")) {
        const candidate = join(bunCache, entry, "node_modules", pkg)
        if (existsSync(join(candidate, "package.json"))) candidates.push(candidate)
      }
      if (pkg === "@earendil-works/pi-ai" && entry.startsWith("@earendil-works+pi-ai@")) {
        const candidate = join(bunCache, entry, "node_modules", pkg)
        if (existsSync(join(candidate, "package.json"))) candidates.push(candidate)
      }
    }
  } catch {}
  // Also probe Bun's resolver (repo root) for the host package
  try {
    const resolved = Bun.resolveSync(pkg, repoRoot())
    if (resolved) {
      const base = resolved.split(pkg)[0] + pkg.split("/").slice(0, 2).join("/")
      candidates.push(base)
    }
  } catch {}
  // Last resort: sibling checkout (local dev). Prefer npm cache over unbuilt checkout.
  if (existsSync(join(repoSiblingAi, "package.json"))) {
    candidates.push(repoSiblingAi)
  }

  const hasBuiltEntry = (root: string): boolean => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main?: string }
      return existsSync(join(root, manifest.main || "dist/index.js"))
    } catch {
      return false
    }
  }

  let source: string | undefined
  for (const c of candidates) {
    if (!existsSync(join(c, "package.json")) || !hasBuiltEntry(c)) continue
    try {
      source = realpathSync(c)
    } catch {
      source = c
    }
    break
  }
  if (!source) {
    const target = join(bridgePath(), "node_modules", pkg)
    try {
      if (existsSync(target) && lstatSync(target).isSymbolicLink() && !hasBuiltEntry(target)) {
        rmSync(target, { force: true })
        console.log(`ocp-dev: removed unbuilt ${pkg} link`)
      }
    } catch {}
    console.log(`ocp-dev: no built ${pkg} to link (pi injects it at runtime); skipping`)
    return
  }
  const target = join(bridgePath(), "node_modules", pkg)
  mkdirSync(dirname(target), { recursive: true })

  const sourceVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version as string
    } catch {
      return undefined
    }
  })()
  const targetVersion = (() => {
    try {
      const real = lstatSync(target).isSymbolicLink() ? realpathSync(target) : target
      return JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version as string
    } catch {
      return undefined
    }
  })()

  if (existsSync(target)) {
    const isLink = (() => {
      try {
        return lstatSync(target).isSymbolicLink()
      } catch {
        return false
      }
    })()
    if (!isLink && existsSync(join(target, "package.json"))) {
      if (targetVersion && sourceVersion && targetVersion === sourceVersion) {
        console.log(`ocp-dev: ${pkg}@${targetVersion} already resolves inside local pi-bridge`)
        return
      }
      console.log(`ocp-dev: ${pkg} version mismatch ${targetVersion ?? "unknown"} vs host ${sourceVersion ?? "unknown"} → relinking`)
      // Remove real directory installed by `bun install` before symlinking
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {}
    } else if (isLink) {
      const current = (() => {
        try {
          return realpathSync(target)
        } catch {
          return undefined
        }
      })()
      if (current === source && targetVersion === sourceVersion) {
        console.log(`ocp-dev: ${pkg}@${sourceVersion} already linked to host runtime ${source}`)
        return
      }
      console.log(`ocp-dev: ${pkg} stale link ${current ?? "broken"}@${targetVersion ?? "?"} → updating to ${source}@${sourceVersion ?? "?"}`)
      try {
        rmSync(target, { force: true })
      } catch {}
    } else if (!isLink) {
      throw new Error(`refusing to replace non-package host peer target: ${target}`)
    } else {
      try {
        rmSync(target, { force: true })
      } catch {}
    }
  }
  symlinkSync(source, target)
  console.log(`ocp-dev: ${pkg}@${sourceVersion ?? "?"} → host runtime ${source}`)
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


