/**
 * @opencode-compat/cli — `compat doctor` + matrix + migrate-zcode companion.
 */
export const PKG = "@opencode-compat/cli" as const
export const VERSION = "0.1.0" as const

import { doctorReport } from "@opencode-compat/adapter"
import {
  migrateZcode,
  migrateZcodeMarketplace,
  type MigrateMarketplaceReport,
  type MigrateReport,
} from "@opencode-compat/migrate-zcode"
import {
  facadeOverrideSnippet,
  type DetectOptions,
  type HostId,
} from "@opencode-compat/profile"
import { resolve } from "node:path"

export type DoctorResult = {
  ok: boolean
  message: string
  host?: string
  source?: string
}

/** Run OCP compat doctor against the current (or injected) environment. */
export function doctor(options?: DetectOptions): DoctorResult {
  const report = doctorReport(options)
  const { result } = report
  if (!result.supported) {
    return {
      ok: false,
      message: result.message ?? report.summary,
      host: result.id,
      source: result.source,
    }
  }
  return {
    ok: true,
    message: report.summary,
    host: result.id,
    source: result.source,
  }
}

export type MatrixCliOptions = {
  hosts?: HostId[]
  fixtureIds?: string[]
  /** When true, exercise mimo/kilo compatProjectDirs expectations (operator/docs path). */
  compatScan?: boolean
}

export type MatrixCell = {
  id: string
  tier: string
  host: HostId
  status: "pass" | "fail" | "skip"
  message: string
  detail?: string
}

type FixturesApi = {
  runMatrix: (options?: {
    hosts?: HostId[]
    fixtureIds?: string[]
    compatScanEnabled?: boolean | Partial<Record<HostId, boolean>>
  }) => Promise<MatrixCell[]>
  formatMatrix: (results: MatrixCell[]) => string
  matrixOk: (results: MatrixCell[]) => boolean
}

/** Resolve monorepo fixtures (CLI matrix is a checkout-rooted command). */
export async function loadFixtures(): Promise<FixturesApi> {
  const url = new URL("../../../fixtures/index.ts", import.meta.url)
  return (await import(url.href)) as FixturesApi
}

/** Run Plugin×Host×Tier matrix via fixtures/ (OCP §10). */
export async function matrix(
  options: MatrixCliOptions = {},
): Promise<MatrixCell[]> {
  const fixtures = await loadFixtures()
  return fixtures.runMatrix({
    hosts: options.hosts,
    fixtureIds: options.fixtureIds,
    compatScanEnabled: options.compatScan ? true : undefined,
  })
}

function printHelp(): void {
  console.log(`opencode-compat — OCP doctor + matrix + companions

Usage:
  opencode-compat doctor [--host opencode|mimo|kilo|zcode]
  opencode-compat overrides
  opencode-compat matrix [--host <id>]... [--fixture <id>]... [--compat-scan]
  opencode-compat migrate-zcode --plugin <dir> [--out <dir>] [options]
  opencode-compat migrate-zcode --plugin <dir> [--plugin <dir>...] \\
    --marketplace-name <name> --out <dir> [options]

Commands:
  doctor           Detect host and print capability summary
  overrides        Print suggested install-time facade override JSON
  matrix           Run OCP §10 Plugin×Host×Tier conformance fixtures
  migrate-zcode    Companion: pack plugin skills/commands/manifests → .zcode-plugin
                   (not OCP ABI; ZCode stays T0; does not migrate host MCP)

migrate-zcode options:
  --plugin <dir>                 Plugin package root (repeatable; required)
  --out <dir>                    Output directory (required unless --dry-run)
  --name <name>                  Override plugin.json name (single-plugin mode)
  --version <ver>                Override plugin.json version (single-plugin mode)
  --marketplace-name <name>      Wrap plugin(s) into a multi-plugin marketplace tree
  --marketplace-description <t>  Catalog description
  --owner-name <name>            Catalog owner.name
  --owner-url <url>              Catalog owner.url
  --dry-run                      Scan/report only; do not write
  --allow-empty                  Succeed when no marketplace assets found
  --format text|json             Report format (default: text)
`)
}

const HOST_IDS = new Set<string>(["opencode", "mimo", "kilo", "zcode", "unknown"])

function parseArgs(argv: string[]): {
  command: string
  host?: string
  hosts: HostId[]
  fixtures: string[]
  compatScan: boolean
  migrateRest: string[]
} {
  const [, , command = "doctor", ...rest] = argv
  let host: string | undefined
  const hosts: HostId[] = []
  const fixtures: string[] = []
  let compatScan = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--host") {
      const value = rest[++i]
      host = value
      if (value && HOST_IDS.has(value)) hosts.push(value as HostId)
    } else if (arg?.startsWith("--host=")) {
      const value = arg.slice("--host=".length)
      host = value
      if (HOST_IDS.has(value)) hosts.push(value as HostId)
    } else if (arg === "--fixture") {
      const value = rest[++i]
      if (value) fixtures.push(value)
    } else if (arg?.startsWith("--fixture=")) {
      fixtures.push(arg.slice("--fixture=".length))
    } else if (arg === "--compat-scan") {
      compatScan = true
    }
  }
  return { command, host, hosts, fixtures, compatScan, migrateRest: rest }
}

