/**
 * `ocp zcode …` — the external OpenCode-plugin bridge for stock ZCode.
 *
 * ZCode is configured only through its own settings (a Personal provider
 * using Anthropic Messages); this command owns the OCP side: install root,
 * bridge credential, upstream login, readiness and the loopback listener.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { OCP_VERSION } from "@opencode-compat/profile"
import { openCodeAuthFromOAuthCallback, type OpenCodeAuth, type OpenCodeAuthMethod } from "@opencode-compat/opencode-loader"
import { DEFAULT_LIMITS, loadZcodeBridgeConfig, zcodePaths, ZcodeConfigError, type ZcodeBridgeConfig, type ZcodePaths } from "./config.js"
import { writeCredentialFile } from "./credentials.js"
import { loadPlugin, resolveInstalledPackage, type LoadedPlugin } from "./plugin-host.js"
import { createProbeFile, createProbeModel, createTranscript, PROBE_MODEL_ALIAS, PROBE_MODEL_INFO, PROBE_READ_TRIGGER } from "./probe.js"
import { buildGeneration, GenerationBuildError, type Generation } from "./runtime.js"
import { ListenerConflictError, startBridgeServer, type BridgeServer } from "./server.js"

const TELEMETRY_NOTE =
  "ZCode telemetry: OCP does not change ZCode's own telemetry (the shipped build has no user opt-out); see docs/guides/zcode-telemetry-block.md for host firewall/DNS blocking. Requests to this bridge never forward ZCode attribution headers to the plugin."

export const ZCODE_HELP = `ocp zcode — run unchanged OpenCode provider plugins behind stock ZCode (experimental)

Usage:
  ocp zcode install <package>@<exact-version>
  ocp zcode credential --file <path>
  ocp zcode check  [--config <file>]
  ocp zcode models [--config <file>] [--json]
  ocp zcode auth   --binding <id> --plugin <id> [--method oauth|api] [--logout] [--config <file>]
  ocp zcode serve  [--config <file>]
  ocp zcode probe  [--port <n>] [--transcript <file>]

ZCode side (its own settings only): add a Personal provider with API format
"Anthropic Messages", base URL http://127.0.0.1:<port>/v1, the bridge credential
as API key, and a Personal model whose ID is the alias printed by "models".

Default config: ${zcodePaths().configFile}
`

type Flags = { positional: string[]; values: Map<string, string>; switches: Set<string> }

function parseFlags(args: string[]): Flags {
  const flags: Flags = { positional: [], values: new Map(), switches: new Set() }
  const valued = new Set(["--config", "--binding", "--plugin", "--method", "--file", "--port", "--transcript"])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const eq = arg.indexOf("=")
    if (arg.startsWith("--") && eq > 0 && valued.has(arg.slice(0, eq))) flags.values.set(arg.slice(0, eq), arg.slice(eq + 1))
    else if (valued.has(arg)) {
      const value = args[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      flags.values.set(arg, value)
    } else if (arg.startsWith("--")) flags.switches.add(arg)
    else flags.positional.push(arg)
  }
  return flags
}

function configFile(flags: Flags, paths: ZcodePaths): string {
  return resolve(flags.values.get("--config") ?? paths.configFile)
}

function loadConfigOrReport(file: string): ZcodeBridgeConfig | undefined {
  try {
    return loadZcodeBridgeConfig(file)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (!existsSync(file)) console.error("Create it from the template in docs/hosts/zcode-bridge.md.")
    return undefined
  }
}

function printIssues(error: unknown): void {
  if (error instanceof GenerationBuildError) {
    for (const issue of error.issues) {
      console.error(`not ready: binding "${issue.binding}"${issue.plugin ? ` plugin "${issue.plugin}"` : ""} [${issue.code}] ${issue.message}`)
    }
  } else {
    console.error(`not ready: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function describeGeneration(generation: Generation, options: { paths: boolean }): string[] {
  const lines: string[] = []
  for (const binding of generation.bindings) {
    lines.push(`binding ${binding.spec.id}${options.paths ? ` workspace=${binding.spec.workspace}` : ""}`)
    for (const plugin of binding.plugins) {
      lines.push(`  plugin ${plugin.spec.id} ${plugin.resolved.name}@${plugin.resolved.version} contract=${plugin.spec.contract} provider=${plugin.providerId} auth=${plugin.authReadiness()}`)
      lines.push(`    entry sha256=${plugin.resolved.sha256}`)
      for (const model of plugin.models.values()) {
        lines.push(`    model ${model.alias} → ${model.upstream}${model.contextWindow ? ` context=${model.contextWindow}` : ""}${model.maxOutputTokens ? ` output=${model.maxOutputTokens}` : ""} input=${model.input.join("+")}`)
      }
    }
  }
  return lines
}

async function runCheck(flags: Flags, paths: ZcodePaths): Promise<number> {
  const config = loadConfigOrReport(configFile(flags, paths))
  if (!config) return 1
  try {
    const generation = await buildGeneration(config, { paths })
    for (const line of describeGeneration(generation, { paths: true })) console.log(line)
    const loginRequired = generation.bindings.flatMap(binding => binding.plugins).filter(plugin => plugin.authReadiness() === "login-required")
    for (const plugin of loginRequired) console.log(`auth required: ocp zcode auth --binding ${plugin.binding.id} --plugin ${plugin.spec.id}`)
    console.log(`listen http://${config.listen.host}:${config.listen.port}/v1`)
    console.log(TELEMETRY_NOTE)
    return loginRequired.length > 0 ? 2 : 0
  } catch (error) {
    printIssues(error)
    return 1
  }
}

async function runModels(flags: Flags, paths: ZcodePaths): Promise<number> {
  const config = loadConfigOrReport(configFile(flags, paths))
  if (!config) return 1
  try {
    const generation = await buildGeneration(config, { paths })
    const rows = generation.bindings.flatMap(binding => binding.plugins.flatMap(plugin => [...plugin.models.values()].map(model => ({
      binding: binding.spec.id, plugin: plugin.spec.id, id: model.alias, name: model.name, upstream: model.upstream,
      contextWindow: model.contextWindow ?? null, maxOutputTokens: model.maxOutputTokens ?? null,
      input: model.input, auth: plugin.authReadiness(),
    }))))
    if (flags.switches.has("--json")) console.log(JSON.stringify(rows, null, 2))
    else for (const row of rows) console.log(`${row.id}\t${row.name}\tcontext=${row.contextWindow ?? "?"}\toutput=${row.maxOutputTokens ?? "?"}\tinput=${row.input.join("+")}\tauth=${row.auth}\t(binding ${row.binding})`)
    return 0
  } catch (error) {
    printIssues(error)
    return 1
  }
}

async function promptLine(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(`${message} `)).trim()
  } finally {
    rl.close()
  }
}

async function collectPromptInputs(method: OpenCodeAuthMethod): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {}
  for (const prompt of method.prompts ?? []) {
    const label = prompt.type === "select" ? `${prompt.message} (${prompt.options.map(option => option.value).join(" | ")})` : prompt.message
    const value = await promptLine(`${label}:`)
    if (prompt.type === "text" && prompt.validate) {
      const problem = prompt.validate(value)
      if (problem) throw new Error(problem)
    }
    inputs[prompt.key] = value
  }
  return inputs
}

async function login(plugin: LoadedPlugin, preferred: string | undefined): Promise<OpenCodeAuth> {
  const methods = plugin.authHook?.methods ?? []
  const method = preferred ? methods.find(entry => entry.type === preferred) : methods[0]
  if (!method) throw new Error(preferred ? `plugin offers no "${preferred}" auth method` : "plugin offers no auth method")
  const inputs = await collectPromptInputs(method)
  if (method.type === "oauth") {
    const authorized = await method.authorize(inputs)
    console.error(`Open this URL to sign in:\n${authorized.url}`)
    if (authorized.instructions) console.error(authorized.instructions)
    const code = (authorized as { method?: unknown }).method === "code" ? await promptLine("Paste the authorization code:") : undefined
    const result = await authorized.callback(code)
    if (result.type !== "success") throw new Error("OAuth login failed")
    return openCodeAuthFromOAuthCallback(result)
  }
  if (!method.authorize) throw new Error("API-key method has no authorize()")
  const result = await method.authorize(inputs)
  if (result.type !== "success") throw new Error("API-key authorization failed")
  return { type: "api", key: result.key, ...(result.metadata ? { metadata: result.metadata } : {}) }
}

async function runAuth(flags: Flags, paths: ZcodePaths): Promise<number> {
  const config = loadConfigOrReport(configFile(flags, paths))
  if (!config) return 1
  const bindingId = flags.values.get("--binding")
  const pluginId = flags.values.get("--plugin")
  if (!bindingId || !pluginId) {
    console.error("ocp zcode auth needs --binding <id> and --plugin <id>")
    return 1
  }
  const binding = config.bindings.find(entry => entry.id === bindingId)
  const spec = binding?.plugins.find(entry => entry.id === pluginId)
  if (!binding || !spec) {
    console.error(`no plugin "${pluginId}" in binding "${bindingId}"`)
    return 1
  }
  try {
    const plugin = await loadPlugin(binding, spec, { paths })
    if (flags.switches.has("--logout")) {
      await plugin.authStore.remove()
      console.log(`logged out: binding ${bindingId} plugin ${pluginId}`)
      return 0
    }
    if (!plugin.authHook) {
      console.error(`plugin "${pluginId}" declares no auth hook; nothing to log in to`)
      return 1
    }
    const auth = await login(plugin, flags.values.get("--method"))
    // An explicit login always supersedes whatever generation is stored.
    await plugin.authStore.replace(auth)
    // Refresh the catalog (it may only appear after login), then validate the
    // credential through the plugin's own loader on the first served model.
    await plugin.refreshCatalog()
    const first = plugin.models.keys().next().value
    if (first !== undefined) {
      await plugin.withAuthOperation(async () => {
        await plugin.languageModel(first)
      })
    }
    console.log(`logged in: binding ${bindingId} plugin ${pluginId} (${auth.type})`)
    return 0
  } catch (error) {
    console.error(`auth failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function runInstall(flags: Flags, paths: ZcodePaths): number {
  const target = flags.positional[0]
  const match = target ? /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target) : null
  if (!match) {
    console.error("usage: ocp zcode install <package>@<exact-version>")
    return 1
  }
  mkdirSync(paths.installRoot, { recursive: true })
  const manifest = join(paths.installRoot, "package.json")
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: "ocp-zcode-plugins", private: true }, null, 2)}\n`)
  const result = spawnSync("bun", ["add", "--exact", target!], { cwd: paths.installRoot, stdio: "inherit" })
  if (result.status !== 0) return result.status ?? 1
  try {
    const resolved = resolveInstalledPackage(paths.installRoot, {
      id: "install", package: match[1]!, version: match[2]!, contract: "classic", models: "catalog",
    })
    console.log(`installed ${resolved.name}@${resolved.version}\nentry ${resolved.entry}\nsha256 ${resolved.sha256}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function runCredential(flags: Flags): number {
  const file = flags.values.get("--file")
  if (!file) {
    console.error("usage: ocp zcode credential --file <absolute path>")
    return 1
  }
  try {
    const value = writeCredentialFile(resolve(file))
    console.log(value)
    console.error(`wrote ${resolve(file)} (0600). Reference it as {"file": "${resolve(file)}"} and paste the value above into ZCode as the provider API key.`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function waitForSignal(server: BridgeServer, onReload?: () => Promise<void>): Promise<number> {
  return new Promise(resolvePromise => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown)
      process.off("SIGTERM", shutdown)
      if (onReload) process.off("SIGHUP", reload)
      await server.stop()
      resolvePromise(0)
    }
    const reload = () => void onReload?.()
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    if (onReload) process.on("SIGHUP", reload)
  })
}

async function runServe(flags: Flags, paths: ZcodePaths): Promise<number> {
  const file = configFile(flags, paths)
  const config = loadConfigOrReport(file)
  if (!config) return 1
  let generation: Generation
  try {
    generation = await buildGeneration(config, { paths })
  } catch (error) {
    printIssues(error)
    return 1
  }
  let server: BridgeServer
  try {
    server = startBridgeServer({ generation })
  } catch (error) {
    console.error(error instanceof ListenerConflictError ? error.message : String(error))
    return 1
  }
  // The serve log omits local paths; `check` shows them on request.
  for (const line of describeGeneration(generation, { paths: false })) console.error(line)
  console.error(`ocp-zcode ${OCP_VERSION} ready gen=${generation.id} listening ${server.url}`)
  console.error(TELEMETRY_NOTE)

  // Build each replacement fully and keep serving the old generation on any
  // failure. Reloads run one at a time; a signal during a reload schedules one
  // more pass, which rereads the file, so the newest configuration publishes last.
  const reloadOnce = async () => {
    const next = loadConfigOrReport(file)
    if (!next) return
    const fixed = (value: ZcodeBridgeConfig) => JSON.stringify([value.listen, value.limits.maxBodyBytes, value.limits.maxSessions])
    if (fixed(next) !== fixed(config)) {
      console.error("reload rejected: listen, limits.maxBodyBytes and limits.maxSessions changes need a restart")
      return
    }
    try {
      const built = await buildGeneration(next, { paths })
      server.publish(built)
      console.error(`ocp-zcode reloaded gen=${built.id}`)
    } catch (error) {
      console.error("reload rejected; previous generation keeps serving")
      printIssues(error)
    }
  }
  return waitForSignal(server, coalescingRunner(reloadOnce))
}

/**
 * Run `task` one at a time. A call while it runs schedules exactly one more
 * pass after it, so the last trigger is always followed by a complete run.
 */
