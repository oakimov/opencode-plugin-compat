import type { MigrateReport, SkippedItem } from "./types"

export function emptyReport(pluginDir: string): MigrateReport {
  return {
    ok: true,
    pluginDir,
    included: { skills: [], commands: [], manifests: [] },
    skipped: [],
    warnings: [],
  }
}

export function mergeSkipped(...lists: SkippedItem[][]): SkippedItem[] {
  return lists.flat()
}

export function finalizeReport(
  report: MigrateReport,
  options: { allowEmpty?: boolean },
): MigrateReport {
  const hasAssets =
    report.included.skills.length > 0 ||
    report.included.commands.length > 0 ||
    report.included.manifests.length > 0

  if (!hasAssets && !options.allowEmpty) {
    return {
      ...report,
      ok: false,
      warnings: [
        ...report.warnings,
        "empty-migration: no skills/commands/marketplace manifests found (pass allowEmpty to override)",
      ],
    }
  }
  return report
}
