# OpenCode clones — MiMo, Kilo, ZCode

The OpenCode clone/fork family. **MiMo Code** (`mimocode`) and **Kilo Code**
(`kilocode`) are OpenCode forks that ship their own OpenCode-shaped native
plugin packages, so OCP runs **unchanged** OpenCode plugins on them through
facades. **ZCode** is an OpenCode-adjacent host whose marketplace ABI is not the
OpenCode plugin ABI — it is detect/doctor only, covered in [§5](#5-zcode--not-a-load-target).

This page is the complete guide for these hosts: mechanism, install, per-host
internals, and verification. The other family — `pi` / `oh-my-pi` — uses a
different mechanism entirely; see [pi-family.md](./pi-family.md).

**Contents**

- [1. Mechanism: facades, not forks](#1-mechanism-facades-not-forks)
- [2. Install](#2-install)
- [3. MiMo Code (`mimo`)](#3-mimo-code-mimo)
- [4. Kilo Code (`kilo`)](#4-kilo-code-kilo)
- [5. ZCode — not a load target](#5-zcode--not-a-load-target)
- [6. Troubleshooting](#6-troubleshooting)

---

## 1. Mechanism: facades, not forks

MiMo and Kilo have their own native plugin packages (`@mimo-ai/plugin`,
`@kilocode/plugin`). OCP is an **external compatibility layer** — it does not
patch host source and does not fork plugins. An unmodified plugin's
`@opencode-ai/plugin` / `@opencode-ai/sdk` imports are made to resolve to
**facades** (`@opencode-compat/facade-plugin`, `@opencode-compat/facade-sdk`)
that delegate to the host's native package, driven by one universal adapter +
`HostProfile` data (see [`packages/profile`](../../packages/profile/README.md)).

Concretely, the host's plugin install tree gets these overrides:

```json
{
  "@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@0.1.x",
  "@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@0.1.x"
}
```

Writing them is the job of the **`ocp` CLI** — you do not hand-edit anything:

```bash
ocp setup --host <host> --mode npm
```

Do **not** override `@opencode-ai/plugin` straight to `@mimo-ai/plugin` /
`@kilocode/plugin` — that skips OCP (v2 surface, doctor, shared host kit). Do
**not** install per-host forks of consumer plugins such as
`cursor-kilocode-provider`; keep the stock npm package and close gaps in the
bridge.

Both hosts install each npm plugin into an **isolated** child dir
(`<cache>/packages/<name>@<version>/`). Listing OCP itself in the host `plugin`
array does **not** intercept other plugins' imports — a root-level override
alone is not enough either. `ocp setup --deep` (the default) patches those child
trees and reifies them. **Re-run `ocp setup` after installing or upgrading any
plugin** — hosts restore stock files from the tarball on install/upgrade.

---

## 2. Install

### 2.1 Prerequisites

| Requirement | Notes |
|-------------|--------|
| [Bun](https://bun.sh) ≥ 1.2 | Required to run the `ocp` CLI (`#!/usr/bin/env bun`) |
| npm | Used by `ocp setup` to reify install-tree overrides |
| A supported host | **MiMo Code** (`mimo`) or **Kilo Code** (`kilo` / `kilocode`) on your `PATH` |

Confirm the host binary with `mimo --version` or `kilo --version`.

### 2.2 Install OCP (once)

```bash
bun add -g @opencode-compat/ocp
ocp --help
```

This installs the `ocp` binary and pulls the bridge packages (`facade-*`,
`adapter`, …) as transitive dependencies.

### 2.3 Install a plugin and wire it

[`cursor-opencode-provider`](https://www.npmjs.com/package/cursor-opencode-provider)
is used as the example throughout. Install it **unchanged** with the host.

**MiMo Code**

```bash
mimo plugin -g cursor-opencode-provider
ocp setup --host mimo --mode npm
```

MiMo records the plugin in `~/.config/mimocode/mimocode.json` (or your
`MIMOCODE_HOME` layout) and unpacks it under
`~/.cache/mimocode/packages/cursor-opencode-provider@latest/`:

```json
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "plugin": ["cursor-opencode-provider"]
}
```

**Kilo Code**

```bash
kilo plugin -g cursor-opencode-provider
ocp setup --host kilo --mode npm
```

Kilo records it in its global config (commonly `~/.config/kilo/opencode.json`)
and unpacks under `~/.cache/kilo/packages/cursor-opencode-provider@latest/`:

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["cursor-opencode-provider"]
}
```

**Project-local:** omit `-g` to install into the current project instead of
global config, then run the same `ocp setup`.

### 2.4 What `ocp setup --mode npm` does

For the detected (or `--host`) plugin install root, setup:

1. Writes install-tree **overrides** mapping `@opencode-ai/plugin` /
   `@opencode-ai/sdk` to the OCP facades.
2. **Deep-patches** each child plugin `package.json` (required on MiMo/Kilo).
3. Runs **`npm install`** (reify) when `node_modules` already exists so the
   overrides link.
4. Writes **in-place provider entry shims** (default) for LanguageModel /
   stream adoption on hosts that need it — see [§3.2](#32-option-b--in-place-provider-entry-shims).
   Use `--no-provider-shim` to skip.
5. For **absolute-path / `file://` plugins** listed in the host config,
   symlinks `@opencode-ai/{plugin,sdk}` → OCP facades inside each checkout
   (install-tree overrides never reach those). Use `--no-absolute-plugins` to
   skip.

Useful flags:

```bash
ocp setup --host mimo --mode npm --dry-run          # preview only
ocp setup --host kilo --mode npm --version 0.1.5    # pin the facade train explicitly
ocp setup --dir ~/.cache/mimocode/packages --mode npm   # explicit install root
```

Full option list: `--dir`, `--host`, `--mode auto|npm|file`, `--version`,
`--dry-run`, `--deep`/`--no-deep`, `--reify`/`--no-reify`,
`--provider-shim`/`--no-provider-shim`,
`--absolute-plugins`/`--no-absolute-plugins`. Equivalent CLI names:
`compat setup`, print-only `compat overrides` / `opencode-compat overrides`.

`--version` pins the `@opencode-compat/facade-*` specs written into overrides.
The default is the **current OCP package train** (today **`0.1.5`**), so you
normally omit it. Outside this monorepo always prefer **`--mode npm`** so
overrides resolve from the public registry rather than local `file:` paths.

**Absolute-path / local checkout plugins.** If the host `plugin` array points at
a checkout (absolute path or `file://…/dist/index.js`), that package resolves
`@opencode-ai/*` from **its own** `node_modules`, not the host cache. Default
`--absolute-plugins` rewrites those deps to the facades; re-run setup after
adding or moving such entries. This matters for catalog plugins such as
[`opencode-gateway-provider`](https://www.npmjs.com/package/opencode-gateway-provider):
they call `@opencode-ai/sdk/v2/client` during the classic `config` hook, where
the stock client re-enters in-process `GET /api/model` and **deadlocks**. The
OCP facade polyfills the catalog from [models.dev](https://models.dev) instead.
Keep the plugin unmodified.

### 2.5 Verify

```bash
ocp doctor --host mimo    # or --host kilo
mimo models               # or: kilo models
```

Expect the plugin's models (e.g. `cursor/*`) once the plugin's own auth/cache is
available. Per-host expectations are in [§3.6](#36-verification) and
[§4.5](#45-verification).

### 2.6 After plugin install or upgrade

```bash
mimo plugin -g cursor-opencode-provider -f   # or kilo …
ocp setup --host mimo --mode npm             # or --host kilo
```

### 2.7 Local development

To run an **unpublished OCP checkout** and/or a **local plugin build** against a
real host, use `--mode file` (or the `scripts/*-dev.sh` helpers) instead of
`--mode npm`:

```bash
git clone https://github.com/oakimov/opencode-plugin-compat.git
cd opencode-plugin-compat && bun install && bun run build

# npm-cache plugin, local facades:
mimo plugin -g cursor-opencode-provider
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file

# or point the host config at a checkout and let --absolute-plugins wire it:
#   "plugin": ["/path/to/cursor-opencode-provider/dist/index.js"]
bun packages/ocp/bin/ocp.ts setup --host mimo
```

The `mimo-dev.sh` / `kilo-dev.sh` helpers deliberately start clean in both
directions: they remove all cached versions of the selected plugin and the
local provider checkout's `node_modules`, reinstall checkout dependencies from
the lockfile, then apply the requested state. `local` registers the checkout
path; `npm` writes and force-installs `<plugin>@latest` without restoring a
captured config. Unrelated current config fields are preserved. This is
destructive only to those validated dependency/cache targets and the generated
provider `dist` output.

The full local-dev loop — helper scripts, switching back to npm, cache layout,
and rebuild/reinstall reset steps — is in
[**TESTING.md**](../../TESTING.md).

---

## 3. MiMo Code (`mimo`)

**Host (reference only):** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)
**HostProfile id:** `mimo`

### 3.1 Install tree

MiMo installs npm plugins into its XDG/cache `packages/` tree — see
[packages/opencode/src/npm/index.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/npm/index.ts)
and [packages/opencode/src/plugin/shared.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/shared.ts).
Each plugin gets an isolated child dir
(`~/.cache/mimocode/packages/<name>@<version>/`), which is why `--deep` +
reify are required.

### 3.2 Option B — in-place provider entry shims

MiMo's `SessionProcessor` has **no** `ensureToolCall`: tool parts are created
only on `tool-input-start`. A bare AI SDK `tool-call` (common from stock
Cursor / OpenCode custom providers) therefore never materializes a tool part →
finish `tool-calls` with **zero** tools → empty loop. Separately, MiMo's `bash`
schema requires a string `description` (`z.string()`); stock remaps that omit it
fail validation. MiMo tool schemas also use names such as `file_path`, while
some OpenCode providers emit `filePath`.

**OCP policy (HostProfile `mimo`):**

| Capability | Value | OCP adoption |
|------------|-------|--------------|
| `streamToolCallEnsure` | `false` | Emit `tool-input-start` before bare `tool-call` |
| `bashDescriptionRequired` | `true` | Fill missing `bash.description` only (never swap host tool catalogs) |

Argument spelling is **not** a MiMo-specific policy table. The shim reads the
tools advertised on every LanguageModel call and maps only unique
case/separator variants to their exact schema property names, recursively. That
covers `read`, `write`, `edit`/`StrReplace`, future fork conventions, and MCP
tools without hard-coding any of them; exact, unknown, and ambiguous keys are
preserved.

**Why in-place entry (not package.json exports):** classic plugins such as
`cursor-opencode-provider` set `npm: MODULE_URL` → a direct
`file://…/dist/index.js` URL, so package `exports` shims never run. After Layer
A reify, `ocp setup` (default `--provider-shim`):

1. Preserves the stock module body at its original entry path
2. Force-instruments its exported `create*` factory bindings in place
3. Drops sibling `ocp-lm-runtime.js` + `ocp-shim-meta.json`

No entry backup is created or restored. Reinstalling an npm package or rebuilding
a local checkout is the only way to return to its out-of-box files.

Expect beside `…/cursor-opencode-provider/dist/`:

- `index.js` — stock module body plus OCP instrumentation (`generated by ocp setup`)
- `ocp-lm-runtime.js` — host-dynamic `wrapProviderModule` / stream adoption
- `ocp-shim-meta.json` — setup-time host hint + export metadata

The generated entry resolves the live host from an explicit override, binary, or
host-owned environment marker (`MIMOCODE` / `MIMOCODE_*`). Provider workers may
hide all of those, so it then falls back to the setup-time host recorded in
`ocp-shim-meta.json`. The hint is only a fallback; a stronger live identity wins.

**Re-run `ocp setup` after plugin install/upgrade/reify** — `npm install`
restores stock files and would wipe the shim.

### 3.3 Project dirs / `.opencode`

MiMo walks **`.mimocode`** in
[ConfigPaths.directories](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/config/paths.ts).
OCP's `HostProfile` for `mimo` records `compatProjectDirs: [".opencode"]` for
matrix / doctor honesty. Closing path gaps is the **bridge's** job (docs,
doctor, optional operator copy/symlink into `.mimocode`).

### 3.4 Promise v2 — operator sidecar

| Path | What works on MiMo today |
|------|--------------------------|
| **Classic Hooks** (`@opencode-ai/plugin`) | After Layer A (`ocp setup` + reify), MiMo loads the plugin and can surface models (e.g. `cursor/*` via `mimo models`) through the classic provider/auth hooks. |
| **Promise v2** (`@opencode-ai/plugin/v2/promise`) | Plugin `define()` + `setup` can register `ctx.aisdk.sdk` / `ctx.aisdk.language` listeners, but **MiMo never calls those hooks** during native provider-resolve. There is **no** `@mimo-ai/plugin/v2/promise` and **no** in-process aisdk emit in [provider.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/provider/provider.ts). |

So **classic prove-out ≠ Promise v2 prove-out.** A `v2/promise` plugin sitting in
MiMo's plugin list will not inject `LanguageModelV3` into MiMo's native model
path by itself.

OCP ships the missing host kit externally: the
`@opencode-ai/plugin/v2/promise` facade
([`facade-plugin/src/v2/promise.ts`](../../packages/facade-plugin/src/v2/promise.ts)),
the kit [`@opencode-compat/host-promise-v2`](../../packages/host-promise-v2/README.md),
and the operator entry `wirePromiseV2()` from
[`@opencode-compat/ocp`](../../packages/ocp/README.md) / adapter. `HostProfile`
for `mimo` sets `capabilities.promiseV2` / `aisdkProviderHooks` to **true**
because **this OCP kit** is the provider — not because MiMo exports a native v2
surface.

Until MiMo gains an in-process seam, T3 live proof is an **external sidecar**.
Prerequisites: plugin installed (`mimo plugin -g …`), `ocp setup --host mimo`
done, and `OPENCODE_COMPAT_HOST=mimo` (or `env` passed into `wirePromiseV2`).

```bash
# Layer A first (once per plugin install/upgrade)
bun packages/ocp/bin/ocp.ts setup --host mimo

# Sidecar: register + resolveProvider (does not edit MiMo)
OPENCODE_COMPAT_HOST=mimo bun -e '
import { wirePromiseV2 } from "./packages/adapter/src/index.ts"

const pluginPath =
  `${process.env.HOME}/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider/dist/plugin-v2.js`
const plugin = (await import(pluginPath)).default
const host = wirePromiseV2({
  env: { ...process.env, OPENCODE_COMPAT_HOST: "mimo" },
})
await host.register(plugin)

const { language, sdk } = await host.resolveProvider({
  providerID: "cursor",
  modelID: "grok-4.5",
  // package string must match what the plugin’s sdk hook expects
  package: pluginPath,
})

if (!language?.specificationVersion || language.specificationVersion !== "v3") {
  throw new Error("resolveProvider did not return LanguageModelV3")
}
console.log({
  pluginIds: host.plugins(),          // e.g. ["cursor.provider"]
  provider: language.provider,        // "cursor"
  modelId: language.modelId,          // "grok-4.5"
  hasSdkFactory: typeof sdk?.languageModel === "function",
})
'
```

**Success criteria:** `language.specificationVersion === "v3"`,
`language.provider` / `language.modelId` match the request, and
`sdk.languageModel` is present when the plugin's sdk hook ran.

**What this does *not* do:** it does not patch MiMo source or add a native
`v2/promise` export, and it does **not** feed `language` into `mimo models` /
the running TUI — native listing still uses classic Hooks. A future in-process
seam would call the same `resolveProvider` wherever MiMo builds a language model.

`resolveProvider` inputs:

| Field | Role |
|-------|------|
| `providerID` | Matched by plugin `language` hooks (e.g. `"cursor"`) |
| `modelID` | Becomes `event.model.id` / `event.model.api.id` |
| `package` | String passed to `event.package` — many plugins (incl. `cursor-opencode-provider`) gate the **sdk** hook on this containing their package name or install path |
| `options` / `sdk` / `model` | Optional seeds; hooks mutate `event.sdk` / `event.language` in place |

API reference: [`packages/host-promise-v2`](../../packages/host-promise-v2/README.md),
contract [`docs/ocp/0.1.md`](../ocp/0.1.md) §7.

### 3.5 Classic hook gaps

MiMo's published classic surface lacks `dispose` and
`experimental.provider.small_model` vs OCP core. Facade / doctor policy: accept
+ no-op + warn. Do **not** surface MiMo `actor.*` / `session.*` on the portable
`@opencode-ai/plugin` path — those extension hooks are non-portable.

### 3.6 Verification

```bash
ocp doctor --host mimo
ocp matrix --host mimo
ocp matrix --host mimo --compat-scan
```

Doctor should report `streamToolCallEnsure: false` and
`bashDescriptionRequired: true`.

**Live smoke (classic + Option B):**

1. Confirm the shim files under
   `~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider/dist/`.
2. `mimo models` lists `cursor/*` when Cursor auth/cache is available.
3. A Cursor-backed `mimo run` that triggers tools emits tool parts (Option B
   preamble), and `read`/`write`/`edit` arguments validate against MiMo's
   advertised schemas — without editing `cursor-opencode-provider` sources.

**Live smoke (Promise v2):** run the [§3.4](#34-promise-v2--operator-sidecar)
sidecar. Do **not** expect `mimo models` to change from the sidecar alone.

### 3.7 Telemetry

OCP does **not** disable MiMo analytics. See
[`../guides/mimocode-telemetry-disable.md`](../guides/mimocode-telemetry-disable.md)
(`MIMOCODE_ENABLE_ANALYSIS=false`).

---

## 4. Kilo Code (`kilo`)

**Host (reference only):** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)
**HostProfile id:** `kilo`
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

### 4.1 Install tree

Kilo installs npm plugins via
[packages/core/src/npm.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/npm.ts)
and [packages/opencode/src/plugin/shared.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/shared.ts),
using the same isolated OpenCode-style `packages/<name>@<version>/` layout as
MiMo. Classic Hooks keys already match OpenCode 1.18.3 core, so T1 is primarily
override + adapter dispatch to `@kilocode/plugin`.

### 4.2 Option B — shims are identity on Kilo

Kilo's `SessionProcessor` already has `ensureToolCall`, so bare AI SDK
`tool-call` parts work without a preamble, and Kilo's `bash` `description` is
**optional**. Stock OpenCode plugins (including `cursor-opencode-provider`)
therefore do **not** need a host fork such as
[`cursor-kilocode-provider`](https://github.com/renaudcerrato/cursor-kilocode-provider)
once OCP Layer A is installed.

| Capability | Value | OCP adoption |
|------------|-------|--------------|
| `streamToolCallEnsure` | `true` | Pass-through (no synthetic `tool-input-start`) |
| `bashDescriptionRequired` | `false` | Pass-through (do not invent `description`) |

`ocp setup --host kilo` still writes the same in-place entry shim layout as MiMo
(classic plugins often load `file://…/dist/index.js` directly). At runtime the
shim detects `kilo` and `wrapProviderModule` returns the original module
unchanged. Use `--no-provider-shim` only when you intentionally skip Option B.

### 4.3 Project dirs / `.opencode`

Kilo scans **`.kilo` / `.kilocode`** in
[ConfigPaths.directories](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/paths.ts).
It may warn about leftover `.opencode` dirs for migration; default is
native-only. OCP's `kilo` profile keeps `compatProjectDirs: [".opencode"]` for
matrix `--compat-scan`. Operators who need OpenCode project plugins can
copy/symlink into `.kilo`.

### 4.4 Promise v2

Kilo does **not** publish a portable `@opencode-ai/plugin/v2/promise` path for
arbitrary OpenCode plugins. OCP supplies Promise v2 via
`@opencode-compat/host-promise-v2` + facade overrides:

```ts
import { wirePromiseV2 } from "@opencode-compat/ocp"

const host = wirePromiseV2({ env: { OPENCODE_COMPAT_HOST: "kilo" } })
await host.register(plugin)
await host.resolveProvider({ providerID, modelID, package: pkg })
```

`HostProfile` for `kilo` sets `capabilities.promiseV2` / `aisdkProviderHooks` to
**true** (OCP-layer kit). Live Kilo provider-resolve must call into
`resolveProvider` from a sidecar/operator helper — host source stays read-only.
The worked recipe and success criteria are in
[§3.4](#34-promise-v2--operator-sidecar); substitute `kilo`.

Reference host files (read-only):
[provider.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/provider/provider.ts),
[loader.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/loader.ts).

### 4.5 Verification

```bash
ocp doctor --host kilo
ocp matrix --host kilo
ocp matrix --host kilo --compat-scan
```

Doctor should report `streamToolCallEnsure: true` and
`bashDescriptionRequired: false`.

**Live smoke (classic + Option B):** after installing an unchanged OpenCode
plugin + `ocp setup --host kilo`, confirm the install-tree shim files exist
(same layout as [§3.2](#32-option-b--in-place-provider-entry-shims)) and that
`kilo models` surfaces plugin models when auth/cache is available. Runtime
adoption is identity for Kilo — tool-calls work via the host's `ensureToolCall`,
not via a provider fork.

### 4.6 Telemetry

OCP does **not** disable Kilo PostHog. See
[`../guides/kilocode-telemetry-disable.md`](../guides/kilocode-telemetry-disable.md).

---

## 5. ZCode — not a load target

ZCode is **not** a loadable OCP target. Its Agent Mode marketplace
(`.zcode-plugin` / Claude-/Codex-style hooks) is a different ABI from
`@opencode-ai/plugin`, so the facade mechanism does not apply:

- `ocp doctor --host zcode` detects the host and prints the T0 refusal.
- `ocp setup --host zcode` refuses (`supported: false` in the `zcode`
  HostProfile; `classicHooks: false`, `marketplacePlugins: true`).
- External OpenCode agent tiles that spawn the OpenCode CLI are also not OCP
  plugin compatibility.
- Until Z.AI ships an OpenCode-plugin loader, this does not change.

The companion `ocp migrate-zcode` packs a plugin's skills/commands/manifests
into `.zcode-plugin` form. That is asset migration, **not** OCP compatibility,
and it does not migrate host MCP. See
[`../guides/zcode-import-and-migrate.md`](../guides/zcode-import-and-migrate.md).

**Telemetry:** ZCode has no first-party opt-out; blocking is host-level
firewall/DNS only. See
[`../guides/zcode-telemetry-block.md`](../guides/zcode-telemetry-block.md).

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `mimo models` / `kilo models` shows no plugin models | Overrides not applied, or reify didn't run | Re-run `ocp setup` |
| Doctor reports a missing shim | `--no-provider-shim` was set, or `npm install` restored stock files | Re-run `ocp setup` without `--no-provider-shim` |
| Plugin loads but tools fail (no tool parts) | Option B didn't apply, or the worker cached the stock module before setup | Confirm `dist/index.js` says `generated by ocp setup`, ensure no legacy `index.ocp-original.js` remains, and restart the worker — see [TESTING.md](../../TESTING.md) |
| `read`/`write`/`edit` calls fail arg validation | Schema adoption didn't run | Confirm `ocp-lm-runtime.js` exists and the shim is active |
| `--mode file` says "could not locate sibling facade" | Running setup from outside the monorepo | Use `bun packages/ocp/bin/ocp.ts` from the repo root, or `--mode npm` |
| Catalog plugin hangs during startup | Stock `@opencode-ai/sdk/v2/client` re-entering `GET /api/model` | Ensure the facade is wired for that plugin (see [§2.4](#24-what-ocp-setup---mode-npm-does)) |

Deeper local-dev diagnostics and reset steps: [**TESTING.md**](../../TESTING.md).
Publishing `@opencode-compat/*`: [`../guides/npm-publish.md`](../guides/npm-publish.md).
