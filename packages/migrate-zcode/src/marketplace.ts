import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { buildPluginJson, emitPluginTree } from "./emit"
import { emptyReport, finalizeReport } from "./report"
import { scanPluginPackage } from "./scan"
import type {
  MarketplacePluginEntry,
  MigrateMarketplaceReport,
  MigrateZcodeMarketplaceOptions,
  MigrateZcodeMarketplaceResult,
  MigrateZcodeResult,
  PluginScan,
} from "./types"

/** Slug for `plugins/<slug>/` — lowercase, safe path segment. */
export function pluginSlug(name: string): string {
  const trimmed = name.trim().toLowerCase()
  const slug = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
  if (!slug || !/^[a-z0-9]/.test(slug)) {
    throw new Error(
      `migrateZcodeMarketplace: cannot derive plugin slug from "${name}"`,
    )
  }
  return slug
}

function pickPluginIdentity(
  result: { scan: PluginScan; tree?: { pluginJson: Record<string, unknown> } },
  fallbackDir: string,
): { name: string; description?: string } {
  const fromTree = result.tree?.pluginJson
  const name =
    (typeof fromTree?.name === "string" && fromTree.name.trim()) ||
    result.scan.packageName ||
    basename(fallbackDir)
  const description =
    typeof fromTree?.description === "string" && fromTree.description.trim()
      ? fromTree.description.trim()
      : undefined
  return { name, description }
}

/** Build a ZCode-shaped marketplace catalog (glm-fleet style). */
export function buildMarketplaceJson(options: {
  name: string
  description?: string
  ownerName?: string
  ownerUrl?: string
  plugins: MarketplacePluginEntry[]
}): Record<string, unknown> {
  const catalog: Record<string, unknown> = {
    name: options.name,
    plugins: options.plugins.map((p) => {
      const entry: Record<string, unknown> = {
        name: p.name,
        source: p.source,
      }
      if (p.description) entry.description = p.description
      return entry
    }),
  }
  if (options.description?.trim()) {
    catalog.description = options.description.trim()
  }
  if (options.ownerName?.trim()) {
    const owner: Record<string, unknown> = { name: options.ownerName.trim() }
    if (options.ownerUrl?.trim()) owner.url = options.ownerUrl.trim()
    catalog.owner = owner
  }
  return catalog
}

async function migrateOneChild(
  pluginDir: string,
  options: {
    allowEmpty?: boolean
    dryRun: boolean
    outDir?: string
    slug: string
  },
): Promise<MigrateZcodeResult> {
  const scan = await scanPluginPackage(pluginDir)
  const report = emptyReport(pluginDir)

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
    if (manifest.kind === "marketplace") {
      report.warnings.push(
        `marketplace-manifest-omitted-under-wrap:${manifest.path}`,
      )
      continue
    }
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
    scan.manifests.filter((m) => m.kind !== "marketplace").length === 0
  ) {
    report.warnings.push(
      "hooks-only-plugin: no marketplace assets to migrate; JS entrypoints cannot run on ZCode via this tool",
    )
  }

  const collisionFailed = report.skipped.some((s) =>
    s.reason.includes("collision"),
  )
  const treePreview = {
    pluginJson: buildPluginJson(scan, {}),
    skills: report.included.skills,
    commands: report.included.commands,
    copiedManifests: [] as string[],
  }

  if (collisionFailed) {
    return { report: { ...report, ok: false }, scan, tree: treePreview }
  }

  const finalized = finalizeReport(report, { allowEmpty: options.allowEmpty })
  if (options.outDir) {
    finalized.outDir = join(options.outDir, "plugins", options.slug)
  }

  if (options.dryRun || !finalized.ok) {
    return { report: finalized, scan, tree: treePreview }
  }

  const outDir = options.outDir
  if (!outDir) {
    throw new Error("migrateZcodeMarketplace: outDir is required unless dryRun")
  }
  const pluginOut = join(outDir, "plugins", options.slug)
  const tree = await emitPluginTree(scan, pluginOut, {
    skipMarketplaceCopy: true,
  })
  finalized.outDir = pluginOut
  return { report: finalized, scan, tree }
}

/**
 * Migrate one or more plugin packages into a multi-plugin marketplace tree:
 *
 * ```text
 * <out>/
 *   .zcode-plugin/marketplace.json
 *   plugins/<slug>/.zcode-plugin/plugin.json
 *   plugins/<slug>/skills|commands/...
 * ```
 *
 * Not OCP. Does not migrate host MCP.
 */
