/**
 * Host layer: profiles, detection, and the deltas between the two Pi-family
 * hosts. Each delta encoded in `profile.ts` was read from host source; these
 * tests pin them so a future edit can't quietly flip one.
 */
import { describe, expect, test } from "bun:test"
import { detectPiHost, resetPiHostDetection } from "../packages/pi-bridge/src/host/detect.ts"
import { avoidProviderIdCollision, ompProfile, piProfile, profileFor, renderApiKeyRef } from "../packages/pi-bridge/src/host/profile.ts"
import { fallbackToolSchema } from "../packages/pi-bridge/src/host/runtime.ts"

describe("host profiles", () => {
  test("omp and pi use different pi-ai package scopes", () => {
    expect(ompProfile().aiPackage).toBe("@oh-my-pi/pi-ai")
    expect(piProfile().aiPackage).toBe("@earendil-works/pi-ai")
  })

  test("dynamic-model calling conventions differ", () => {
    expect(ompProfile().capabilities.dynamicModels).toBe("fetchDynamicModels")
    expect(piProfile().capabilities.dynamicModels).toBe("refreshModels")
  })

  test("pi marks oauth refreshToken/getApiKey required; omp does not", () => {
    expect(piProfile().capabilities.oauthRequires).toEqual(["refreshToken", "getApiKey"])
    expect(ompProfile().capabilities.oauthRequires).toEqual([])
  })

  test("only omp reserves its full KnownApi list, and both reserve their own ids", () => {
    expect(ompProfile().reservedApis).toContain("cursor-agent")
    expect(piProfile().reservedApis).toContain("anthropic-messages")
  })

  test("profileFor round-trips by id", () => {
    expect(profileFor("omp").id).toBe("omp")
    expect(profileFor("pi").id).toBe("pi")
  })
})

describe("avoidProviderIdCollision", () => {
  test("suffixes an id the host already ships natively (omp's own cursor provider)", () => {
    expect(avoidProviderIdCollision("cursor", ompProfile())).toBe("cursor-opencode")
  })

  test("leaves a non-colliding id untouched", () => {
    expect(avoidProviderIdCollision("acme", ompProfile())).toBe("acme")
  })
})

describe("renderApiKeyRef", () => {
  test("omp takes a bare env-var name", () => {
    expect(renderApiKeyRef("CURSOR_ACCESS_TOKEN", ompProfile())).toBe("CURSOR_ACCESS_TOKEN")
  })

  test("pi takes a $VAR template reference", () => {
    expect(renderApiKeyRef("CURSOR_ACCESS_TOKEN", piProfile())).toBe("$CURSOR_ACCESS_TOKEN")
  })

  test("values already carrying pi's own syntax pass through untouched", () => {
    expect(renderApiKeyRef("$ALREADY", piProfile())).toBe("$ALREADY")
    expect(renderApiKeyRef("!op read op://x/y", piProfile())).toBe("!op read op://x/y")
  })

  test("a literal secret (not an env-var-shaped name) is not turned into a template", () => {
    expect(renderApiKeyRef("sk-live-abc123", piProfile())).toBe("sk-live-abc123")
  })
})

describe("detectPiHost", () => {
  test("probes omp first, falling back to pi", async () => {
    resetPiHostDetection()
    const detection = await detectPiHost({
      env: {},
      fresh: true,
      probe: async spec => {
        if (spec === "@oh-my-pi/pi-ai") return {}
        throw new Error("not installed")
      },
    })
    expect(detection.profile.id).toBe("omp")
    expect(detection.source).toBe("probe")
  })

  test("detects pi when only its package resolves", async () => {
    const detection = await detectPiHost({
      env: {},
      fresh: true,
      probe: async spec => {
        if (spec === "@earendil-works/pi-ai") return {}
        throw new Error("not installed")
      },
    })
    expect(detection.profile.id).toBe("pi")
  })

  test("PI_BRIDGE_HOST forces a host without probing", async () => {
    let probed = false
    const detection = await detectPiHost({
      env: { PI_BRIDGE_HOST: "pi" },
      fresh: true,
      probe: async () => {
        probed = true
        return {}
      },
    })
    expect(detection.profile.id).toBe("pi")
    expect(detection.source).toBe("env")
    expect(probed).toBe(false)
  })

  test("an unknown PI_BRIDGE_HOST is a clear error, not a silent fallback", async () => {
    await expect(detectPiHost({ env: { PI_BRIDGE_HOST: "nope" }, fresh: true, probe: async () => ({}) })).rejects.toThrow(/not a known host/)
  })

  test("no host at all reports both probe failures", async () => {
    await expect(
      detectPiHost({
        env: {},
        fresh: true,
        probe: async () => {
          throw new Error("missing")
        },
      }),
    ).rejects.toThrow(/no Pi-family host detected/)
  })
})

describe("fallbackToolSchema", () => {
  test("calls toJsonSchema() when the schema exposes one (ArkType / zod v4 style)", () => {
    const schema = { toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }) }
    expect(fallbackToolSchema({ parameters: schema })).toEqual({ type: "object", properties: { a: { type: "string" } } })
  })

  test("passes a plain JSON Schema object through (TypeBox, as pi uses)", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } }
    expect(fallbackToolSchema({ parameters: schema })).toEqual(schema)
  })

  test("degrades to an empty object schema rather than throwing", () => {
    expect(fallbackToolSchema({ parameters: undefined })).toEqual({ type: "object", properties: {} })
  })
})
