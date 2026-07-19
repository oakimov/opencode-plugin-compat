# @opencode-compat/ocp

User-facing **OCP umbrella**: one install + **`ocp setup`** writes Layer A install-tree overrides so published OpenCode plugins resolve `@opencode-ai/plugin` / `@opencode-ai/sdk` through the compatibility facades.

```bash
# from this monorepo (npm publish held until necessary)
bun packages/ocp/bin/ocp.ts setup --host mimo --dry-run
bun packages/ocp/bin/ocp.ts setup --dir /path/to/host/plugin/cache
ocp doctor --host kilo
```

## Commands

| Command | Role |
|---------|------|
| `ocp setup` | **Default.** Write `@opencode-ai/*` → facade overrides into the host plugin install tree |
| `ocp overrides` | Print override JSON only |
| `ocp doctor` | Host detect + capability summary |
| `ocp matrix` | OCP §10 fixtures (checkout-rooted) |
| `ocp migrate-zcode` | Companion migrator (not OCP ABI) |

`setup` options: `--dir`, `--host`, `--mode auto|npm|file`, `--version`, `--dry-run`, `--deep` / `--no-deep`.

Listing this package in a host `plugin` config entry is **optional bootstrap only** — it does **not** intercept other plugins’ `@opencode-ai/plugin` imports. Layer A requires the overrides that `ocp setup` writes.

Bridge packages (`profile`, `facade-*`, `adapter`, `host-promise-v2`, `cli`, …) ship as transitive dependencies / implementation detail.

**License:** MPL-2.0

See the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and host notes under [`patches/`](../../patches/).
