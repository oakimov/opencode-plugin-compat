import { describe, expect, test } from "bun:test"
import {
  createSettingsSchema,
  DSH_BRIDGE_SETTINGS_NS,
  installDshBridgeSettings,
  settingsPathFor,
} from "../packages/dsh-bridge/src/settings.ts"

describe("dsh-bridge settings section", () => {
  test("namespace and path match llm-pi-ai.providers.<id>", () => {
    expect(DSH_BRIDGE_SETTINGS_NS).toBe("dsh-bridge")
    expect(settingsPathFor("cursor-opencode")).toEqual(["providers", "cursor-opencode"])
  })

  test("schema admits a litellm-shaped provider dict", () => {
    const schema = createSettingsSchema()
    expect(schema(undefined)).toEqual({ providers: {} })
    expect(schema({})).toEqual({ providers: {} })
    expect(schema({
      providers: {
        "cursor-opencode": { apiKeyEnv: "CURSOR_API_KEY", displayName: "cursor-opencode" },
      },
    })).toEqual({
      providers: {
        "cursor-opencode": { apiKeyEnv: "CURSOR_API_KEY", displayName: "cursor-opencode" },
      },
    })
  })

  test("schema toJSON is a schemastery dict-of-profiles envelope", () => {
    const json = createSettingsSchema().toJSON() as { uid: number; refs: Record<string, { type?: string }> }
    expect(json.uid).toBe(7)
    expect(json.refs["6"]?.type).toBe("dict")
    expect(json.refs["7"]?.type).toBe("object")
  })

  test("installSection seeds the composition base via ctx.inject(['settings'])", () => {
    const calls: unknown[] = []
    const ctx = {
      inject: (deps: string[], fn: (inner: { settings: { installSection: (...args: unknown[]) => void } }) => void) => {
        expect(deps).toEqual(["settings"])
        fn({
          settings: {
            installSection: (...args: unknown[]) => { calls.push(args) },
          },
        })
      },
    }
    const entry = {
      providers: { "cursor-opencode": { apiKeyEnv: "CURSOR_API_KEY", displayName: "cursor-opencode" } },
    }
    installDshBridgeSettings(ctx, entry)
    expect(calls).toHaveLength(1)
    const [owner, ns, schema, seeded] = calls[0] as unknown[]
    expect(owner).toBe(ctx)
    expect(ns).toBe("dsh-bridge")
    expect(typeof schema).toBe("function")
    expect(seeded).toEqual(entry)
  })
})
