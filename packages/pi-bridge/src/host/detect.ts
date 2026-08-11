/**
 * Which Pi-family host is this process? Detection is by probing which host's
 * `pi-ai` package actually resolves — the one thing that is unambiguously true
 * of the running host and cannot be faked by a stale config dir.
 */
import { PI_HOST_PROFILES, profileFor, type PiHostId, type PiHostProfile } from "./profile.js"

export type PiHostDetection = {
  profile: PiHostProfile
  /** How the host was identified. `env` = PI_BRIDGE_HOST override. */
  source: "env" | "probe"
}

function isPiHostId(value: string): value is PiHostId {
  return value in PI_HOST_PROFILES
}

/** Probe order: both are equally valid; omp first only because it is the more common install. */
const PROBE_ORDER: readonly PiHostId[] = ["omp", "pi"]

export type ModuleProbe = (specifier: string) => Promise<unknown>

const defaultProbe: ModuleProbe = specifier => import(specifier)

let cached: Promise<PiHostDetection> | undefined

/**
 * Resolve the running host. Cached per process — the answer cannot change
 * within one session, and probing imports the host's package graph.
 *
 * `PI_BRIDGE_HOST=omp|pi` forces a host, for dev against a checkout where
 * both packages happen to resolve.
 */
export function detectPiHost(options: { env?: NodeJS.ProcessEnv; probe?: ModuleProbe; fresh?: boolean } = {}): Promise<PiHostDetection> {
  if (cached && !options.fresh) return cached
  const detection = (async (): Promise<PiHostDetection> => {
    const env = options.env ?? process.env
    const probe = options.probe ?? defaultProbe

    const forced = env.PI_BRIDGE_HOST?.trim()
    if (forced) {
      if (!isPiHostId(forced)) {
        throw new Error(`pi-bridge: PI_BRIDGE_HOST="${forced}" is not a known host (expected: ${Object.keys(PI_HOST_PROFILES).join(", ")})`)
      }
      return { profile: profileFor(forced), source: "env" }
    }

    const failures: string[] = []
    for (const id of PROBE_ORDER) {
      const profile = profileFor(id)
      try {
        await probe(profile.aiPackage)
        return { profile, source: "probe" }
      } catch (err) {
        failures.push(`${profile.aiPackage}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    throw new Error(
      `pi-bridge: no Pi-family host detected — neither ${PROBE_ORDER.map(id => profileFor(id).aiPackage).join(" nor ")} could be imported. ` +
        `This package must run inside oh-my-pi or pi (or set PI_BRIDGE_HOST). Probe failures:\n  ${failures.join("\n  ")}`,
    )
  })()
  if (!options.fresh) cached = detection
  return detection
}

/** Test seam: drop the per-process detection cache. */
export function resetPiHostDetection(): void {
  cached = undefined
}
