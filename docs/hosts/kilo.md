# Kilo — OCP enablement notes

**Host (reference only):** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)
**User-facing package:** [`@opencode-compat/ocp`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/ocp) (umbrella + `ocp setup`)
**Bridge packages (internal):** [`facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)
**HostProfile id:** `kilo`
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

OCP attaches as an **external compatibility layer**. Kilo is a read-only host reference.

---

## 1. Install-tree facade overrides (Layer A)

Where the host installs npm plugins ([packages/core/src/npm.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/npm.ts), [packages/opencode/src/plugin/shared.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/shared.ts)), OpenCode plugins should resolve OCP facades via install overrides:

```json
{
  "@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@0.1.x",
  "@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@0.1.x"
}
```

(`ocp setup --mode npm` writes the concrete published train version.)

**Preferred UX:** follow the step-by-step guide in [**INSTALL.md**](../../INSTALL.md) (install `@opencode-compat/ocp` from npm → install consumer plugins → `ocp setup --mode npm`). Equivalent CLI names: `compat setup` / print-only `compat overrides` / `opencode-compat overrides`.

```bash
# summary — full steps in INSTALL.md
bun add -g @opencode-compat/ocp
kilo plugin -g cursor-opencode-provider
ocp setup --host kilo --mode npm
```

Kilo installs each npm plugin into an **isolated** child dir (same OpenCode-style `packages/<name>@<version>/` layout as MiMo). A root-level `packages/package.json` override alone is **not** enough — `ocp setup --deep` (default) patches those children and auto-reifies when they already have `node_modules`. **Re-run `ocp setup` after installing or upgrading plugins.**

Listing OCP itself in `plugin` is optional bootstrap only — it does **not** intercept other plugins’ `@opencode-ai/plugin` imports.

From this checkout, `--mode auto` may use local `file:` facade paths; published installs use `--mode npm`. See [`INSTALL.md`](../../INSTALL.md) and [`npm-publish.md`](../guides/npm-publish.md).

Classic Hooks keys already match OpenCode 1.18.3 core — T1 is primarily override + adapter dispatch to `@kilocode/plugin`.

---

## 1.1 Option B — provider shims are identity on Kilo

Kilo’s `SessionProcessor` already has `ensureToolCall`, so bare AI SDK `tool-call` parts work without a preamble. Kilo’s `bash` `description` is **optional**. Stock OpenCode plugins (including `cursor-opencode-provider`) therefore do **not** need a host fork such as [`cursor-kilocode-provider`](https://github.com/renaudcerrato/cursor-kilocode-provider) when OCP Layer A is installed.

**OCP policy (HostProfile `kilo`):**

| Capability | Value | OCP adoption |
|------------|-------|--------------|
| `streamToolCallEnsure` | `true` | Pass-through (no synthetic `tool-input-start`) |
| `bashDescriptionRequired` | `false` | Pass-through (do not invent `description`) |

`ocp setup --host kilo` still writes the same **in-place entry** shim layout as MiMo (classic plugins often load `file://…/dist/index.js` directly). At runtime the shim detects `kilo` and `wrapProviderModule` returns the original module unchanged. Use `--no-provider-shim` only when you intentionally skip Option B.

Keep plugins **stock** — do not recreate per-host provider forks; host-specific stream/arg adoption belongs in OCP only.

---

## 2. Project dirs / `.opencode` (Layer B / T2)

Kilo scans **`.kilo` / `.kilocode`** in [ConfigPaths.directories](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/paths.ts). It may warn about leftover `.opencode` dirs for migration; default is native-only.

OCP’s `kilo` profile keeps `compatProjectDirs: [".opencode"]` for matrix `--compat-scan`. Operators who need OpenCode project plugins can copy/symlink into `.kilo`.

---

## 3. Promise v2 / `host-promise-v2` (Layer E / T3)

Kilo does **not** publish a portable `@opencode-ai/plugin/v2/promise` path for arbitrary OpenCode plugins. OCP supplies Promise v2 via `@opencode-compat/host-promise-v2` + facade overrides.

```ts
import { wirePromiseV2 } from "@opencode-compat/ocp"

const host = wirePromiseV2({ env: { OPENCODE_COMPAT_HOST: "kilo" } })
await host.register(plugin)
await host.resolveProvider({ providerID, modelID, package: pkg })
```

`HostProfile` for `kilo` sets `capabilities.promiseV2` / `aisdkProviderHooks` to **true** (OCP-layer kit). Live Kilo provider-resolve must call into `resolveProvider` from a sidecar/operator helper — host source stays read-only.

Reference host files (read-only): [packages/opencode/src/provider/provider.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/provider/provider.ts), [packages/opencode/src/plugin/loader.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/loader.ts).

---

## 4. Telemetry (non-runtime)

OCP does **not** kill Kilo PostHog. See [`docs/guides/kilocode-telemetry-disable.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/kilocode-telemetry-disable.md).

---

## 5. Verification

```bash
OPENCODE_COMPAT_HOST=kilo opencode-compat doctor
opencode-compat matrix --host kilo
opencode-compat matrix --host kilo --compat-scan
```

Doctor should report `streamToolCallEnsure: true` and `bashDescriptionRequired: false`.

**Live smoke (classic + Option B):** after installing an unchanged OpenCode plugin + `ocp setup --host kilo`, confirm the install-tree shim files exist (same layout as MiMo §1.1) and model/provider listing still surfaces plugin models when auth/cache is available. Runtime adoption is identity for Kilo — tool-calls work via host `ensureToolCall`, not via a provider fork.

**Live smoke (Promise v2):** import the unchanged `plugin/v2` entry from the Kilo install tree, then `wirePromiseV2({ env: { OPENCODE_COMPAT_HOST: "kilo" } })` → `register` → `resolveProvider`. Native Kilo provider-resolve still needs that external sidecar/operator call (see §3).