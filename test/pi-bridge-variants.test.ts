/**
 * Model-variant expansion: an OpenCode `variants` map → host model entries plus
 * per-call provider options.
 *
 * Cursor's `grok-4.6` is the motivating case (effort × fast = 6 variants), but
 * nothing here is Cursor-specific: the parameter list is located structurally
 * and the selected variant's options object is passed back verbatim.
 */
import { describe, expect, test } from "bun:test"
import { ompProfile, piProfile } from "../packages/pi-bridge/src/host/profile.ts"
import { expandEntry } from "../packages/pi-bridge/src/opencode/models.ts"
import { expandModelVariants, extractVariantParams, optionsForLevel, thinkingConfigFor } from "../packages/pi-bridge/src/opencode/variants.ts"

/** Shaped exactly like what cursor-opencode-provider's config hook emits. */
const GROK_ENTRY = {
  name: "Cursor Grok 4.6",
  reasoning: true,
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 1, output: 2 },
  variants: {
    "Grok Low": { cursorVariantParameters: [{ id: "effort", value: "low" }, { id: "fast", value: "false" }] },
    "Grok Low Fast": { cursorVariantParameters: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }] },
    "Grok Medium": { cursorVariantParameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }] },
    "Grok Medium Fast": { cursorVariantParameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }] },
    "Grok High": { cursorVariantParameters: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }] },
    "Grok High Fast": { cursorVariantParameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] },
  },
}

describe("extractVariantParams", () => {
  test("finds the parameter list structurally, without knowing its key name", () => {
    expect(extractVariantParams({ someProviderKey: [{ id: "effort", value: "low" }] })).toEqual([{ id: "effort", value: "low" }])
  })

  test("ignores unrelated array/scalar properties", () => {
    expect(extractVariantParams({ tags: ["a", "b"], count: 3 })).toEqual([])
  })
})

describe("expandModelVariants", () => {
  test("splits the effort axis from other dimensions: one entry per non-effort combination", () => {
    const expanded = expandModelVariants("grok-4.6", GROK_ENTRY)
    expect(expanded.map(e => e.id).sort()).toEqual(["grok-4.6", "grok-4.6-fast"])
  })

  test("each entry offers the full effort range and resolves back to the base model id", () => {
    const expanded = expandModelVariants("grok-4.6", GROK_ENTRY)
    for (const entry of expanded) {
      expect(entry.levels.sort()).toEqual(["high", "low", "medium"])
      expect(entry.baseId).toBe("grok-4.6")
    }
  })

  test("the plain (non-fast) group keeps the bare model id", () => {
    const plain = expandModelVariants("grok-4.6", GROK_ENTRY).find(e => e.id === "grok-4.6")!
    expect(plain.nameSuffix).toBe("")
  })

  test("a model with no variants yields exactly one entry with no levels", () => {
    const expanded = expandModelVariants("plain", { name: "Plain" })
    expect(expanded).toHaveLength(1)
    expect(expanded[0]!).toMatchObject({ id: "plain", baseId: "plain", levels: [], nameSuffix: "" })
  })
})

describe("optionsForLevel", () => {
  test("selects the variant matching both the chosen effort and the entry's own dimension", () => {
    const [plain, fast] = expandModelVariants("grok-4.6", GROK_ENTRY).sort((a, b) => a.id.localeCompare(b.id))
    expect(optionsForLevel(plain!, "high")).toEqual({
      cursorVariantParameters: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }],
    })
    expect(optionsForLevel(fast!, "low")).toEqual({
      cursorVariantParameters: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }],
    })
  })

  test("an unselected/unknown level falls back to a middle effort rather than failing", () => {
    const plain = expandModelVariants("grok-4.6", GROK_ENTRY).find(e => e.id === "grok-4.6")!
    expect(optionsForLevel(plain, undefined)).toEqual({
      cursorVariantParameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }],
    })
  })
})

