import {
  DRAFTS,
  unknownProfile,
  type HostId,
  type HostProfile,
} from "@opencode-compat/profile"
import { aliasResolvePlugin } from "./alias.ts"
import { classicAuthOauthShape, classicChatParams, classicConfigMutate, classicToolBeforeAfter } from "./classic.ts"
import { localDotOpencodeScan } from "./local.ts"
import type { Fixture, FixtureContext, FixtureResult } from "./types.ts"
import { v2AisdkLanguage, v2UnsupportedDomain } from "./v2.ts"
import { zcodeT0Doctor } from "./zcode.ts"

/** All OCP §10 conformance fixtures. */
export const FIXTURES: Fixture[] = [
  classicAuthOauthShape,
  classicConfigMutate,
  classicToolBeforeAfter,
  classicChatParams,
  aliasResolvePlugin,
  localDotOpencodeScan,
  v2AisdkLanguage,
  v2UnsupportedDomain,
  zcodeT0Doctor,
]

export const MATRIX_HOSTS: HostId[] = ["opencode", "mimo", "kilo", "zcode"]

export type RunMatrixOptions = {
  hosts?: HostId[]
  fixtureIds?: string[]
  compatScanEnabled?: boolean | Partial<Record<HostId, boolean>>
  profileFor?: (host: HostId) => HostProfile
}

function resolveProfile(host: HostId, profileFor?: RunMatrixOptions["profileFor"]): HostProfile {
  if (profileFor) return profileFor(host)
  if (host === "unknown") return unknownProfile({ home: "/tmp/ocp-fixture", env: {} })
  return DRAFTS[host]({ home: "/tmp/ocp-fixture", env: {} })
}

function compatEnabled(
  host: HostId,
  option: RunMatrixOptions["compatScanEnabled"],
): boolean {
  if (option === undefined) return false
  if (typeof option === "boolean") return option
  return option[host] ?? false
}

export async function runFixture(
  fixture: Fixture,
  ctx: FixtureContext,
): Promise<FixtureResult> {
  try {
    return await fixture.run(ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: fixture.id,
      tier: fixture.tier,
      host: ctx.host,
      status: "fail",
      message: `fixture threw: ${message}`,
    }
  }
}

/** Run Plugin×Host×Tier matrix (OCP §10). */
export async function runMatrix(
  options: RunMatrixOptions = {},
): Promise<FixtureResult[]> {
  const hosts = options.hosts ?? MATRIX_HOSTS
  const fixtures = options.fixtureIds
    ? FIXTURES.filter((f) => options.fixtureIds!.includes(f.id))
    : FIXTURES
  const results: FixtureResult[] = []
  for (const host of hosts) {
    const profile = resolveProfile(host, options.profileFor)
    const ctx: FixtureContext = {
      host,
      profile,
      compatScanEnabled: compatEnabled(host, options.compatScanEnabled),
    }
    for (const fixture of fixtures) {
      results.push(await runFixture(fixture, ctx))
    }
  }
  return results
}

export function formatMatrix(results: FixtureResult[]): string {
  const header = ["fixture", "tier", "host", "status", "message"].join("\t")
  const rows = results.map((r) =>
    [r.id, r.tier, r.host, r.status, r.message.replace(/\t/g, " ")].join("\t"),
  )
  const counts = {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
  }
  return [header, ...rows, "", `pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`].join(
    "\n",
  )
}

export function matrixOk(results: FixtureResult[]): boolean {
  return results.every((r) => r.status !== "fail")
}

export type * from "./types.ts"
export { FIXTURES as fixtures }
