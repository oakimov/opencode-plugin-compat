# @opencode-compat/ocp

User-facing **OCP umbrella**: one install + **`ocp setup`** writes Layer A install-tree overrides (and default Option B provider entry shims) so published OpenCode plugins resolve `@opencode-ai/plugin` / `@opencode-ai/sdk` through the compatibility facades.

**End-user install (MiMo / Kilo + npm):** see the monorepo [**INSTALL.md**](../../INSTALL.md).

```bash
# from this monorepo (developers)
bun run build
bun packages/ocp/bin/ocp.ts setup --host mimo --dry-run
bun packages/ocp/bin/ocp.ts setup --dir /path/to/host/plugin/cache
```

`setup` default `--mode auto` uses local `file:` facade paths from this checkout when present; outside the monorepo use **`--mode npm`** (see [INSTALL.md](../../INSTALL.md)).

## Commands

| Command | Role |
|---------|------|
| `ocp setup` | **Default.** Write `@opencode-ai/*` → facade overrides into the host plugin install tree |
| `ocp overrides` | Print override JSON only |
| `ocp doctor` | Host detect + capability summary |
| `ocp matrix` | OCP §10 fixtures (checkout-rooted) |
| `ocp migrate-zcode` | Companion migrator (not OCP ABI) |

`setup` options: `--dir`, `--host`, `--mode auto|npm|file`, `--version`, `--dry-run`, `--deep` / `--no-deep`, `--reify` / `--no-reify` (default auto-reify when a patched tree already has `node_modules`), `--provider-shim` / `--no-provider-shim`.

Bridge packages (`profile`, `facade-*`, `adapter`, `host-promise-v2`, `cli`, …) ship as transitive dependencies / implementation detail.

**License:** MPL-2.0

See [INSTALL.md](../../INSTALL.md), the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and host notes under [`docs/hosts/`](../../docs/hosts/).