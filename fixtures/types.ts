import type { HostId, HostProfile } from "@opencode-compat/profile"

export type FixtureTier = "T0" | "T1" | "T2" | "T3"

export type FixtureStatus = "pass" | "fail" | "skip"

export type FixtureResult = {
  id: string
  tier: FixtureTier
  host: HostId
  status: FixtureStatus
  message: string
  detail?: string
}

export type FixtureContext = {
  host: HostId
  profile: HostProfile
  /** When true, exercise compatProjectDirs expectations (operator/docs path). */
  compatScanEnabled?: boolean
}

export type Fixture = {
  id: string
  tier: FixtureTier
  description: string
  run(ctx: FixtureContext): Promise<FixtureResult> | FixtureResult
}

export function pass(
  fixture: Pick<Fixture, "id" | "tier">,
  host: HostId,
  message: string,
  detail?: string,
): FixtureResult {
  return { id: fixture.id, tier: fixture.tier, host, status: "pass", message, detail }
}

export function fail(
  fixture: Pick<Fixture, "id" | "tier">,
  host: HostId,
  message: string,
  detail?: string,
): FixtureResult {
  return { id: fixture.id, tier: fixture.tier, host, status: "fail", message, detail }
}

export function skip(
  fixture: Pick<Fixture, "id" | "tier">,
  host: HostId,
  message: string,
  detail?: string,
): FixtureResult {
  return { id: fixture.id, tier: fixture.tier, host, status: "skip", message, detail }
}