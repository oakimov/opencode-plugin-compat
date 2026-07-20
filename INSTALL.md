# Install OCP (MiMo Code / Kilo Code)

Step-by-step guide to run **unchanged** OpenCode plugins on **MiMo Code** or **Kilo Code** using the public npm package [`@opencode-compat/ocp`](https://www.npmjs.com/package/@opencode-compat/ocp).

OCP does **not** fork plugins and does **not** patch host source. You install OCP once, install your plugins with the host CLI, then run **`ocp setup`** so each plugin’s install tree resolves `@opencode-ai/plugin` / `@opencode-ai/sdk` through the OCP facades.

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| [Bun](https://bun.sh) ≥ 1.2 | Required to run the `ocp` CLI (`#!/usr/bin/env bun`) |
| npm | Used by `ocp setup` to reify install-tree overrides |
| A supported host | **MiMo Code** (`mimo`) or **Kilo Code** (`kilo` / `kilocode`) on your `PATH` |

Confirm the host binary:

```bash
mimo --version    # MiMo
# or
kilo --version    # Kilo
```

---

## Overview

1. Install the OCP umbrella CLI from npm.
2. Install your OpenCode plugin(s) with the host (`mimo plugin` / `kilo plugin`).
3. Run **`ocp setup --mode npm`** for that host.
4. Restart / re-open the host and verify models/plugins load.

**Important:** On MiMo and Kilo each npm plugin lives in an **isolated** cache dir. Listing OCP in the host `plugin` array alone does **not** intercept other plugins’ `@opencode-ai/*` imports. Always run `ocp setup` after installing or upgrading plugins.

---

## 1. Install OCP (once)

```bash
bun add -g @opencode-compat/ocp
ocp --help
# or: ocp doctor --host mimo
```

This installs the `ocp` binary and pulls the bridge packages (`facade-*`, `adapter`, …) as transitive dependencies.

---

## 2. Example: `cursor-opencode-provider` via npm

[`cursor-opencode-provider`](https://www.npmjs.com/package/cursor-opencode-provider) is a stock OpenCode plugin. Install it **unchanged** with the host — do **not** use a host-specific fork.

### MiMo Code

```bash
# Install the plugin into global MiMo config + cache
mimo plugin -g cursor-opencode-provider

# Point that install tree at the public OCP facades and apply provider shims
ocp setup --host mimo --mode npm
```

MiMo updates `~/.config/mimocode/mimocode.json` (or your `MIMOCODE_HOME` layout). Example:

```json
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "plugin": [
    "cursor-opencode-provider"
  ]
}
```

Plugin files land under:

```text
~/.cache/mimocode/packages/cursor-opencode-provider@latest/
```

### Kilo Code

```bash
# Install the plugin into global Kilo config + cache
kilo plugin -g cursor-opencode-provider

# Point that install tree at the public OCP facades
ocp setup --host kilo --mode npm
```

Kilo records the plugin in its global config (commonly `~/.config/kilo/opencode.json`). Example:

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": [
    "cursor-opencode-provider"
  ]
}
```

Plugin files land under:

```text
~/.cache/kilo/packages/cursor-opencode-provider@latest/
```

### Project-local install (optional)

Omit `-g` to install into the current project instead of global config:

```bash
mimo plugin cursor-opencode-provider
ocp setup --host mimo --mode npm

# or
kilo plugin cursor-opencode-provider
ocp setup --host kilo --mode npm
```

---

## 3. What `ocp setup --mode npm` does

For the detected (or `--host`) plugin install root, setup:

1. Writes install-tree **overrides** so:
   - `@opencode-ai/plugin` → `npm:@opencode-compat/facade-plugin@…`
   - `@opencode-ai/sdk` → `npm:@opencode-compat/facade-sdk@…`
2. **Deep-patches** each child plugin `package.json` (required on MiMo/Kilo).
3. Runs **`npm install`** (reify) when `node_modules` already exists so the overrides link.
4. Writes **in-place provider entry shims** (default) for LanguageModel / stream adoption on hosts that need it (notably MiMo). Use `--no-provider-shim` to skip.

Useful flags:

```bash
ocp setup --host mimo --mode npm --dry-run   # preview only
ocp setup --host kilo --mode npm --version 0.1.0   # pin facade train (default today)
ocp setup --dir ~/.cache/mimocode/packages --mode npm   # explicit install root
```

`--version` pins the `@opencode-compat/facade-*` specs written into overrides. The CLI default remains the **currently published** train on npm (today **`0.1.0`**). After a newer public release (e.g. `0.1.1`), pass `--version 0.1.1` or update the default when documenting that train.

Outside this monorepo, always prefer **`--mode npm`** so overrides resolve from the public registry (not local `file:` paths).

---

## 4. Verify

```bash
ocp doctor --host mimo   # or --host kilo
```

**MiMo smoke**

```bash
mimo models          # expect cursor/* when Cursor auth/cache is available
```

Confirm shim files exist after setup (MiMo):

```text
~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider/dist/
  index.js                 # OCP shim
  index.ocp-original.js    # stock entry backup
  ocp-lm-runtime.js
```

**Kilo smoke**

```bash
kilo models          # expect plugin models when auth/cache is available
```

---

## 5. After plugin install or upgrade

Hosts may restore stock files on install/upgrade. Always re-run setup:

```bash
mimo plugin -g cursor-opencode-provider -f   # or kilo …
ocp setup --host mimo --mode npm             # or --host kilo
```

---

## Optional notes

- **Listing `@opencode-compat/ocp` in `plugin`:** optional bootstrap only. Layer A still requires the overrides from `ocp setup`.
- **Do not** override `@opencode-ai/plugin` straight to `@mimo-ai/plugin` / `@kilocode/plugin` — that skips OCP.
- **Do not** install per-host forks such as `cursor-kilocode-provider` for OCP; keep the stock npm package.
- **ZCode** is not an OCP install target for `@opencode-ai/plugin` packages (marketplace ABI differs).
- **Maintainers** publishing `@opencode-compat/*`: see [`docs/guides/npm-publish.md`](./docs/guides/npm-publish.md).
- **Host internals / Promise v2 sidecars:** see [`docs/hosts/mimo.md`](./docs/hosts/mimo.md) and [`docs/hosts/kilo.md`](./docs/hosts/kilo.md).

---

## Quick copy-paste

### MiMo + cursor-opencode-provider

```bash
bun add -g @opencode-compat/ocp
mimo plugin -g cursor-opencode-provider
ocp setup --host mimo --mode npm
ocp doctor --host mimo
mimo models
```

### Kilo + cursor-opencode-provider

```bash
bun add -g @opencode-compat/ocp
kilo plugin -g cursor-opencode-provider
ocp setup --host kilo --mode npm
ocp doctor --host kilo
kilo models
```