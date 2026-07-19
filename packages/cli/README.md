# @opencode-compat/cli

OCP compat doctor, Plugin×Host×Tier matrix runner, Layer A `setup` / `overrides`, and `migrate-zcode` companion CLI.

```text
compat doctor [--host opencode|mimo|kilo|zcode]
compat setup [--dir <path>] [--host <id>] [--mode auto|npm|file] [--dry-run]
             [--deep|--no-deep] [--reify|--no-reify]
compat overrides
compat matrix [...]
compat migrate-zcode --plugin <dir> [--out <dir>] [--dry-run]
```

`setup` defaults to **deep** child `package.json` patches and **auto-reify** (`npm install`) when a patched tree already has `node_modules` — required on MiMo/Kilo isolated per-plugin install dirs. Re-run after installing or upgrading consumer plugins.

User-facing entry is **`ocp`** from `@opencode-compat/ocp` (defaults to `setup`). This package remains the bridge CLI implementation.

`migrate-zcode` packs **plugin-packaged** skills/commands/manifests into a `.zcode-plugin` tree. It is **not** OCP ABI compatibility (ZCode stays T0) and does **not** migrate host MCP.

**License:** MPL-2.0

See the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and [migrator plan](../../docs/plans/zcode-asset-migrator-plan.md).
