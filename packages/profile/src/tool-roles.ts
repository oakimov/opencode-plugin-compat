import type { HostProfile, HostToolRoles } from "./types"

/**
 * Upstream OpenCode builtin names.
 *
 * Every host that has not rotated its builtins — OpenCode, Kilo, ZCode, and
 * any host we failed to identify — resolves to these. Only a diverging fork
 * carries a `tools` override, so adding a host costs nothing by default.
 */
export const DEFAULT_TOOL_ROLES: HostToolRoles = {
  subagent: "task",
  todoWrite: "todowrite",
  todoRead: "todoread",
  question: "question",
  planEnter: "plan_enter",
  planExit: "plan_exit",
}

/**
 * Resolve a profile's tool roles, filling every unset role from
 * {@link DEFAULT_TOOL_ROLES}.
 *
 * The result is advisory. Callers dispatching real tool calls should pass the
 * host's advertised tool names to {@link resolveToolRole} so a role never
 * resolves to a builtin the user disabled.
 */
export function toolRolesOf(profile?: Pick<HostProfile, "tools">): HostToolRoles {
  return { ...DEFAULT_TOOL_ROLES, ...profile?.tools }
}

/**
 * Resolve a single role against the tools the host actually advertises.
 *
 * Returns `undefined` rather than guessing, so a caller never dispatches to a
 * tool that is absent — or, worse, to one whose name it shares with a
 * different role on this host.
 *
 * An explicit override is deliberately *not* backed by the upstream default:
 * a fork that renames a role is asserting the default name now means
 * something else. MiMo with `actor` disabled has no spawner at all, and
 * falling through to `task` would post a subagent spawn into its work-item
 * tracker, which rejects it. Absent beats wrong.
 */
export function resolveToolRole(
  role: keyof HostToolRoles,
  advertised: Iterable<string>,
  profile?: Pick<HostProfile, "tools">,
): string | undefined {
  const names = new Set(advertised)
  const override = profile?.tools?.[role]
  if (override) return names.has(override) ? override : undefined
  const fallback = DEFAULT_TOOL_ROLES[role]
  return names.has(fallback) ? fallback : undefined
}
