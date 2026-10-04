/**
 * DSH Settings → Models contract ("profile-owned live configuration"): a
 * plugin's live settings are the `.volatile()` fields of its own Cordis
 * `Config`, addressed by the plugin's profile entry id. A provider row is
 * listed as configured when the adapter's directory entry points at a value
 * inside that volatile Config. The bridge therefore exposes its `providers`
 * rows (the `cordis.patch.yml` specs) as one volatile field.
 */

/** Only the Schemastery surface this schema uses, kept structural. */
type SchemaNode = {
  required(): SchemaNode
  role(text: string): SchemaNode
  default(value: unknown): SchemaNode
  volatile(): SchemaNode
}
type SchemaFactory = {
  object(dict: Record<string, SchemaNode>): SchemaNode
  array(inner: SchemaNode): SchemaNode
  string(): SchemaNode
}

/**
 * Declare only what Settings reads. Schemastery objects are non-strict, so
 * every other provider-spec field is preserved untouched; declaring them would
 * materialize absent arrays and dicts (`models: []`) and change their meaning.
 */
export function createConfigSchema(z: SchemaFactory): SchemaNode {
  return z.object({
    providers: z.array(z.object({
      package: z.string().required(),
      apiKeyEnv: z.string().role("credential-ref"),
    })).default([]).volatile(),
  })
}

/**
 * Resolve the host's Schemastery lazily: it exists only inside DSH, which
 * routes the optional peer to its installed copy. Elsewhere the bridge keeps
 * an unvalidated Config and manual validation in `apply`.
 */
export async function loadConfigSchema(): Promise<SchemaNode | undefined> {
  const specifier = "@deepseek-ai/schemastery"
  try {
    const mod = await import(specifier) as { default?: SchemaFactory } & Partial<SchemaFactory>
    const z = mod.default ?? mod as SchemaFactory
    return typeof z.object === "function" ? createConfigSchema(z) : undefined
  } catch {
    return undefined
  }
}

/** Read the providers snapshot from a volatile reference or a plain config. */
export function providerSpecs(config: unknown): unknown {
  const raw = (config as { providers?: unknown } | null | undefined)?.providers
  const value = raw !== null && typeof raw === "object" && typeof (raw as { get?: unknown }).get === "function"
    ? (raw as { get(): unknown }).get()
    : raw
  // Volatile snapshots are frozen; registration owns its own copies.
  return value === undefined ? value : structuredClone(value)
}

/** Settings address of one provider row: this entry's id and its `providers` index. */
export type SettingsAddress = { settingsNs: string; settingsPath: string[] }

export function settingsAddress(entryId: string | undefined, index: number): SettingsAddress | undefined {
  return entryId ? { settingsNs: entryId, settingsPath: ["providers", String(index)] } : undefined
}
