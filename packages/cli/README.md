# @opencode-compat/cli

OCP compat doctor, Plugin×Host×Tier matrix runner, and `migrate-zcode` companion CLI.

```text
compat doctor [--host opencode|mimo|kilo|zcode]
compat matrix [...]
compat migrate-zcode --plugin <dir> [--out <dir>] [--dry-run]
```

`migrate-zcode` packs **plugin-packaged** skills/commands/manifests into a `.zcode-plugin` tree. It is **not** OCP ABI compatibility (ZCode stays T0) and does **not** migrate host MCP.

**License:** MPL-2.0

See the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and [migrator plan](../../docs/plans/zcode-asset-migrator-plan.md).
