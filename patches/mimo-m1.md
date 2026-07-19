# MiMo M1 — reference patch outline

**Target:** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)  
**OCP packages:** `@opencode-compat/facade-plugin`, `facade-sdk`, `adapter`, `host-promise-v2`  
**HostProfile id:** `mimo`

These are **reference outlines** for an upstream (or fork) PR — not a drop-in git am patch. Apply in the MiMo tree after pinning OCP package versions.

---

## 1. Install-time facade overrides (Layer A)

Wherever MiMo installs npm plugins into the cache (typically under `~/.cache/mimocode/packages` or `$MIMOCODE_HOME/cache/packages`), add Bun/npm overrides so OpenCode plugins resolve facades:

```json
{
  "@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@0.1.0",
  "@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@0.1.0"
}
```

Generate with:

```bash
opencode-compat overrides
```

Ensure `@opencode-compat/*` packages are reachable from the plugin install tree (workspace link, vendored tarball, or registry).

---

## 2. Dual-scan `.opencode` (Layer B / T2)

Today MiMo scans **`.mimocode` only** (docs mention `.opencode` — bug #1151).

In `ConfigPaths.directories` (or equivalent), append `.opencode` **after** `.mimocode` so native wins on conflict:

```ts
// illustrative
projectDirs: [".mimocode", ".opencode"]
```

After this lands, OCP profile should effectively behave as `scansDotOpencode: true` (or keep the flag false and set `compatScanEnabled` in the matrix when testing the PR).

---

## 3. Embed `host-promise-v2` (Layer E / T3)

At provider-resolve time, call into the shared kit:

```ts
import {
  createPluginContext,
  injectLanguageModel,
  type PromisePlugin,
} from "@opencode-compat/host-promise-v2"

// For each Promise v2 plugin module:
const ctx = createPluginContext(options, { id: pluginId })
await promisePlugin.setup(ctx)
const { language } = await injectLanguageModel(ctx, { providerID, modelID })
// if language set → use as LanguageModelV3
```

Until this embed exists, `capabilities.promiseV2` stays `false` and `v2/promise` facade throws with an upgrade path.

---

## 4. Optional hygiene (classic gaps)

MiMo 0.1.6 lacks `dispose` and `experimental.provider.small_model` vs OCP core:

| Hook | OCP 0.1 policy until upstream adds |
|------|-------------------------------------|
| `dispose` | Accept on facade; no-op + doctor warning |
| `experimental.provider.small_model` | Same |

Prefer adding the hooks to `@mimo-ai/plugin` types + runtime invoke. Until then, `normalizeHooks` / doctor warnings cover the gap.

**Do not** surface MiMo `actor.*` / `session.*` on the portable `@opencode-ai/plugin` path (ADR-7).

---

## 5. Telemetry note (non-runtime)

MiMo ships Xiaomi usage analytics **on by default**. OCP does **not** kill telemetry via a plugin. Point operators at the in-app env opt-out:

- See `docs/guides/mimocode-telemetry-disable.md`
- Prefer `export MIMOCODE_ENABLE_ANALYSIS=false` — never claim an OCP hook disables analytics
- Opt-out gates **usage analysis** only; hosted MiMo Auto / Xiaomi inference traffic is separate

---

## 6. Verification

```bash
OPENCODE_COMPAT_HOST=mimo opencode-compat doctor
opencode-compat matrix --host mimo
# after dual-scan PR:
opencode-compat matrix --host mimo --compat-scan
```

Expected T1 cells green for classic fixtures; T3 green only after §3 embed.