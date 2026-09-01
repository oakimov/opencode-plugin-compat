export const DSH_BRIDGE_SETTINGS_NS = "dsh-bridge"

export type DshBridgeProviderProfile = {
  apiKeyEnv?: string
  displayName?: string
}

export type DshBridgeSettings = {
  providers: Record<string, DshBridgeProviderProfile>
}

export function settingsPathFor(provider: string): string[] {
  return ["providers", provider]
}

export function createSettingsSchema(): ((data: unknown) => DshBridgeSettings) & {
  type: string
  meta: { default: DshBridgeSettings }
  dict: Record<string, unknown>
  toJSON: () => unknown
} {
  const apiKeyEnv = { type: "string", meta: { role: "credential-ref" } }
  const displayName = { type: "string", meta: {} }
  const profile = {
    type: "object",
    meta: { default: {} },
    dict: { apiKeyEnv, displayName },
  }
  const providers = {
    type: "dict",
    meta: { default: {} },
    inner: profile,
    sKey: { type: "string", meta: {} },
  }
  const validate = (data: unknown): DshBridgeSettings => {
    const raw = (data as { providers?: unknown } | null)?.providers
    const out: Record<string, DshBridgeProviderProfile> = {}
    if (raw === undefined || raw === null) return { providers: out }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("dsh-bridge settings: providers must be a dict")
    }
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (id.length === 0) throw new Error("dsh-bridge settings: empty provider id")
      if (value == null) continue
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`dsh-bridge settings: providers.${id} must be an object`)
      }
      const rec = value as Record<string, unknown>
      const next: DshBridgeProviderProfile = {}
      if (typeof rec.apiKeyEnv === "string" && rec.apiKeyEnv.length > 0) next.apiKeyEnv = rec.apiKeyEnv
      if (typeof rec.displayName === "string" && rec.displayName.length > 0) next.displayName = rec.displayName
      out[id] = next
    }
    return { providers: out }
  }
  return Object.assign(validate, {
    type: "object",
    meta: { default: { providers: {} } },
    dict: { providers },
    toJSON() {
      return {
        uid: 7,
        refs: {
          1: { type: "string", meta: { role: "credential-ref" } },
          2: { type: "string", meta: {} },
          3: { type: "object", meta: { default: {} }, dict: { apiKeyEnv: 1, displayName: 2 } },
          5: { type: "string", meta: {} },
          6: { type: "dict", meta: { default: {} }, inner: 3, sKey: 5 },
          7: { type: "object", meta: { default: {} }, dict: { providers: 6 } },
        },
      }
    },
  })
}

type SettingsHost = {
  inject?: (deps: string[], fn: (ctx: {
    settings: {
      installSection: (
        owner: unknown,
        ns: string,
        schema: unknown,
        entry: DshBridgeSettings,
        hooks: { setSource: (source: () => DshBridgeSettings) => void; onChange: () => void },
      ) => void
    }
  }) => void) => void
}

export function installDshBridgeSettings(ctx: SettingsHost, entry: DshBridgeSettings): void {
  const schema = createSettingsSchema()
  ctx.inject?.(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, DSH_BRIDGE_SETTINGS_NS, schema, entry, {
      setSource: () => {},
      onChange: () => {},
    })
  })
}
