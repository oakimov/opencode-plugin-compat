/** Shared types for @opencode-compat/migrate-zcode */

export type MigrateZcodeOptions = {
  /** Root of the plugin package to migrate (required). */
  pluginDir: string
  /** Output directory for the `.zcode-plugin` tree. Required unless `dryRun`. */
  outDir?: string
  /** Override plugin name in generated `plugin.json`. */
  name?: string
  /** Override plugin version in generated `plugin.json`. */
  version?: string
  /** Discover only; do not write files. */
  dryRun?: boolean
  /** Allow success when no skills/commands/manifest assets are found. */
  allowEmpty?: boolean
}

export type SkippedItem = {
  path: string
  reason: string
}

export type MigrateReport = {
  ok: boolean
  outDir?: string
  pluginDir: string
  included: {
    skills: string[]
    commands: string[]
    manifests: string[]
  }
  skipped: SkippedItem[]
  warnings: string[]
}

export type ManifestKind =
  | "zcode-plugin"
  | "claude-plugin"
  | "codex-plugin"
  | "marketplace"

export type FoundManifest = {
  kind: ManifestKind
  path: string
  raw: Record<string, unknown>
}

export type FoundSkill = {
  /** Relative path under plugin (posix-ish). */
  relPath: string
  absPath: string
  name: string
  description: string
  body: string
}

export type FoundCommand = {
  relDir: string
  absPath: string
  /** Output filename under `commands/` (e.g. `foo.md`). */
  fileName: string
  name: string
  description?: string
  body: string
  droppedFrontmatter: string[]
}

export type PluginScan = {
  pluginDir: string
  packageName?: string
  packageVersion?: string
  skills: FoundSkill[]
  commands: FoundCommand[]
  manifests: FoundManifest[]
  /** JS/TS entry hints that cannot run on ZCode via this migrator. */
  jsEntrypoints: string[]
}

export type EmittedTreeManifest = {
  pluginJson: Record<string, unknown>
  skills: string[]
  commands: string[]
  copiedManifests: string[]
}

export type MigrateZcodeResult = {
  report: MigrateReport
  scan: PluginScan
  /** Present after a successful write, or when dryRun builds a preview. */
  tree?: EmittedTreeManifest
}

/** Options for wrapping one or more plugin packages into a ZCode marketplace tree. */
export type MigrateZcodeMarketplaceOptions = {
  /** One or more plugin package roots (required, non-empty). */
  pluginDirs: string[]
  /** Marketplace output root. Required unless `dryRun`. */
  outDir?: string
  /** Catalog `name` in `.zcode-plugin/marketplace.json` (required). */
  marketplaceName: string
  marketplaceDescription?: string
  ownerName?: string
  ownerUrl?: string
  dryRun?: boolean
  allowEmpty?: boolean
}

export type MarketplacePluginEntry = {
  name: string
  source: string
  description?: string
}

export type MigrateMarketplaceReport = {
  ok: boolean
  outDir?: string
  marketplaceName: string
  pluginDirs: string[]
  plugins: MarketplacePluginEntry[]
  /** Per-plugin migrate reports (same order as pluginDirs). */
  pluginReports: MigrateReport[]
  skipped: SkippedItem[]
  warnings: string[]
}

export type MigrateZcodeMarketplaceResult = {
  report: MigrateMarketplaceReport
  /** Per-plugin migrate results (same order as pluginDirs). */
  plugins: MigrateZcodeResult[]
  /** Generated marketplace.json body (preview or written). */
  marketplace?: Record<string, unknown>
}