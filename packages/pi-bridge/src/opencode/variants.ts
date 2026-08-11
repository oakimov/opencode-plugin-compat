/**
 * OpenCode model *variants* → Pi-family model entries + per-call provider
 * options.
 *
 * An OpenCode model entry may declare `variants`: a map of display label →
 * options object, where each option object carries the provider-specific
 * parameters for that variant. Cursor's `grok-4.6`, for example, enumerates six
 * variants — the cross product of `effort` (low/medium/high) and `fast`
 * (true/false).
 *
 * Neither host has a "variant" concept, but both have a native *thinking level*
 * picker fed by a per-model declaration and delivered back as
 * `options.reasoning`. So variants are split along two axes:
 *
 *   • a dimension literally named `effort` maps onto the host's own thinking
 *     levels — this is the one convention-sensitive step, and it degrades
 *     safely: an unrecognized dimension simply takes the other path;
 *   • every other dimension (e.g. `fast`) becomes a separate model entry,
 *     which works for any dimension a provider invents later.
 *
 * Nothing here knows the string "cursor": the parameter array is found
 * structurally, and the selected variant's own options object is passed back
 * verbatim.
 */
import type { PiHostProfile } from "../host/profile.js"
import type { OpenCodeModelEntry } from "./types.js"

export type VariantParam = { id: string; value: string }

/** Thinking levels both hosts understand, ordered least → most intensive. */
const HOST_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export type HostThinkingLevel = (typeof HOST_THINKING_LEVELS)[number]

/**
 * Dimension ids that mean "reasoning effort" and therefore map onto the host's
 * thinking-level picker rather than becoming separate model entries. Providers
 * are not consistent even with themselves — Cursor uses `effort` for Grok and
 * `reasoning` for GPT — so this is a small set of conventional names.
 */
const EFFORT_DIMENSIONS = new Set(["effort", "reasoning", "reasoning_effort", "reasoningEffort"])

function isEffortDimension(id: string): boolean {
  return EFFORT_DIMENSIONS.has(id)
}

/**
 * Provider effort value → host thinking level. Unmappable values (notably
 * `none`, which means "don't reason" rather than naming an intensity) yield
 * `undefined` and are simply not offered as levels.
 */
const EFFORT_VALUE_ALIASES: Record<string, HostThinkingLevel> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
}

function toHostLevel(value: string): HostThinkingLevel | undefined {
  return EFFORT_VALUE_ALIASES[value.toLowerCase()]
}

function isVariantParam(value: unknown): value is VariantParam {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as VariantParam).id === "string" &&
    typeof (value as VariantParam).value === "string"
  )
}

/**
 * Find the parameter list inside a variant's options object without knowing its
 * key name — it is the sole array of `{id, value}` records.
 */
export function extractVariantParams(variantOptions: Record<string, unknown>): VariantParam[] {
  for (const value of Object.values(variantOptions)) {
    if (Array.isArray(value) && value.length > 0 && value.every(isVariantParam)) return value as VariantParam[]
  }
  return []
}

function isHostThinkingLevel(value: string): value is HostThinkingLevel {
  return (HOST_THINKING_LEVELS as readonly string[]).includes(value)
}

/**
 * Dimensions that actually vary across an entry's variants. A dimension with a
 * single value everywhere carries no information and must not become part of a
 * model id — OpenCode already splits context tiers into separate entries, so
 * `context` is constant within each and would otherwise add `-context-272k`
 * noise to every id.
 */
function varyingDimensions(all: VariantParam[][]): Set<string> {
  const seen = new Map<string, Set<string>>()
  for (const params of all) {
    for (const p of params) {
      const values = seen.get(p.id) ?? new Set<string>()
      values.add(p.value)
      seen.set(p.id, values)
    }
  }
  const varying = new Set<string>()
  for (const [id, values] of seen) if (values.size > 1) varying.add(id)
  return varying
}

/** Stable key for a variant's non-effort, actually-varying dimensions. */
function splitSignature(params: VariantParam[], varying: Set<string>): string {
  return params
    .filter(p => !isEffortDimension(p.id) && varying.has(p.id))
    .map(p => `${p.id}=${p.value}`)
    .sort()
    .join(",")
}

/** `fast=true` → `-fast`; falsey flags and constant dimensions contribute nothing. */
function suffixFor(params: VariantParam[], varying: Set<string>): string {
  const parts: string[] = []
  const relevant = params.filter(p => !isEffortDimension(p.id) && varying.has(p.id)).sort((a, b) => a.id.localeCompare(b.id))
  for (const p of relevant) {
    if (p.value === "false" || p.value === "") continue
    parts.push(p.value === "true" ? p.id : `${p.id}-${p.value}`)
  }
  return parts.length > 0 ? `-${parts.join("-")}` : ""
}

/** Per-host declaration of which thinking levels a model supports. */
export function thinkingConfigFor(levels: HostThinkingLevel[], profile: PiHostProfile): Record<string, unknown> {
  if (levels.length === 0) return {}
  const ordered = HOST_THINKING_LEVELS.filter(level => levels.includes(level))

  if (profile.id === "pi") {
    // pi: `thinkingLevelMap` — a level is offered unless mapped to null;
    // `xhigh`/`max` additionally require an explicit entry.
    const map: Record<string, string | null> = {}
    for (const level of HOST_THINKING_LEVELS) {
      if (ordered.includes(level)) map[level] = level
      else if (level !== "xhigh" && level !== "max") map[level] = null
    }
    return { thinkingLevelMap: map }
  }

  // omp: `thinking.efforts`, an explicit ordered list.
  return { thinking: { mode: "effort", efforts: ordered, defaultLevel: ordered[Math.floor(ordered.length / 2)] } }
}

