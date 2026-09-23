/** Optional Cursor integration is selected by package identity, never provider id. */
export function stripTrailingNpmVersion(raw: string): string {
  const at = raw.lastIndexOf("@")
  if (at <= 0) return raw
  const after = raw.slice(at + 1)
  if (!after || after.includes("/")) return raw
  return raw.slice(0, at)
}

export function isCursorProviderPackage(raw: string): boolean {
  const packageName = stripTrailingNpmVersion(raw.toLowerCase())
  return packageName === "cursor-opencode-provider"
    || packageName.startsWith("cursor-opencode-provider/")
    || packageName.includes("/cursor-opencode-provider/")
    || packageName.endsWith("/cursor-opencode-provider")
}