export type MigrateZcodeCliOptions = {
  plugins: string[]
  out?: string
  name?: string
  version?: string
  marketplaceName?: string
  marketplaceDescription?: string
  ownerName?: string
  ownerUrl?: string
  dryRun: boolean
  allowEmpty: boolean
  format: "text" | "json"
  help: boolean
}

export function parseMigrateZcodeArgs(rest: string[]): MigrateZcodeCliOptions {
  const opts: MigrateZcodeCliOptions = {
    plugins: [],
    dryRun: false,
    allowEmpty: false,
    format: "text",
    help: false,
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--help" || arg === "-h") opts.help = true
    else if (arg === "--plugin") {
      const value = rest[++i]
      if (value) opts.plugins.push(value)
    } else if (arg?.startsWith("--plugin=")) {
      opts.plugins.push(arg.slice("--plugin=".length))
    } else if (arg === "--out") opts.out = rest[++i]
    else if (arg?.startsWith("--out=")) opts.out = arg.slice("--out=".length)
    else if (arg === "--name") opts.name = rest[++i]
    else if (arg?.startsWith("--name=")) opts.name = arg.slice("--name=".length)
    else if (arg === "--version") opts.version = rest[++i]
    else if (arg?.startsWith("--version=")) {
      opts.version = arg.slice("--version=".length)
    } else if (arg === "--marketplace-name") opts.marketplaceName = rest[++i]
    else if (arg?.startsWith("--marketplace-name=")) {
      opts.marketplaceName = arg.slice("--marketplace-name=".length)
    } else if (arg === "--marketplace-description") {
      opts.marketplaceDescription = rest[++i]
    } else if (arg?.startsWith("--marketplace-description=")) {
      opts.marketplaceDescription = arg.slice(
        "--marketplace-description=".length,
      )
    } else if (arg === "--owner-name") opts.ownerName = rest[++i]
    else if (arg?.startsWith("--owner-name=")) {
      opts.ownerName = arg.slice("--owner-name=".length)
    } else if (arg === "--owner-url") opts.ownerUrl = rest[++i]
    else if (arg?.startsWith("--owner-url=")) {
      opts.ownerUrl = arg.slice("--owner-url=".length)
    } else if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--allow-empty") opts.allowEmpty = true
    else if (arg === "--format") {
      const value = rest[++i]
      if (value === "json" || value === "text") opts.format = value
    } else if (arg?.startsWith("--format=")) {
      const value = arg.slice("--format=".length)
      if (value === "json" || value === "text") opts.format = value
    }
  }
  return opts
}

function formatMigrateText(report: MigrateReport): string {
  const lines = [
    `migrate-zcode: ${report.ok ? "ok" : "failed"}`,
    `pluginDir: ${report.pluginDir}`,
    report.outDir ? `outDir: ${report.outDir}` : undefined,
    `skills: ${report.included.skills.length}`,
    ...report.included.skills.map((s) => `  + ${s}`),
    `commands: ${report.included.commands.length}`,
    ...report.included.commands.map((c) => `  + ${c}`),
    `manifests: ${report.included.manifests.length}`,
    ...report.included.manifests.map((m) => `  + ${m}`),
    `skipped: ${report.skipped.length}`,
    ...report.skipped.map((s) => `  - ${s.reason} (${s.path})`),
    `warnings: ${report.warnings.length}`,
    ...report.warnings.map((w) => `  ! ${w}`),
    "",
    "Note: not OCP ABI. ZCode stays T0. Host MCP is not migrated.",
  ]
  return lines.filter((l): l is string => l !== undefined).join("\n")
}

function formatMarketplaceText(report: MigrateMarketplaceReport): string {
  const lines = [
    `migrate-zcode marketplace: ${report.ok ? "ok" : "failed"}`,
    `marketplace: ${report.marketplaceName}`,
    report.outDir ? `outDir: ${report.outDir}` : undefined,
    `plugins: ${report.plugins.length}`,
    ...report.plugins.map((p) => `  + ${p.name} (${p.source})`),
    `pluginDirs: ${report.pluginDirs.length}`,
    ...report.pluginDirs.map((d) => `  * ${d}`),
    `skipped: ${report.skipped.length}`,
    ...report.skipped.map((s) => `  - ${s.reason} (${s.path})`),
    `warnings: ${report.warnings.length}`,
    ...report.warnings.map((w) => `  ! ${w}`),
    "",
    "Note: not OCP ABI. ZCode stays T0. Host MCP is not migrated.",
  ]
  return lines.filter((l): l is string => l !== undefined).join("\n")
}

