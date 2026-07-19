import { homedir } from "node:os"
import { join } from "node:path"
import {
  CORE_HOOKS,
  MIMO_EXTENSION_HOOKS,
  MIMO_MISSING_HOOKS,
} from "./hooks"
import { resolveXdgDirs, type PathEnv } from "./paths"
import type { HostProfile } from "./types"

export type DraftOptions = {
  env?: PathEnv
  home?: string
}

function baseOpts(options?: DraftOptions): {
  env: PathEnv
  home: string
} {
  const env = options?.env ?? process.env
  const home = options?.home ?? env.HOME ?? homedir()
  return { env, home }
}

/** OpenCode reference host — full OCP surface. */
export function opencodeProfile(options?: DraftOptions): HostProfile {
  const { env, home } = baseOpts(options)
  const configOverride = env.OPENCODE_CONFIG_DIR
  const xdg = resolveXdgDirs("opencode", env, home)
  return {
    id: "opencode",
    ocpVersion: "0.1.0",
    nativePlugin: "@opencode-ai/plugin",
    nativeSdk: "@opencode-ai/sdk",
    pluginVersionObserved: "1.18.3",
    paths: {
      configDir: configOverride && configOverride.length > 0 ? configOverride : xdg.configDir,
      dataDir: xdg.dataDir,
      cacheDir: xdg.cacheDir,
      projectDirs: [".opencode"],
      pluginInstallDir: join(xdg.cacheDir, "packages"),
    },
    configFiles: ["opencode.json", "opencode.jsonc"],
    envPrefix: "OPENCODE",
    capabilities: {
      classicHooks: true,
      promiseV2: true,
      effectV2: true,
      aisdkProviderHooks: true,
      localPluginScan: true,
      scansDotOpencode: true,
    },
    hooks: {
      core: CORE_HOOKS,
      missing: [],
      extensions: [],
    },
  }
}

/**
 * MiMo Code — classic T1 target; Promise v2 requires host kit embed.
 * Missing: dispose, experimental.provider.small_model (no-op + doctor).
 */
export function mimoProfile(options?: DraftOptions): HostProfile {
  const { env, home } = baseOpts(options)
  const mimoHome = env.MIMOCODE_HOME
  let configDir: string
  let dataDir: string
  let cacheDir: string
  if (mimoHome && mimoHome.length > 0) {
    configDir = join(mimoHome, "config")
    dataDir = join(mimoHome, "share")
    cacheDir = join(mimoHome, "cache")
  } else {
    const xdg = resolveXdgDirs("mimocode", env, home)
    configDir = xdg.configDir
    dataDir = xdg.dataDir
    cacheDir = xdg.cacheDir
  }
  return {
    id: "mimo",
    ocpVersion: "0.1.0",
    nativePlugin: "@mimo-ai/plugin",
    nativeSdk: "@mimo-ai/sdk",
    pluginVersionObserved: "0.1.6",
    paths: {
      configDir,
      dataDir,
      cacheDir,
      projectDirs: [".mimocode"],
      compatProjectDirs: [".opencode"],
      pluginInstallDir: join(cacheDir, "packages"),
    },
    configFiles: ["mimocode.json", "mimocode.jsonc"],
    envPrefix: "MIMOCODE",
    capabilities: {
      classicHooks: true,
      promiseV2: false,
      effectV2: false,
      aisdkProviderHooks: false,
      localPluginScan: true,
      scansDotOpencode: false,
    },
    hooks: {
      core: CORE_HOOKS,
      missing: MIMO_MISSING_HOOKS,
      extensions: MIMO_EXTENSION_HOOKS,
    },
    note: "PluginInput still types createOpencodeClient from @mimo-ai/sdk (residual name)",
  }
}

/**
 * Kilo Code — classic Hooks key-identical to OpenCode 1.18.3.
 * No project `.opencode` scan today; dual-scan needs M1 PR.
 */
export function kiloProfile(options?: DraftOptions): HostProfile {
  const { env, home } = baseOpts(options)
  const configOverride = env.KILO_CONFIG_DIR
  const xdg = resolveXdgDirs("kilo", env, home)
  const configDir =
    configOverride && configOverride.length > 0 ? configOverride : xdg.configDir
  return {
    id: "kilo",
    ocpVersion: "0.1.0",
    nativePlugin: "@kilocode/plugin",
    nativeSdk: "@kilocode/sdk",
    pluginVersionObserved: "7.4.11",
    upstreamPin: "v1.17.4",
    paths: {
      configDir,
      dataDir: xdg.dataDir,
      cacheDir: xdg.cacheDir,
      projectDirs: [".kilo", ".kilocode"],
      compatProjectDirs: [".opencode"],
      pluginInstallDir: join(xdg.cacheDir, "packages"),
    },
    configFiles: [
      "config.json",
      "kilo.json",
      "kilo.jsonc",
      "opencode.json",
      "opencode.jsonc",
    ],
    envPrefix: "KILO",
    capabilities: {
      classicHooks: true,
      promiseV2: false,
      effectV2: false,
      aisdkProviderHooks: false,
      localPluginScan: true,
      scansDotOpencode: false,
    },
    hooks: {
      core: CORE_HOOKS,
      missing: [],
      extensions: [],
    },
  }
}

/**
 * ZCode — T0 only. Marketplace ABI ≠ `@opencode-ai/plugin`.
 */
export function zcodeProfile(options?: DraftOptions): HostProfile {
  const { env, home } = baseOpts(options)
  const zcodeHome =
    env.ZCODE_HOME && env.ZCODE_HOME.length > 0
      ? env.ZCODE_HOME
      : join(home, ".zcode")
  return {
    id: "zcode",
    ocpVersion: "none",
    nativePlugin: "(marketplace .zcode-plugin — not @opencode-ai/plugin)",
    nativeSdk: "(none — @zcode/* internals)",
    pluginVersionObserved: "3.3.6",
    paths: {
      home: zcodeHome,
      configDir: join(zcodeHome, "v2"),
      dataDir: zcodeHome,
      cacheDir: join(zcodeHome, "cache"),
      projectDirs: [],
    },
    configFiles: ["setting.json", "config.json"],
    envPrefix: "ZCODE",
    capabilities: {
      classicHooks: false,
      promiseV2: false,
      effectV2: false,
      aisdkProviderHooks: false,
      localPluginScan: false,
      scansDotOpencode: false,
      marketplacePlugins: true,
    },
    hooks: {
      core: [],
      missing: [...CORE_HOOKS],
      extensions: [],
    },
    note: "External OpenCode agent tile is not OCP plugin compatibility",
  }
}

/** Fallback when no cooperating host is detected. */
export function unknownProfile(options?: DraftOptions): HostProfile {
  const { home } = baseOpts(options)
  return {
    id: "unknown",
    ocpVersion: "none",
    nativePlugin: "(unknown)",
    nativeSdk: "(unknown)",
    paths: {
      configDir: home,
      dataDir: home,
      cacheDir: home,
      projectDirs: [],
    },
    configFiles: [],
    envPrefix: "",
    capabilities: {
      classicHooks: false,
      promiseV2: false,
      effectV2: false,
      aisdkProviderHooks: false,
      localPluginScan: false,
      scansDotOpencode: false,
    },
    hooks: {
      core: [],
      missing: [...CORE_HOOKS],
      extensions: [],
    },
  }
}

/** All draft builders keyed by HostId (excluding unknown). */
export const DRAFTS = {
  opencode: opencodeProfile,
  mimo: mimoProfile,
  kilo: kiloProfile,
  zcode: zcodeProfile,
} as const