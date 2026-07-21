/**
 * @opencode-compat/migrate-zcode — migrate a plugin package’s marketplace
 * assets (skills / commands / manifests) into a `.zcode-plugin` tree.
 *
 * Not OCP ABI compatibility. Does not migrate host MCP (ZCode has its own).
 * Does not run `@opencode-ai/plugin` hooks on ZCode (remains T0).
 */
export const PKG = "@opencode-compat/migrate-zcode" as const
export const VERSION = "0.1.3" as const
export const EMITTER_VERSION = "0.3.0-marketplace" as const

export type {
  EmittedTreeManifest,
  FoundCommand,
  FoundManifest,
  FoundSkill,
  ManifestKind,
  MarketplacePluginEntry,
  MigrateMarketplaceReport,
  MigrateReport,
  MigrateZcodeMarketplaceOptions,
  MigrateZcodeMarketplaceResult,
  MigrateZcodeOptions,
  MigrateZcodeResult,
  PluginScan,
  SkippedItem,
} from "./types"

export { emptyReport, finalizeReport, mergeSkipped } from "./report"
export {
  parseFrontmatter,
  sanitizeCommandMarkdown,
  sanitizeSkillMarkdown,
  stringifyFrontmatter,
} from "./markdown"
export { scanPluginPackage } from "./scan"
export { buildPluginJson, emitPluginTree } from "./emit"
export {
  buildMarketplaceJson,
  migrateZcodeMarketplace,
  pluginSlug,
} from "./marketplace"

import { buildPluginJson, emitPluginTree } from "./emit"
import { emptyReport, finalizeReport } from "./report"
import { scanPluginPackage } from "./scan"
import type { MigrateZcodeOptions, MigrateZcodeResult } from "./types"

/**
 * Migrate one plugin package directory into a ZCode `.zcode-plugin` tree.
 */
export async function migrateZcode(
  options: MigrateZcodeOptions,
): Promise<MigrateZcodeResult> {
  const pluginDir = options.pluginDir
  if (!pluginDir?.trim()) {
    throw new Error("migrateZcode: pluginDir is required")
  }

  const dryRun = options.dryRun === true || !options.outDir
  const report = emptyReport(pluginDir)
  const scan = await scanPluginPackage(pluginDir)

  // Deduplicate skill names (fail closed).
  const skillNames = new Set<string>()
  for (const skill of scan.skills) {
    if (skillNames.has(skill.name)) {
      report.skipped.push({
        path: skill.absPath,
        reason: `skill-name-collision:${skill.name}`,
      })
      report.ok = false
    } else {
      skillNames.add(skill.name)
      report.included.skills.push(skill.relPath)
    }
  }

  const commandNames = new Set<string>()
  for (const command of scan.commands) {
    if (commandNames.has(command.name)) {
      report.skipped.push({
        path: command.absPath,
        reason: `command-name-collision:${command.name}`,
      })
      report.ok = false
    } else {
      commandNames.add(command.name)
      report.included.commands.push(`commands/${command.fileName}`)
    }
    for (const key of command.droppedFrontmatter) {
      report.warnings.push(
        `command-frontmatter-dropped:${command.name}:${key}`,
      )
    }
  }

  for (const manifest of scan.manifests) {
    report.included.manifests.push(manifest.path)
  }

  for (const entry of scan.jsEntrypoints) {
    report.skipped.push({
      path: `${pluginDir}:${entry}`,
      reason: "ocp-abi-not-migratable",
    })
  }

  if (
    scan.jsEntrypoints.length > 0 &&
    scan.skills.length === 0 &&
    scan.commands.length === 0 &&
    scan.manifests.length === 0
  ) {
    report.warnings.push(
      "hooks-only-plugin: no marketplace assets to migrate; JS entrypoints cannot run on ZCode via this tool",
    )
  }

  const collisionFailed = report.skipped.some((s) =>
    s.reason.includes("collision"),
  )
  if (collisionFailed) {
    return { report: { ...report, ok: false }, scan }
  }

  const treePreview = {
    pluginJson: buildPluginJson(scan, {
      name: options.name,
      version: options.version,
    }),
    skills: report.included.skills,
    commands: report.included.commands,
    copiedManifests: scan.manifests
      .filter((m) => m.kind === "marketplace")
      .slice(0, 1)
      .map(() => ".zcode-plugin/marketplace.json"),
  }

  if (dryRun) {
    const finalized = finalizeReport(report, {
      allowEmpty: options.allowEmpty,
    })
    if (options.outDir) finalized.outDir = options.outDir
    return { report: finalized, scan, tree: treePreview }
  }

  const outDir = options.outDir
  if (!outDir) {
    throw new Error("migrateZcode: outDir is required unless dryRun")
  }

  const tree = await emitPluginTree(scan, outDir, {
    name: options.name,
    version: options.version,
  })
  report.outDir = outDir
  const finalized = finalizeReport(report, {
    allowEmpty: options.allowEmpty,
  })
  finalized.outDir = outDir
  return { report: finalized, scan, tree }
}