/** Install the request-scoped clone skills surface when path setup has not. */
import { currentRecordedHostSkills, hostSkillsBridge, installHostSkillsBridge } from "@opencode-compat/opencode-loader"

export function installSkillsBridge(id: string): void {
  if (id !== "mimo" && id !== "kilo") return
  if (hostSkillsBridge()) return
  installHostSkillsBridge(() => currentRecordedHostSkills())
}