/** Exit: 0 ok, 1 error/collision, 2 empty without allowEmpty. */
export function migrateZcodeExitCode(
  report: MigrateReport | MigrateMarketplaceReport,
): number {
  if (report.ok) return 0
  if (
    report.warnings.some(
      (w) =>
        w.startsWith("empty-migration:") || w.startsWith("empty-marketplace:"),
    )
  ) {
    return 2
  }
  return 1
}

export async function runMigrateZcodeCli(rest: string[]): Promise<number> {
  const opts = parseMigrateZcodeArgs(rest)
  if (opts.help) {
    printHelp()
    return 0
  }
  if (opts.plugins.length === 0) {
    console.error("migrate-zcode: --plugin <dir> is required")
    printHelp()
    return 1
  }
  if (!opts.dryRun && !opts.out?.trim()) {
    console.error("migrate-zcode: --out <dir> is required unless --dry-run")
    return 1
  }

  const marketplaceMode =
    Boolean(opts.marketplaceName?.trim()) || opts.plugins.length > 1

  if (opts.plugins.length > 1 && !opts.marketplaceName?.trim()) {
    console.error(
      "migrate-zcode: multiple --plugin values require --marketplace-name",
    )
    return 1
  }

  try {
    if (marketplaceMode) {
      const result = await migrateZcodeMarketplace({
        pluginDirs: opts.plugins.map((p) => resolve(p)),
        outDir: opts.out ? resolve(opts.out) : undefined,
        marketplaceName: opts.marketplaceName!.trim(),
        marketplaceDescription: opts.marketplaceDescription,
        ownerName: opts.ownerName,
        ownerUrl: opts.ownerUrl,
        dryRun: opts.dryRun || !opts.out,
        allowEmpty: opts.allowEmpty,
      })
      if (opts.format === "json") {
        console.log(JSON.stringify(result.report, null, 2))
      } else {
        console.log(formatMarketplaceText(result.report))
      }
      return migrateZcodeExitCode(result.report)
    }

    const result = await migrateZcode({
      pluginDir: resolve(opts.plugins[0]!),
      outDir: opts.out ? resolve(opts.out) : undefined,
      name: opts.name,
      version: opts.version,
      dryRun: opts.dryRun || !opts.out,
      allowEmpty: opts.allowEmpty,
    })
    if (opts.format === "json") {
      console.log(JSON.stringify(result.report, null, 2))
    } else {
      console.log(formatMigrateText(result.report))
    }
    return migrateZcodeExitCode(result.report)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`migrate-zcode failed: ${message}`)
    return 1
  }
}

export async function mainAsync(argv: string[] = process.argv): Promise<number> {
  const { command, host, hosts, fixtures, compatScan, migrateRest } =
    parseArgs(argv)

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return 0
  }
  if (command === "overrides") {
    console.log(facadeOverrideSnippet())
    return 0
  }
  if (command === "migrate-zcode") {
    return runMigrateZcodeCli(migrateRest)
  }
  if (command === "matrix") {
    try {
      const mod = await loadFixtures()
      const results = await mod.runMatrix({
        hosts: hosts.length > 0 ? hosts : undefined,
        fixtureIds: fixtures.length > 0 ? fixtures : undefined,
        compatScanEnabled: compatScan ? true : undefined,
      })
      console.log(mod.formatMatrix(results))
      return mod.matrixOk(results) ? 0 : 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`matrix failed: ${message}`)
      console.error(
        "(matrix expects a monorepo checkout with fixtures/ next to packages/)",
      )
      return 1
    }
  }
  if (command !== "doctor") {
    console.error(`Unknown command: ${command}`)
    printHelp()
    return 1
  }

  const env = host
    ? { ...process.env, OPENCODE_COMPAT_HOST: host }
    : process.env
  const result = doctor({ env })
  console.log(result.message)
  if (result.host) {
    console.log(
      `\n(exit: ${result.ok ? "ok" : "unsupported"} host=${result.host} source=${result.source})`,
    )
  }
  return result.ok ? 0 : 1
}

/** Sync entry for doctor / overrides / help (used by unit tests). */
export function main(argv: string[] = process.argv): number {
  const { command, host } = parseArgs(argv)
  if (command === "matrix" || command === "migrate-zcode") {
    console.error(
      `${command} requires async entry — use: opencode-compat ${command}`,
    )
    return 1
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return 0
  }
  if (command === "overrides") {
    console.log(facadeOverrideSnippet())
    return 0
  }
  if (command !== "doctor") {
    console.error(`Unknown command: ${command}`)
    printHelp()
    return 1
  }
  const env = host
    ? { ...process.env, OPENCODE_COMPAT_HOST: host }
    : process.env
  const result = doctor({ env })
  console.log(result.message)
  if (result.host) {
    console.log(
      `\n(exit: ${result.ok ? "ok" : "unsupported"} host=${result.host} source=${result.source})`,
    )
  }
  return result.ok ? 0 : 1
}