/**
 * @opencode-compat/cli — `compat doctor` + matrix runner.
 */
export const PKG = "@opencode-compat/cli" as const
export const VERSION = "0.1.0" as const

import { doctorReport } from "@opencode-compat/adapter"
import {
  facadeOverrideSnippet,
  type DetectOptions,
  type HostId,
} from "@opencode-compat/profile"

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
  /** When true, treat mimo/kilo compatProjectDirs dual-scan as landed. */
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
  console.log(`opencode-compat — OCP doctor + matrix

Usage:
  opencode-compat doctor [--host opencode|mimo|kilo|zcode]
  opencode-compat overrides
  opencode-compat matrix [--host <id>]... [--fixture <id>]... [--compat-scan]

Commands:
  doctor      Detect host and print capability summary
  overrides   Print suggested install-time facade override JSON
  matrix      Run OCP §10 Plugin×Host×Tier conformance fixtures
`)
}

const HOST_IDS = new Set<string>(["opencode", "mimo", "kilo", "zcode", "unknown"])

function parseArgs(argv: string[]): {
  command: string
  host?: string
  hosts: HostId[]
  fixtures: string[]
  compatScan: boolean
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
  return { command, host, hosts, fixtures, compatScan }
}

export async function mainAsync(argv: string[] = process.argv): Promise<number> {
  const { command, host, hosts, fixtures, compatScan } = parseArgs(argv)

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return 0
  }
  if (command === "overrides") {
    console.log(facadeOverrideSnippet())
    return 0
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
  if (command === "matrix") {
    console.error("matrix requires async entry — use: opencode-compat matrix")
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
