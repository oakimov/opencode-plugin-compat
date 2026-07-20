# @opencode-compat/cli

OCP compat doctor, Plugin×Host×Tier matrix runner, Layer A `setup` / `overrides`, Option B provider shims, and `migrate-zcode` companion CLI.

**End-user install:** see the monorepo [**INSTALL.md**](../../INSTALL.md).

```text
compat doctor [--host opencode|mimo|kilo|zcode]
compat setup [--dir <path>] [--host <id>] [--mode auto|npm|file] [--version <x.y.z>]
             [--dry-run] [--deep|--no-deep] [--reify|--no-reify]
             [--provider-shim|--no-provider-shim]
compat overrides
compat matrix [...]
compat migrate-zcode --plugin <dir> [--out <dir>] [--dry-run]
```

`setup` defaults to **deep** child `package.json` patches, **auto-reify** (`npm install`) when a patched tree already has `node_modules`, and **`--provider-shim`** (Option B in-place entry shims). Deep + reify are required on MiMo/Kilo isolated per-plugin install dirs. Re-run after installing or upgrading consumer plugins. Outside this monorepo prefer **`--mode npm`**.

User-facing entry is **`ocp`** from `@opencode-compat/ocp` (defaults to `setup`). This package remains the bridge CLI implementation.

`migrate-zcode` packs **plugin-packaged** skills/commands/manifests into a `.zcode-plugin` tree. It is **not** OCP ABI compatibility (ZCode stays T0) and does **not** migrate host MCP.

**License:** MPL-2.0

See [INSTALL.md](../../INSTALL.md), the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and [migrator plan](../../docs/plans/zcode-asset-migrator-plan.md).