# MiMo M1 — reference patch outline

**Target:** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)  
**Fork (PR source):** [oakimov/MiMo-Code](https://github.com/oakimov/MiMo-Code)  
**OCP packages:** [`@opencode-compat/facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)  
**HostProfile id:** `mimo`

These are **reference outlines** for an upstream (or fork) PR — not a drop-in `git am` patch. Apply against [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) after pinning OCP package versions.

**Pinned upstream tip when drafted:** `XiaomiMiMo/MiMo-Code@main`

---

## PR status

| Layer | Status | Branch / notes |
|-------|--------|----------------|
| **B — dual-scan `.opencode`** | Upstream PR open | [XiaomiMiMo/MiMo-Code#1810](https://github.com/XiaomiMiMo/MiMo-Code/pull/1810) (`ocp/m1-dual-scan-opencode`) |
| **A — install overrides** | Outline only | Needs published `@opencode-compat/*` (or git workspace install) |
| **E — host kit embed** | Outline only | Needs provider-resolve seam + host kit |

---

## 1. Install-time facade overrides (Layer A)

**Seam:** [packages/opencode/src/npm/index.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/npm/index.ts) — `Npm.add` / `reify` installs under `Global.Path.cache/packages/<pkg>` via Arborist.

**Also:** [packages/opencode/src/plugin/shared.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/shared.ts) — `resolvePluginTarget` → `Npm.add`.

Wherever MiMo installs npm plugins into the cache, ensure the install tree’s `package.json` carries Bun/npm overrides so OpenCode plugins resolve facades:

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

Until `@opencode-compat/*` is on the public registry, pin from this monorepo (example npm/Bun git+workspace form):

```json
{
  "@opencode-ai/plugin": "github:oakimov/opencode-plugin-compat#main&path:packages/facade-plugin",
  "@opencode-ai/sdk": "github:oakimov/opencode-plugin-compat#main&path:packages/facade-sdk"
}
```

Ensure `@opencode-compat/*` packages are reachable from the plugin install tree (registry, vendored tarball, or git path).

**Do not** override `@opencode-ai/plugin` straight to `@mimo-ai/plugin` — that skips OCP v2/doctor/host kit.

---

## 2. Dual-scan `.opencode` (Layer B / T2)

**Seam:** [packages/opencode/src/config/paths.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/config/paths.ts) — `ConfigPaths.directories`.

Today MiMo walks **`.mimocode` only** (docs historically mention `.opencode` — bug #1151 class).

**Patch (always-on; native first):**

```ts
const projectTargets = [".mimocode", ".opencode"]
```

Use `projectTargets` for both the project `afs.up` walk and the home walk. Keep `.mimocode` **before** `.opencode` so native wins on conflict.

Flags already consulted by this function (do not rename):

- `Flag.MIMOCODE_DISABLE_PROJECT_CONFIG` — [packages/opencode/src/flag/flag.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/flag/flag.ts)
- `Flag.MIMOCODE_CONFIG_DIR`

After this lands, matrix `--compat-scan` / `scansDotOpencode` effectively becomes true for MiMo T2 cells.

---

## 3. Embed `host-promise-v2` (Layer E / T3)

**Seam (start here):** [packages/opencode/src/provider/provider.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/provider/provider.ts) at provider / language-model resolve time.

**Plugin load path:** [packages/opencode/src/plugin/loader.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/loader.ts) + [packages/opencode/src/plugin/index.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/index.ts) (classic `@mimo-ai/plugin` today).

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

Upstream OpenCode reference for Promise v2 host shape: [anomalyco/opencode](https://github.com/anomalyco/opencode) / research tree patterns under `packages/core/src/plugin/` (`promise` / `aisdk`).

---

## 4. Optional hygiene (classic gaps)

MiMo plugin surface lacks `dispose` and `experimental.provider.small_model` vs OCP core:

| Hook | OCP 0.1 policy until upstream adds |
|------|-------------------------------------|
| `dispose` | Accept on facade; no-op + doctor warning |
| `experimental.provider.small_model` | Same |

Prefer adding the hooks to [`@mimo-ai/plugin`](https://github.com/XiaomiMiMo/MiMo-Code/tree/main/packages/plugin) types + runtime invoke. Until then, `normalizeHooks` / doctor warnings cover the gap.

**Do not** surface MiMo `actor.*` / `session.*` on the portable `@opencode-ai/plugin` path (ADR-7).

---

## 5. Telemetry note (non-runtime)

MiMo ships Xiaomi usage analytics **on by default**. OCP does **not** kill telemetry via a plugin. Point operators at the in-app env opt-out:

- See [`docs/guides/mimocode-telemetry-disable.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/mimocode-telemetry-disable.md)
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