describe("dimension policy", () => {
  /** Shaped like Cursor's GPT entries: `reasoning` (not `effort`) + fast, with a constant context. */
  const GPT_ENTRY = {
    name: "GPT",
    reasoning: true,
    variants: Object.fromEntries(
      ["none", "low", "medium", "high", "extra-high"].flatMap(r =>
        ["false", "true"].map(fast => [
          `GPT ${r}${fast === "true" ? " Fast" : ""}`,
          { cursorVariantParameters: [{ id: "context", value: "272k" }, { id: "reasoning", value: r }, { id: "fast", value: fast }] },
        ]),
      ),
    ),
  }

  test("`reasoning` is recognized as an effort dimension, not a splitting one", () => {
    const expanded = expandModelVariants("gpt", GPT_ENTRY)
    expect(expanded.map(e => e.id).sort()).toEqual(["gpt", "gpt-fast"])
  })

  test("provider effort values map onto host levels; `none` is dropped and `extra-high` aliases to xhigh", () => {
    const plain = expandModelVariants("gpt", GPT_ENTRY).find(e => e.id === "gpt")!
    expect(plain.levels.sort()).toEqual(["high", "low", "medium", "xhigh"])
  })

  test("a constant dimension never reaches the model id (context is already a separate OpenCode entry)", () => {
    for (const entry of expandModelVariants("gpt", GPT_ENTRY)) {
      expect(entry.id).not.toContain("context")
    }
  })

  test("a varying non-split dimension collapses to its preferred value rather than splitting", () => {
    // Claude-shaped: thinking varies, but only `fast` may split.
    const claude = {
      name: "Claude",
      reasoning: true,
      variants: Object.fromEntries(
        ["false", "true"].flatMap(thinking =>
          ["false", "true"].map(fast => [
            `C ${thinking}/${fast}`,
            { cursorVariantParameters: [{ id: "thinking", value: thinking }, { id: "effort", value: "high" }, { id: "fast", value: fast }] },
          ]),
        ),
      ),
    }
    const expanded = expandModelVariants("claude", claude)
    expect(expanded.map(e => e.id).sort()).toEqual(["claude", "claude-fast"])
    // The surviving variants are the thinking=true ones.
    const params = optionsForLevel(expanded[0]!, "high").cursorVariantParameters as Array<{ id: string; value: string }>
    expect(params.find(p => p.id === "thinking")?.value).toBe("true")
  })

  test("splitDimensions is configurable — opting out collapses fast too", () => {
    const expanded = expandModelVariants("gpt", GPT_ENTRY, { splitDimensions: [] })
    expect(expanded.map(e => e.id)).toEqual(["gpt"])
  })
})

describe("thinkingConfigFor", () => {
  test("omp gets an explicit ordered effort list", () => {
    expect(thinkingConfigFor(["high", "low", "medium"], ompProfile())).toEqual({
      thinking: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" },
    })
  })

  test("pi gets a thinkingLevelMap, with unsupported levels nulled and xhigh/max omitted", () => {
    const config = thinkingConfigFor(["low", "medium", "high"], piProfile()) as { thinkingLevelMap: Record<string, unknown> }
    expect(config.thinkingLevelMap.low).toBe("low")
    expect(config.thinkingLevelMap.high).toBe("high")
    // `minimal` is offered by default unless explicitly nulled…
    expect(config.thinkingLevelMap.minimal).toBeNull()
    // …whereas xhigh/max are excluded simply by being absent.
    expect(config.thinkingLevelMap).not.toHaveProperty("xhigh")
    expect(config.thinkingLevelMap).not.toHaveProperty("max")
  })
})

describe("expandEntry", () => {
  test("attaches the host's own thinking declaration and names the variant entry", () => {
    const expanded = expandEntry("grok-4.6", GROK_ENTRY, ompProfile())
    const fast = expanded.find(e => e.model.id === "grok-4.6-fast")!
    expect(fast.model.name).toBe("Cursor Grok 4.6 Fast")
    expect(fast.model.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" })
    expect(fast.model.contextWindow).toBe(200_000)
  })

  test("a non-reasoning model gets no thinking picker even if it declares variants", () => {
    const expanded = expandEntry("m", { ...GROK_ENTRY, reasoning: false }, ompProfile())
    expect(expanded[0]!.model.thinking).toBeUndefined()
  })

  test("the entry's own options are recorded for pass-through on every call", () => {
    const withOptions = { ...GROK_ENTRY, options: { cursorModelId: "grok-4.6", someFlag: true } }
    const expanded = expandEntry("grok-4.6-1m", withOptions, ompProfile())
    expect(expanded[0]!.call.entryOptions).toEqual({ cursorModelId: "grok-4.6", someFlag: true })
  })
})
