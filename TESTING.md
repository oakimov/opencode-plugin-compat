# Manual testing — local OCP + local plugins

How to manually test an **unpublished** checkout of this monorepo alongside a
**local** consumer plugin (using `cursor-opencode-provider` as the example) on
MiMo Code.

> **Key principle:** OCP attaches as an external compatibility layer. You never
> edit MiMo source or fork consumer plugins. All local-dev wiring happens in the
> install-tree cache.

> **Pi family (`pi` / `oh-my-pi`):** the facade instructions on this page do not
> apply — those hosts use `@opencode-compat/pi-bridge`, not `ocp setup`. Use
> `./scripts/pi-dev.sh local|npm` or `./scripts/omp-dev.sh local|npm`; their
> bridge/config workflow is documented in
> [`docs/hosts/pi-family.md`](./docs/hosts/pi-family.md).

---

## Prerequisites

| Tool | Version |
|------|---------|
| [Bun](https://bun.sh) | ≥ 1.2 |
| [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) | any recent build |
| `npm` (used by `ocp setup` to reify overrides) | any recent version |

### Helper scripts (recommended)

From this repo root:

```bash
./scripts/mimo-dev.sh local   # local OCP facades + local provider clone
./scripts/mimo-dev.sh npm     # restore npm plugin + published OCP facades

./scripts/kilo-dev.sh local
./scripts/kilo-dev.sh npm
```

Or drive every host at once — `shim`/`unshim` detect which hosts are actually
installed on this machine (`mimo`, `kilo`, `pi`, `omp`) and act on all of them:

```bash
./scripts/ocp-dev.sh shim              # wire every installed host (local mode)
./scripts/ocp-dev.sh shim --mode npm   # ...against published packages instead
./scripts/ocp-dev.sh shim kilo mimo    # or just the named ones

./scripts/ocp-dev.sh unshim            # return every installed host to factory state
./scripts/ocp-dev.sh unshim pi         # or just one

./scripts/ocp-dev.sh status            # what is wired, and is the checkout clean?
./scripts/ocp-dev.sh repair-stock      # restore a checkout an older script dirtied
./scripts/ocp-dev.sh revert kilo       # narrow: clone config slot + wrapper only
```

`shim` keeps going if one host fails and reports a summary, so an uninstalled or
misconfigured host does not block the rest.

`unshim` is the full reset. For MiMo/Kilo it removes the config slot and wrapper
via the manifest; for Pi/OMP it uninstalls the bridge and consumer plugin from
the host's own package manager, deletes the bridge config, and unlinks the host
AI package from the local `pi-bridge` checkout. It finishes by restoring the
provider checkout if an older script left it dirty. Every step tolerates
already-absent state, so it is safe to re-run.

Defaults: provider checkout from `OCP_DEV_PROVIDER_PATH` if set, else `../cursor-opencode-provider`, else `~/Projects/cursor-opencode-provider`.

**The provider checkout is read-only in local mode.** Every host gets a private
instrumented copy under `${OCP_DEV_STATE_DIR:-~/.cache/ocp-dev}/<host>/provider`
(a copy of `dist/` plus per-package symlinks into the checkout's
`node_modules`), and the host config points at that copy. Consequences:

- **Native OpenCode keeps working.** It loads the stock
  `…/cursor-opencode-provider/dist/index.js` by absolute path; nothing in local
  mode writes to that file or its `node_modules`.
- **MiMo and Kilo can be wired at the same time**, each with its own correct
  `hostHint`. The old "last setup wins" caveat is gone.
- Local mode never reinstalls or rebuilds the checkout. It builds `dist/` only
  if missing. Use `ocp-dev.sh repair-stock` (or `clean-test-state.sh`) when you
  actually want a clean reinstall/rebuild.

Each run records `state.json` next to the wrapper, capturing the exact config
entry it added and the prior `provider.cursor`. That manifest is what makes
`revert` exact and what lets a mode switch evict the previous entry — user
plugin entries in `plugin` are always preserved.

`local` generates the wrapper and runs `ocp setup --mode file`, so facade
symlinks land inside the wrapper (this is deliberate: it exercises this
checkout's facade code). `npm` writes the `<plugin>@latest` slot, force-installs
it into the host's own package cache, runs `ocp setup --mode npm`, and drops the
now-stale wrapper. Switching modes in either direction replaces a single slot;
neither direction touches the checkout.

If a checkout was dirtied by an older version of these scripts — an in-place
`dist/index.js` shim, or `node_modules/@opencode-ai/*` symlinked to facades —
local mode refuses to run and points at `repair-stock`.

---

## 1. Testing a local version of OCP

Point the MiMo plugin install tree at the **local** facade packages
(`facade-plugin`, `facade-sdk`) instead of the published npm versions.

### Layout

```
~/[opencode-plugin-compat]/          # this monorepo checkout
  packages/
    facade-plugin/                    # @opencode-compat/facade-plugin
    facade-sdk/                       # @opencode-compat/facade-sdk
    adapter/                          # @opencode-compat/adapter
    cli/                              # @opencode-compat/cli
    ocp/                              # @opencode-compat/ocp (umbrella)
      bin/ocp.ts                      # CLI entry point
```

### 1a. Install the consumer plugin (from npm) — once

```bash
mimo plugin -g cursor-opencode-provider
```

Plugin lands at:
```
~/.cache/mimocode/packages/cursor-opencode-provider@latest/
```

### 1b. Run `ocp setup` from the local checkout with `--mode file`

From the repo root:

```bash
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file
```

This does **Layer A** — writes `package.json` overrides in the MiMo plugin
install tree that map:

- `@opencode-ai/plugin` → `file:~/[opencode-plugin-compat]/packages/facade-plugin`
- `@opencode-ai/sdk` → `file:~/[opencode-plugin-compat]/packages/facade-sdk`

Then runs `npm install` (reify) so the `file:` links resolve. Then **Option B**
force-instruments the stock `dist/index.js` factory exports in place and writes
the OCP runtime. It never creates or restores an entry backup.

**Dry-run first to preview:**

```bash
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file --dry-run
```

**Re-run after every plugin install/upgrade** — `mimo plugin` restores stock
files from the tarball.

### 1c. Verify

```bash
# MiMo should list cursor/* models (classic Hooks via Layer A)
mimo models

# Confirm shim files exist
ls -la ~/.cache/mimocode/packages/cursor-opencode-provider@latest/ \
  node_modules/cursor-opencode-provider/dist/
#   index.js              → OCP shim
#   ocp-lm-runtime.js
#   ocp-shim-meta.json

# Doctor
bun packages/ocp/bin/ocp.ts doctor --host mimo
```

### 1d. Switch back to published OCP facades

```bash
bun packages/ocp/bin/ocp.ts setup --host mimo --mode npm
```

This replaces the `file:` overrides with `npm:` specifiers.

### Useful flags

| Flag | Purpose |
|------|---------|
| `--dry-run` | Preview changes without writing |
| `--mode file` | Use local `file:` facade paths (from this checkout) |
| `--mode npm` | Use published npm facades |
| `--host mimo` | Override host detection |
| `--no-provider-shim` | Skip Option B entry rewriting |
| `--version X.Y.Z` | Pin facade train version (default: current OCP version) |

---

## 2. Testing a local version of a consumer plugin

Point MiMo at an **unpublished** local copy of the plugin instead of the npm
package. Useful for iterating on provider changes before publishing.

### Layout

```
~/[cursor-opencode-provider]/         # plugin source checkout
  package.json
  dist/index.js                       # built plugin entry
```

### 2a. Install the local plugin into MiMo

**Option A — install from path:**

```bash
mimo plugin -g ~/[cursor-opencode-provider]
```

MiMo records the local path in its config and copies/symlinks the package into
the cache:

```
~/.cache/mimocode/packages/cursor-opencode-provider@latest/
  node_modules/cursor-opencode-provider/
```

**Option B — symlink directly (when `mimo plugin -g <path>` isn't available or
you want faster iteration):**

```bash
# Remove any existing npm-installed version
mimo plugin --remove cursor-opencode-provider

# Replace with a symlink
mkdir -p ~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules
ln -sfn ~/[cursor-opencode-provider] \
  ~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider
```

### 2b. Run `ocp setup` against the local plugin

Overrides + provider shim apply identically:

```bash
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file
```

### 2c. Iterate on the plugin

After editing the local plugin source and rebuilding (`bun run build` in the
plugin dir), the shim runtime loads the updated `dist/index.js` at MiMo startup.
No setup re-run needed **unless** the provider entry path changed.

If the local plugin's `package.json` dependencies changed (e.g., new or updated
`@opencode-ai/plugin` version), re-run setup to refresh the override:

```bash
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file
```

### 2d. Switch back to the published npm plugin

Remove the local path / symlink and reinstall from npm:

```bash
# Remove local
rm -rf ~/.cache/mimocode/packages/cursor-opencode-provider@latest

# Reinstall from npm
mimo plugin -g cursor-opencode-provider -f

# Re-apply OCP facades
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file   # or --mode npm
```

---

## 3. Testing local OCP + local plugin (combined)

Both local at once — full end-to-end dev loop:

```bash
# 1. Install local plugin into MiMo cache
mimo plugin -g ~/[cursor-opencode-provider]

# 2. Run ocp setup from local checkout
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file

# 3. Verify
mimo models
bun packages/ocp/bin/ocp.ts doctor --host mimo

# 4. Edit plugin source → rebuild → restart MiMo → repeat from step 3
```

The `--mode file` flag at step 2 points `@opencode-ai/*` facades at the local
checkout (for OCP changes), while the symlinked/in-path plugin at step 1 uses
the local plugin build (for provider changes). The two are independent — you
can mix local OCP + npm plugin or npm OCP + local plugin.

---

## 4. Verification checklist

### After setup

| Check | Command | Expected |
|-------|---------|----------|
| Overrides exist | `cat ~/.cache/mimocode/packages/package.json` | `overrides` with `@opencode-ai/plugin` |
| Deep patch | `cat ~/.cache/mimocode/packages/cursor-opencode-provider@latest/package.json` | `overrides` present |
| Provider shim | `ls ~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider/dist/` | Instrumented `index.js`, `ocp-lm-runtime.js`; no `index.ocp-original.js` |
| Models load | `mimo models` | Lists `cursor/*` (or plugin's model IDs) |
| Doctor | `bun packages/ocp/bin/ocp.ts doctor --host mimo` | `ok: true` |

### When something is wrong

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `mimo models` shows no plugin models | Overrides not applied or reify didn't run | Re-run `ocp setup` |
| Doctor reports missing shim | `--no-provider-shim` was set, or `npm install` restored stock files | Re-run `ocp setup` (omit `--no-provider-shim`) |
| Plugin loads but tools fail (no tool parts) | Option B didn't apply — entry is still stock or the running worker cached a pre-setup module | Confirm `dist/index.js` has `generated by ocp setup`, confirm there is no `index.ocp-original.js`, then restart the host worker. For local checkouts re-run `./scripts/mimo-dev.sh local` (or `kilo-dev.sh local`). |
| Plugin loads but `read`/`write`/`edit` calls error with arg validation | Schema adapter didn't map key names | Confirm `ocp-lm-runtime.js` exists and shim is active |
| `--mode file` says "could not locate sibling facade" | Running setup from outside the monorepo | Use `bun packages/ocp/bin/ocp.ts` from repo root, or use `--mode npm` |

---

## 5. Quick reference — MiMo cache layout

```
~/.config/mimocode/
  mimocode.json                 # host config (plugin list, etc.)

~/.cache/mimocode/
  packages/
    package.json                # root overrides (written by ocp setup)
    cursor-opencode-provider@latest/
      package.json              # child overrides (deep-patched)
      node_modules/
        cursor-opencode-provider/
          package.json
          dist/
            index.js            # OCP shim (after setup)
            ocp-lm-runtime.js
            ocp-shim-meta.json
```

---

## 6. Resetting to clean state

For a provider checkout that was used by a local test, run the standalone
cleanup first. It removes the provider's test-time facade links and generated
entry shims, reinstalls its declared dependencies, and rebuilds stock output:

```bash
./scripts/clean-test-state.sh --provider /path/to/cursor-opencode-provider
```

Add `--host mimo` or `--host kilo` to also remove the selected provider's host
cache entries, recognizable OCP install-tree overrides, and local provider
references from the host config. The script deliberately does not claim to
restore values overwritten by an older script run when no config backup exists.

If you want to switch the host back to the published plugin and published OCP
facades, the existing mode switch remains the recommended reset:
`./scripts/mimo-dev.sh npm` (or `./scripts/kilo-dev.sh npm`). Those helpers
perform the cache and dependency cleanup below automatically and reinstall the
published plugin at `@latest`.

```bash
# Remove OCP overrides from the install tree
rm ~/.cache/mimocode/packages/package.json

# Remove a specific plugin cache entry
rm -rf ~/.cache/mimocode/packages/cursor-opencode-provider@latest

# Reinstall plugin from npm
mimo plugin -g cursor-opencode-provider -f

# Option A: set up with published OCP (if you have @opencode-compat/ocp installed globally)
ocp setup --host mimo --mode npm

# Option B: set up with local OCP checkout
bun packages/ocp/bin/ocp.ts setup --host mimo --mode file   # from repo root
```
