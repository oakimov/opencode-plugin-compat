# Kilo M1 — reference patch outline

**Target:** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) (OpenCode-derived host)  
**Fork (PR source):** [oakimov/kilocode](https://github.com/oakimov/kilocode)  
**OCP packages:** [`@opencode-compat/facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)  
**HostProfile id:** `kilo`  
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

These are **reference outlines** for an upstream (or fork) PR — not a drop-in `git am` patch. Apply against [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) after pinning OCP package versions.

**Pinned upstream tip when drafted:** `Kilo-Org/kilocode@main`

---

## PR status

| Layer | Status | Branch / notes |
|-------|--------|----------------|
| **B — opt-in `.opencode` scan** | Landed as PR candidate | `ocp/m1-opt-in-opencode-scan` on [oakimov/kilocode](https://github.com/oakimov/kilocode) |
| **A — install overrides** | Outline only | Needs published `@opencode-compat/*` (or git workspace install) |
| **E — host kit embed** | Outline only | Needs provider-resolve seam + host kit |

---

## 1. Install-time facade overrides (Layer A)

**Seam:** [packages/core/src/npm.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/npm.ts) — `Npm.add` / `reify` under `global.cache/packages/<pkg>`.

**Also:** [packages/opencode/src/plugin/shared.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/shared.ts) — `resolvePluginTarget` → `Npm.add`.

**Note:** [packages/opencode/src/plugin/index.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/index.ts) already comments that external auth plugins ship against `@opencode-ai/plugin` and bridge to `@kilocode/plugin` types — facade overrides are the product path for full OCP.

Wherever Kilo installs npm plugins into the cache, add Bun/npm overrides so OpenCode plugins resolve facades:

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

Until `@opencode-compat/*` is on the public registry, pin from this monorepo:

```json
{
  "@opencode-ai/plugin": "github:oakimov/opencode-plugin-compat#main&path:packages/facade-plugin",
  "@opencode-ai/sdk": "github:oakimov/opencode-plugin-compat#main&path:packages/facade-sdk"
}
```

Ensure `@opencode-compat/*` packages are reachable from the plugin install tree.

Classic Hooks keys are already identical to OpenCode 1.18.3 core — T1 is primarily this override + adapter dispatch to `@kilocode/plugin`.

---

## 2. Opt-in `.opencode` project scan (Layer B / T2)

**Seam:** [packages/opencode/src/config/paths.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/paths.ts) — `ConfigPaths.directories`.

**Flag:** [packages/core/src/flag/flag.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/flag/flag.ts) — add `KILO_OCP_SCAN_OPENCODE`.

Today Kilo scans **`.kilo` / `.kilocode`** only. Kilo also has a **migrate notice** for leftover `.opencode` dirs (`KilocodeConfig.detectOpencodeConfig`) — default behavior must stay unchanged.

Add an **opt-in** dual-scan (env flag, not silent):

```ts
const projectTargets = [
  ".kilocode",
  ".kilo",
  ...(Flag.KILO_OCP_SCAN_OPENCODE ? [".opencode"] : []),
]
```

Suggested env: `KILO_OCP_SCAN_OPENCODE=1` (truthy `1`/`true`).

If upstream refuses dual-scan, document the copy-to-`.kilo` workaround for local plugins; keep `compatProjectDirs: [".opencode"]` on the HostProfile for matrix `--compat-scan` testing of the patch.

---

## 3. Embed `host-promise-v2` (Layer E / T3)

**Seam (start here):** [packages/opencode/src/provider/provider.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/provider/provider.ts) at provider / language-model resolve time.

**Plugin load path:** [packages/opencode/src/plugin/loader.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/loader.ts) + [packages/opencode/src/plugin/index.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/index.ts).

At provider-resolve time, call into the shared kit:

```ts
import {
  createPluginContext,
  injectLanguageModel,
  resolveProvider,
  type PromisePlugin,
} from "@opencode-compat/host-promise-v2"

const ctx = createPluginContext(options, { id: pluginId })
await promisePlugin.setup(ctx)
const { language } = await injectLanguageModel(ctx, { providerID, modelID })
// or: const { language, sdk } = await resolveProvider(ctx, { providerID, modelID })
// if language set → use as LanguageModelV3
```

Until this embed exists, `capabilities.promiseV2` stays `false` and `v2/promise` facade throws with an upgrade path.

---

## 4. Telemetry note (non-runtime)

Kilo ships PostHog telemetry. OCP does **not** kill telemetry via a plugin. Point operators at in-app / env opt-out:

- See [`docs/guides/kilocode-telemetry-disable.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/kilocode-telemetry-disable.md)
- Prefer `KILO_TELEMETRY_LEVEL` / settings UI — never claim an OCP hook disables analytics

---

## 5. Verification

```bash
OPENCODE_COMPAT_HOST=kilo opencode-compat doctor
opencode-compat matrix --host kilo
# after opt-in dual-scan PR:
KILO_OCP_SCAN_OPENCODE=1 opencode-compat matrix --host kilo --compat-scan
```

Expected T1 cells green for classic fixtures; T2 green with `--compat-scan` or native `scansDotOpencode`; T3 green only after §3 embed.
