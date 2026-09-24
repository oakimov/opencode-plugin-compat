/** Optional Cursor-only wiring. Generic Pi providers never load this module. */
import { pathToFileURL } from "node:url"
import {
  loadProviderWithSubpathThroughHost,
  resolveProviderRootEntry,
  resolveProviderSubpathEntry,
} from "./host-module-loader.js"
import type { PiBinarySaveExecute, PiExtensionApi } from "./pi-provider-types.js"

export { cursorFinishContextTokens, cursorFinishUsage, cursorFinishPiUsage } from "./translate/cursor-usage.js"

export async function loadCursorProviderModules(
  pi: PiExtensionApi,
  providerSpecifier: string,
  cwd: string,
): Promise<{ root?: Record<string, unknown>; imageSave?: PiBinarySaveExecute }> {
  const pair = await loadProviderWithSubpathThroughHost(pi, providerSpecifier, "./image-save", cwd)
  if (pair) {
    const execute = pair.subpath.executeCursorImageSave
    return {
      root: pair.root,
      ...(typeof execute === "function" ? { imageSave: execute as PiBinarySaveExecute } : {}),
    }
  }

  // When OMP's host graph cannot load the pair, leave the save tool unavailable
  // instead of importing a separate staging instance.
  if (pi.pi?.loadExtensions) return {}
  const rootEntry = resolveProviderRootEntry(pi, providerSpecifier, cwd)
  const subpathEntry = resolveProviderSubpathEntry(pi, providerSpecifier, "./image-save", cwd)
  if (!rootEntry || !subpathEntry) return {}
  // Pi uses the process module cache. Load both exports by file from the same
  // configured installation so a second installed copy cannot split staging.
  try {
    const [root, subpath] = await Promise.all([
      import(pathToFileURL(rootEntry).href) as Promise<Record<string, unknown>>,
      import(pathToFileURL(subpathEntry).href) as Promise<Record<string, unknown>>,
    ])
    const execute = subpath.executeCursorImageSave
    return {
      root,
      ...(typeof execute === "function" ? { imageSave: execute as PiBinarySaveExecute } : {}),
    }
  } catch {
    // A virtual-module-only Pi install can still register the provider through
    // its normal loader, but has no safe filesystem-backed image commit export.
    return {}
  }
}
