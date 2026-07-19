import { existsSync as nodeExistsSync } from "node:fs"
import { basename } from "node:path"
import {
  DRAFTS,
  kiloProfile,
  mimoProfile,
  opencodeProfile,
  unknownProfile,
  zcodeProfile,
} from "./drafts"
import { unknownDoctorMessage, zcodeDoctorMessage } from "./doctor"
import type {
  DetectOptions,
  DetectResult,
  DetectSource,
  HostId,
  HostProfile,
} from "./types"

const HOST_IDS = ["opencode", "mimo", "kilo", "zcode"] as const

function isHostId(value: string): value is Exclude<HostId, "unknown"> {
  return (HOST_IDS as readonly string[]).includes(value)
}

function profileFor(
  id: Exclude<HostId, "unknown">,
  options: DetectOptions,
): HostProfile {
  const draft = DRAFTS[id]
  return draft({ env: options.env, home: options.home })
}

function result(
  id: HostId,
  profile: HostProfile,
  source: DetectSource,
  supported: boolean,
  message?: string,
): DetectResult {
  return { id, profile, source, supported, message }
}

function binaryHint(
  options: DetectOptions,
): Exclude<HostId, "unknown"> | undefined {
  const argv = options.argv ?? process.argv
  const execPath = options.execPath ?? process.execPath
  const tokens = [
    ...argv.map((a) => basename(a).toLowerCase()),
    basename(execPath).toLowerCase(),
  ]
  for (const token of tokens) {
    if (
      token === "mimo" ||
      token === "mimocode" ||
      token.startsWith("mimo-") ||
      token.includes("mimocode")
    ) {
      return "mimo"
    }
    if (
      token === "kilo" ||
      token === "kilocode" ||
      token.startsWith("kilo-") ||
      token.includes("kilocode")
    ) {
      return "kilo"
    }
    if (
      token === "zcode" ||
      token.startsWith("zcode-") ||
      token.includes("zcode")
    ) {
      return "zcode"
    }
    if (
      token === "opencode" ||
      token.startsWith("opencode-") ||
      token.includes("opencode")
    ) {
      return "opencode"
    }
  }
  return undefined
}

function envPrefixHint(
  env: NodeJS.ProcessEnv,
): Exclude<HostId, "unknown"> | undefined {
  // Strong host-specific prefixes first (avoid OPENCODE_* false positives from compat tooling).
  if (hasPrefix(env, "MIMOCODE_")) return "mimo"
  if (hasPrefix(env, "KILO_")) return "kilo"
  if (hasPrefix(env, "ZCODE_")) return "zcode"
  // OPENCODE_* alone is weak — only count when not also running under compat tooling only.
  // Prefer config/binary for OpenCode; still allow OPENCODE_CONFIG_DIR as a hint.
  if (env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG) return "opencode"
  return undefined
}

function hasPrefix(env: NodeJS.ProcessEnv, prefix: string): boolean {
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix) && env[key]) return true
  }
  return false
}

function configDirHint(
  options: DetectOptions,
): Exclude<HostId, "unknown"> | undefined {
  const exists = options.existsSync ?? nodeExistsSync
  const drafts: Array<{ id: Exclude<HostId, "unknown">; dir: string }> = [
    { id: "kilo", dir: kiloProfile(options).paths.configDir },
    { id: "mimo", dir: mimoProfile(options).paths.configDir },
    { id: "opencode", dir: opencodeProfile(options).paths.configDir },
    { id: "zcode", dir: zcodeProfile(options).paths.configDir },
  ]
  // Prefer more specific fork dirs before OpenCode when multiple exist.
  const order: Exclude<HostId, "unknown">[] = [
    "kilo",
    "mimo",
    "zcode",
    "opencode",
  ]
  for (const id of order) {
    const entry = drafts.find((d) => d.id === id)
    if (entry && exists(entry.dir)) return id
  }
  return undefined
}

/**
 * Detect the current OCP host.
 *
 * Order (docs/ocp/0.1.md §5.1):
 * 1. `OPENCODE_COMPAT_HOST`
 * 2. Native binary / package identity
 * 3. Config-dir heuristics
 * 4. `zcode` → refuse OCP load (T0 doctor)
 * 5. `unknown` → fail with doctor
 */
export function detect(options: DetectOptions = {}): DetectResult {
  const env = options.env ?? process.env
  const opts: DetectOptions = { ...options, env }

  const forced = env.OPENCODE_COMPAT_HOST?.trim().toLowerCase()
  if (forced) {
    if (forced === "unknown") {
      const profile = unknownProfile(opts)
      return result("unknown", profile, "env", false, unknownDoctorMessage())
    }
    if (isHostId(forced)) {
      const profile = profileFor(forced, opts)
      if (forced === "zcode") {
        return result("zcode", profile, "env", false, zcodeDoctorMessage())
      }
      return result(forced, profile, "env", true)
    }
    const profile = unknownProfile(opts)
    return result(
      "unknown",
      profile,
      "env",
      false,
      `OCP: invalid OPENCODE_COMPAT_HOST=${JSON.stringify(forced)}. Expected opencode|mimo|kilo|zcode.`,
    )
  }

  const fromPackage = opts.resolveNative?.()
  if (fromPackage && fromPackage !== "unknown") {
    if (isHostId(fromPackage)) {
      const profile = profileFor(fromPackage, opts)
      if (fromPackage === "zcode") {
        return result("zcode", profile, "package", false, zcodeDoctorMessage())
      }
      return result(fromPackage, profile, "package", true)
    }
  }

  const fromBinary = binaryHint(opts)
  if (fromBinary === "zcode") {
    return result(
      "zcode",
      zcodeProfile(opts),
      "binary",
      false,
      zcodeDoctorMessage(),
    )
  }
  if (fromBinary) {
    return result(fromBinary, profileFor(fromBinary, opts), "binary", true)
  }

  const fromEnvPrefix = envPrefixHint(env)
  if (fromEnvPrefix) {
    if (fromEnvPrefix === "zcode") {
      return result(
        "zcode",
        zcodeProfile(opts),
        "env",
        false,
        zcodeDoctorMessage(),
      )
    }
    return result(
      fromEnvPrefix,
      profileFor(fromEnvPrefix, opts),
      "env",
      true,
    )
  }

  const fromConfig = configDirHint(opts)
  if (fromConfig) {
    if (fromConfig === "zcode") {
      return result(
        "zcode",
        zcodeProfile(opts),
        "config",
        false,
        zcodeDoctorMessage(),
      )
    }
    return result(fromConfig, profileFor(fromConfig, opts), "config", true)
  }

  const profile = unknownProfile(opts)
  return result("unknown", profile, "fallback", false, unknownDoctorMessage())
}