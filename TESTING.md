# Manual testing — local OCP + local plugins

How to manually test an **unpublished** checkout of this monorepo alongside a
**local** consumer plugin (using `cursor-opencode-provider` as the example) on
MiMo Code.

> **Key principle:** OCP attaches as an external compatibility layer. You never
> edit MiMo source or fork consumer plugins. All local-dev wiring happens in the
> install-tree cache.

---

## Prerequisites

| Tool | Version |
|------|---------|
| [Bun](https://bun.sh) | ≥ 1.2 |
| [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) | any recent build |
| `npm` (used by `ocp setup` to reify overrides) | any recent version |

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
— renames the plugin's entry `dist/index.js` to `dist/index.ocp-original.js` and
writes an OCP provider shim + runtime.

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
#   index.ocp-original.js → stock entry backup
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
| Provider shim | `ls ~/.cache/mimocode/packages/cursor-opencode-provider@latest/node_modules/cursor-opencode-provider/dist/` | `index.js`, `index.ocp-original.js`, `ocp-lm-runtime.js` |
| Models load | `mimo models` | Lists `cursor/*` (or plugin's model IDs) |
| Doctor | `bun packages/ocp/bin/ocp.ts doctor --host mimo` | `ok: true` |

### When something is wrong

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `mimo models` shows no plugin models | Overrides not applied or reify didn't run | Re-run `ocp setup` |
| Doctor reports missing shim | `--no-provider-shim` was set, or `npm install` restored stock files | Re-run `ocp setup` (omit `--no-provider-shim`) |
| Plugin loads but tools fail (no tool parts) | Option B didn't apply — entry still stock | Check `dist/index.ocp-original.js` exists; re-run `ocp setup` |
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
            index.ocp-original.js
            ocp-lm-runtime.js
            ocp-shim-meta.json
```

---

## 6. Resetting to clean state

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
