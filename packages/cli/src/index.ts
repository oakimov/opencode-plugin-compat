/**
 * @opencode-compat/cli — `compat doctor` + matrix runner scaffold.
 */
export const PKG = "@opencode-compat/cli" as const
export const VERSION = "0.1.0" as const

export function doctor(): { ok: boolean; message: string } {
  return {
    ok: false,
    message: "compat doctor not implemented yet — see docs/ocp/0.1.md",
  }
}

if (import.meta.main) {
  const result = doctor()
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
