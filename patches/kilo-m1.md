# Kilo M1 — reference patch outline

**Target:** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) (OpenCode-derived host)  
**OCP packages:** `@opencode-compat/facade-plugin`, `facade-sdk`, `adapter`, `host-promise-v2`  
**HostProfile id:** `kilo`  
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

These are **reference outlines** for an upstream (or fork) PR — not a drop-in git am patch. Apply in the Kilo tree after pinning OCP package versions.

---

## 1. Install-time facade overrides (Layer A)

Wherever Kilo installs npm plugins into the cache (typically `~/.cache/kilo/packages` or `$XDG_CACHE_HOME/kilo/packages`), add Bun/npm overrides so OpenCode plugins resolve facades:

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

Classic Hooks keys are already identical to OpenCode 1.18.3 core — T1 is primarily this override + adapter dispatch to `@kilocode/plugin`.

---

## 2. Opt-in `.opencode` project scan (Layer B / T2)

Today Kilo scans **`.kilo` / `.kilocode`** only.

Add an **opt-in** dual-scan (prefer a config flag / env, not silent behavior change):

```ts
// illustrative — append after native dirs when enabled
projectDirs: [".kilo", ".kilocode", ...(scanOpencode ? [".opencode"] : [])]
```

Suggested env: `KILO_OCP_SCAN_OPENCODE=1` or config `experimental.ocpScanOpencode: true`.

If upstream refuses dual-scan, document the copy-to-`.kilo` workaround for local plugins; keep `compatProjectDirs: [".opencode"]` on the HostProfile for matrix `--compat-scan` testing of the patch.

---

## 3. Embed `host-promise-v2` (Layer E / T3)

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

- See `docs/guides/kilocode-telemetry-disable.md`
- Prefer `KILO_TELEMETRY_LEVEL` / settings UI — never claim an OCP hook disables analytics

---

## 5. Verification

```bash
OPENCODE_COMPAT_HOST=kilo opencode-compat doctor
opencode-compat matrix --host kilo
# after opt-in dual-scan PR:
opencode-compat matrix --host kilo --compat-scan
```

Expected T1 cells green for classic fixtures; T2 green with `--compat-scan` or native `scansDotOpencode`; T3 green only after §3 embed.