export async function migrateZcodeMarketplace(
  options: MigrateZcodeMarketplaceOptions,
): Promise<MigrateZcodeMarketplaceResult> {
  const dirs = options.pluginDirs?.map((d) => d?.trim()).filter(Boolean) ?? []
  if (dirs.length === 0) {
    throw new Error("migrateZcodeMarketplace: pluginDirs is required")
  }
  const marketplaceName = options.marketplaceName?.trim()
  if (!marketplaceName) {
    throw new Error("migrateZcodeMarketplace: marketplaceName is required")
  }

  const dryRun = options.dryRun === true || !options.outDir
  const pluginResults: MigrateZcodeResult[] = []
  const entries: MarketplacePluginEntry[] = []
  const usedSlugs = new Set<string>()
  const skipped: MigrateMarketplaceReport["skipped"] = []
  const warnings: string[] = []

  for (const pluginDir of dirs) {
    // Resolve slug from a quick identity scan before migrating.
    const identityScan = await scanPluginPackage(pluginDir)
    const identityPreview = {
      scan: identityScan,
      tree: { pluginJson: buildPluginJson(identityScan, {}) },
    }
    const identity = pickPluginIdentity(identityPreview, pluginDir)

    let slug: string
    try {
      slug = pluginSlug(identity.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      skipped.push({ path: pluginDir, reason: message })
      warnings.push(message)
      pluginResults.push({
        report: { ...emptyReport(pluginDir), ok: false },
        scan: identityScan,
        tree: {
          pluginJson: identityPreview.tree.pluginJson,
          skills: [],
          commands: [],
          copiedManifests: [],
        },
      })
      continue
    }

    if (usedSlugs.has(slug)) {
      const reason = `plugin-slug-collision:${slug}`
      skipped.push({ path: pluginDir, reason })
      warnings.push(reason)
      pluginResults.push({
        report: { ...emptyReport(pluginDir), ok: false },
        scan: identityScan,
        tree: {
          pluginJson: identityPreview.tree.pluginJson,
          skills: [],
          commands: [],
          copiedManifests: [],
        },
      })
      continue
    }
    usedSlugs.add(slug)

    const result = await migrateOneChild(pluginDir, {
      allowEmpty: options.allowEmpty,
      dryRun,
      outDir: options.outDir,
      slug,
    })
    pluginResults.push(result)
    skipped.push(...result.report.skipped)
    warnings.push(...result.report.warnings)

    if (!result.report.ok) continue

    const migratedIdentity = pickPluginIdentity(result, pluginDir)
    entries.push({
      name: slug,
      source: `./plugins/${slug}`,
      description: migratedIdentity.description,
    })
  }

  const marketplace = buildMarketplaceJson({
    name: marketplaceName,
    description: options.marketplaceDescription,
    ownerName: options.ownerName,
    ownerUrl: options.ownerUrl,
    plugins: entries,
  })

  const anyPluginFailed = pluginResults.some((p) => !p.report.ok)
  const noPlugins = entries.length === 0
  let ok = !anyPluginFailed && !noPlugins
  if (noPlugins && !options.allowEmpty) {
    warnings.push(
      "empty-marketplace: no plugins emitted (pass allowEmpty to override)",
    )
    ok = false
  } else if (noPlugins && options.allowEmpty) {
    ok = !anyPluginFailed
  }

  const report: MigrateMarketplaceReport = {
    ok,
    marketplaceName,
    pluginDirs: dirs,
    plugins: entries,
    pluginReports: pluginResults.map((p) => p.report),
    skipped,
    warnings,
  }

  if (dryRun) {
    if (options.outDir) report.outDir = options.outDir
    return { report, plugins: pluginResults, marketplace }
  }

  const outDir = options.outDir
  if (!outDir) {
    throw new Error("migrateZcodeMarketplace: outDir is required unless dryRun")
  }

  if (entries.length > 0 || options.allowEmpty) {
    await mkdir(join(outDir, ".zcode-plugin"), { recursive: true })
    await Bun.write(
      join(outDir, ".zcode-plugin", "marketplace.json"),
      `${JSON.stringify(marketplace, null, 2)}\n`,
    )
    const readme = [
      `# ${marketplaceName}`,
      "",
      "Generated by `@opencode-compat/migrate-zcode` (marketplace wrap).",
      "",
      "This tree is a **ZCode marketplace catalog** plus per-plugin marketplace assets.",
      "It does **not** run OpenCode `@opencode-ai/plugin` JavaScript hooks.",
      "",
      `Plugins: ${entries.map((e) => e.name).join(", ") || "(none)"}`,
      "",
    ].join("\n")
    await Bun.write(join(outDir, "README.md"), readme)
  }

  report.outDir = outDir
  return { report, plugins: pluginResults, marketplace }
}