export type ExpandedVariantModel = {
  /** Host-facing model id (base id, plus a suffix for non-effort dimensions). */
  id: string
  /** The model id the plugin itself knows — what `languageModel()` must receive. */
  baseId: string
  /** Display suffix appended to the model name, e.g. " Fast". */
  nameSuffix: string
  /** Thinking levels this entry offers, if any. */
  levels: HostThinkingLevel[]
  /** Provider options per thinking level — the variant's own options object, verbatim. */
  optionsByLevel: Record<string, Record<string, unknown>>
  /** Provider options when no level is selected (or the model has no effort axis). */
  defaultOptions: Record<string, unknown>
}

/**
 * Non-effort dimensions allowed to split a model into separate host entries.
 *
 * Only `fast`: context tiers already arrive as separate OpenCode entries
 * (`gpt-5.6-sol` / `gpt-5.6-sol-1m`), so between the two mechanisms a family
 * reaches at most four entries — {fast, non-fast} × {1M, non-1M} — each with
 * its own effort picker.
 */
export const DEFAULT_SPLIT_DIMENSIONS: readonly string[] = ["fast"]

/**
 * Value chosen for a varying dimension that is *not* allowed to split. Prefers
 * `true` for boolean-ish dimensions — for Cursor that keeps Claude's `thinking`
 * variant, which is the one worth having for agentic use.
 */
function preferredValue(values: Set<string>): string {
  if (values.has("true")) return "true"
  return [...values][0]!
}

export type ExpandOptions = {
  /** Non-effort dimensions permitted to create separate model entries. */
  splitDimensions?: readonly string[]
}

/**
 * Expand one OpenCode model entry into the host model entries it should
 * produce. A model with no variants yields exactly one entry with no thinking
 * levels, so callers can treat both cases uniformly.
 */
export function expandModelVariants(
  modelId: string,
  entry: OpenCodeModelEntry,
  options: ExpandOptions = {},
): ExpandedVariantModel[] {
  const splitDimensions = new Set(options.splitDimensions ?? DEFAULT_SPLIT_DIMENSIONS)
  const variants = (entry as { variants?: Record<string, Record<string, unknown>> }).variants
  if (!variants || Object.keys(variants).length === 0) {
    return [{ id: modelId, baseId: modelId, nameSuffix: "", levels: [], optionsByLevel: {}, defaultOptions: {} }]
  }

  const allParams = Object.values(variants).map(extractVariantParams)
  const varyingAll = varyingDimensions(allParams)

  // Dimensions that vary but may neither split nor drive the effort picker
  // (e.g. Claude's `thinking`) collapse to one preferred value; variants that
  // disagree with it are dropped entirely.
  const collapsed = new Map<string, string>()
  for (const dim of varyingAll) {
    if (splitDimensions.has(dim) || isEffortDimension(dim)) continue
    const values = new Set<string>()
    for (const params of allParams) {
      const found = params.find(p => p.id === dim)
      if (found) values.add(found.value)
    }
    collapsed.set(dim, preferredValue(values))
  }

  const varying = new Set([...varyingAll].filter(dim => !collapsed.has(dim)))

  // Group variants by their splitting dimensions; each group becomes one entry.
  const groups = new Map<string, { params: VariantParam[]; byLevel: Record<string, Record<string, unknown>>; any: Record<string, unknown> }>()
  for (const variantOptions of Object.values(variants)) {
    const params = extractVariantParams(variantOptions)
    const matchesCollapsed = [...collapsed].every(([dim, value]) => {
      const found = params.find(p => p.id === dim)
      return !found || found.value === value
    })
    if (!matchesCollapsed) continue

    const options = variantOptions
    const signature = splitSignature(params, varying)
    const group = groups.get(signature) ?? { params, byLevel: {}, any: options }
    const rawEffort = params.find(p => isEffortDimension(p.id))?.value
    const level = rawEffort ? toHostLevel(rawEffort) : undefined
    // Keep the first variant per level: providers may expose several raw values
    // that alias to one host level (e.g. `xhigh` and `extra-high`).
    if (level && !group.byLevel[level]) group.byLevel[level] = options
    groups.set(signature, group)
  }

  // The group with no active non-effort flags keeps the bare model id.
  const expanded: ExpandedVariantModel[] = []
  for (const group of groups.values()) {
    const suffix = suffixFor(group.params, varying)
    const levels = Object.keys(group.byLevel).filter(isHostThinkingLevel)
    expanded.push({
      id: `${modelId}${suffix}`,
      baseId: modelId,
      nameSuffix: suffix
        ? ` ${suffix
            .slice(1)
            .split("-")
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ")}`
        : "",
      levels,
      optionsByLevel: group.byLevel,
      // With no effort axis the group still has one options object to send.
      defaultOptions: levels.length > 0 ? {} : group.any,
    })
  }
  return expanded
}

/** Resolve the provider options for a chosen thinking level, falling back sensibly. */
export function optionsForLevel(model: ExpandedVariantModel, level: string | undefined): Record<string, unknown> {
  if (level && model.optionsByLevel[level]) return model.optionsByLevel[level]
  if (model.levels.length > 0) {
    const fallback = model.levels[Math.floor(model.levels.length / 2)]!
    return model.optionsByLevel[fallback] ?? model.defaultOptions
  }
  return model.defaultOptions
}