export function coalescingRunner(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined
  let again = false
  return () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await task()
        } while (again)
      } finally {
        running = undefined
      }
    })()
    return running
  }
}

async function runProbe(flags: Flags, paths: ZcodePaths): Promise<number> {
  const port = Number(flags.values.get("--port") ?? "18731")
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error("--port must be an integer between 1 and 65535")
    return 1
  }
  const file = createProbeFile()
  const model = createProbeModel(file)
  const credential = `ocpz_probe_${crypto.randomUUID().replaceAll("-", "")}`
  const transcriptFile = resolve(flags.values.get("--transcript") ?? join(paths.stateDir, `probe-${Date.now()}.jsonl`))
  mkdirSync(resolve(transcriptFile, ".."), { recursive: true, mode: 0o700 })
  // The probe binding has no plugin; its only route is the static probe model.
  const config: ZcodeBridgeConfig = {
    version: 1,
    listen: { host: "127.0.0.1", port },
    limits: DEFAULT_LIMITS,
    bindings: [{ id: "probe", workspace: resolve(file.path, ".."), credentials: { model: { env: "OCP_ZCODE_PROBE_CREDENTIAL" } }, plugins: [] }],
  }
  const transcript = createTranscript(transcriptFile, {
    ocpVersion: OCP_VERSION, platform: process.platform, arch: process.arch, port, callId: model.callId,
  })
  const generation = await buildGeneration(config, {
    paths,
    env: { OCP_ZCODE_PROBE_CREDENTIAL: credential },
    staticRoutes: new Map([["probe", [{ info: PROBE_MODEL_INFO, languageModel: async () => model }]]]),
  })
  let server: BridgeServer
  try {
    server = startBridgeServer({
      generation,
      observer: record => transcript.record(record, { verdicts: [...model.verdicts] }),
    })
  } catch (error) {
    console.error(error instanceof ListenerConflictError ? error.message : String(error))
    return 1
  }
  console.log(`ZCode Personal provider: format Anthropic Messages, base URL ${server.url}`)
  console.log(`API key: ${credential}`)
  console.log(`Model ID: ${PROBE_MODEL_ALIAS}`)
  console.log(`Then send any message (expect OCP-PROBE-TEXT), and one containing "${PROBE_READ_TRIGGER}" (expect a native Read, then OCP-PROBE-OK).`)
  console.log(`Transcript (private): ${transcriptFile}`)
  console.log("Stop with Ctrl-C.")
  return waitForSignal(server)
}

export async function runZcodeCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = args
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(ZCODE_HELP)
    return sub ? 0 : 1
  }
  let flags: Flags
  try {
    flags = parseFlags(rest)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const paths = zcodePaths(env)
  try {
    switch (sub) {
      case "check": return await runCheck(flags, paths)
      case "models": return await runModels(flags, paths)
      case "auth": return await runAuth(flags, paths)
      case "install": return runInstall(flags, paths)
      case "credential": return runCredential(flags)
      case "serve": return await runServe(flags, paths)
      case "probe": return await runProbe(flags, paths)
      default:
        console.error(`unknown zcode command: ${sub}\n`)
        console.log(ZCODE_HELP)
        return 1
    }
  } catch (error) {
    console.error(error instanceof ZcodeConfigError ? error.message : `ocp zcode ${sub} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
