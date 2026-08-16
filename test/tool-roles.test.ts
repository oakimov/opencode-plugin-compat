/**
 * Host tool roles — forks rotate builtin names while keeping the vocabulary.
 *
 * MiMo moved OpenCode's subagent spawner `task` → `actor`, then reused the
 * freed `task` name for its work-item tracker (OpenCode's todowrite/todoread).
 * Anything that hardcodes "task" therefore means "spawn a subagent" on
 * OpenCode/Kilo and "record a todo" on MiMo — silently.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TOOL_ROLES,
  kiloProfile,
  mimoProfile,
  opencodeProfile,
  resolveToolRole,
  toolRolesOf,
  unknownProfile,
  zcodeProfile,
} from "../packages/profile/src/index.ts"

const OPENCODE_TOOLS = ["read", "grep", "task", "todowrite", "todoread"]
const MIMO_TOOLS = ["read", "grep", "actor", "task", "cron"]

describe("toolRolesOf", () => {
  test("only MiMo overrides; every other host keeps upstream defaults", () => {
    expect(toolRolesOf(mimoProfile())).toEqual({
      ...DEFAULT_TOOL_ROLES,
      subagent: "actor",
      todoWrite: "task",
      todoRead: "task",
    })

    for (const profile of [
      opencodeProfile(),
      kiloProfile(),
      zcodeProfile(),
      unknownProfile(),
    ]) {
      expect(toolRolesOf(profile)).toEqual(DEFAULT_TOOL_ROLES)
      // Unrotated hosts carry no override at all.
      expect(profile.tools).toBeUndefined()
    }
  })

  test("defaults apply with no profile at all (OCP-absent consumers)", () => {
    expect(toolRolesOf()).toEqual(DEFAULT_TOOL_ROLES)
    expect(toolRolesOf(undefined)).toEqual(DEFAULT_TOOL_ROLES)
  })

  test("a sparse override fills only the roles it names", () => {
    expect(toolRolesOf({ tools: { subagent: "actor" } })).toEqual({
      ...DEFAULT_TOOL_ROLES,
      subagent: "actor",
    })
  })

  test("question / planEnter / planExit default to OpenCode names", () => {
    expect(DEFAULT_TOOL_ROLES.question).toBe("question")
    expect(DEFAULT_TOOL_ROLES.planEnter).toBe("plan_enter")
    expect(DEFAULT_TOOL_ROLES.planExit).toBe("plan_exit")
    expect(resolveToolRole("question", ["question", "ask"], opencodeProfile())).toBe("question")
    expect(resolveToolRole("planEnter", ["plan_enter"], opencodeProfile())).toBe("plan_enter")
    expect(resolveToolRole("planExit", ["plan_exit"], opencodeProfile())).toBe("plan_exit")
  })
})

describe("resolveToolRole", () => {
  test("MiMo: subagent → actor, todo → task", () => {
    const mimo = mimoProfile()
    expect(resolveToolRole("subagent", MIMO_TOOLS, mimo)).toBe("actor")
    expect(resolveToolRole("todoWrite", MIMO_TOOLS, mimo)).toBe("task")
    expect(resolveToolRole("todoRead", MIMO_TOOLS, mimo)).toBe("task")
  })

  test("OpenCode/Kilo are unaffected — task stays the spawner", () => {
    for (const profile of [opencodeProfile(), kiloProfile()]) {
      expect(resolveToolRole("subagent", OPENCODE_TOOLS, profile)).toBe("task")
      expect(resolveToolRole("todoWrite", OPENCODE_TOOLS, profile)).toBe("todowrite")
      expect(resolveToolRole("todoRead", OPENCODE_TOOLS, profile)).toBe("todoread")
    }
  })

  test("a role never resolves to a tool the host did not advertise", () => {
    expect(resolveToolRole("subagent", ["read", "grep"], mimoProfile())).toBeUndefined()
    expect(resolveToolRole("todoWrite", ["read", "grep"], opencodeProfile())).toBeUndefined()
  })

  test("an override never falls through to the upstream default", () => {
    // `actor` disabled on MiMo. `task` is advertised, but it is the tracker —
    // routing a spawn there would be rejected by its schema. Absent beats wrong.
    expect(resolveToolRole("subagent", ["read", "task"], mimoProfile())).toBeUndefined()
    expect(resolveToolRole("subagent", OPENCODE_TOOLS, mimoProfile())).toBeUndefined()
  })

  test("hosts with no override still use the upstream default", () => {
    expect(resolveToolRole("subagent", OPENCODE_TOOLS, unknownProfile())).toBe("task")
    expect(resolveToolRole("subagent", OPENCODE_TOOLS)).toBe("task")
  })
})
