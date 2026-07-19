# @opencode-compat/ocp

User-facing **OCP umbrella**: one install + **`ocp setup`** writes Layer A install-tree overrides so published OpenCode plugins resolve `@opencode-ai/plugin` / `@opencode-ai/sdk` through the compatibility facades.

```bash
# from this monorepo
bun run build
bun packages/ocp/bin/ocp.ts setup --host mimo --dry-run
bun packages/ocp/bin/ocp.ts setup --dir /path/to/host/plugin/cache

# after public npm publish (see docs/guides/npm-publish.md)
bun add -g @opencode-compat/ocp
ocp setup --host mimo
ocp doctor --host kilo
```

`setup` default `--mode auto` uses local `file:` facade paths from this checkout when present; outside the monorepo (or with `--mode npm`) it writes `npm:@opencode-compat/facade-*@0.1.0`.

## Commands

| Command | Role |
|---------|------|
| `ocp setup` | **Default.** Write `@opencode-ai/*` → facade overrides into the host plugin install tree |
| `ocp overrides` | Print override JSON only |
| `ocp doctor` | Host detect + capability summary |
| `ocp matrix` | OCP §10 fixtures (checkout-rooted) |
| `ocp migrate-zcode` | Companion migrator (not OCP ABI) |

`setup` options: `--dir`, `--host`, `--mode auto|npm|file`, `--version`, `--dry-run`, `--deep` / `--no-deep`, `--reify` / `--no-reify` (default auto-reify when a patched tree already has `node_modules`).

On MiMo/Kilo, install consumer plugins first, then run `ocp setup` (and re-run after plugin upgrades) — hosts use isolated per-plugin install dirs.

Listing this package in a host `plugin` config entry is **optional bootstrap only** — it does **not** intercept other plugins’ `@opencode-ai/plugin` imports. Layer A requires the overrides that `ocp setup` writes.

Bridge packages (`profile`, `facade-*`, `adapter`, `host-promise-v2`, `cli`, …) ship as transitive dependencies / implementation detail.

**License:** MPL-2.0

See the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and host notes under [`docs/hosts/`](../../docs/hosts/).