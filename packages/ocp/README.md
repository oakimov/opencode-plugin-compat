# @opencode-compat/ocp

User-facing **OCP umbrella**: one install + **`ocp setup`** writes Layer A install-tree overrides (and default Option B provider entry shims) so published OpenCode plugins resolve `@opencode-ai/plugin` / `@opencode-ai/sdk` through the compatibility facades.

**End-user install (MiMo / Kilo + npm):** see [**docs/hosts/opencode-clones.md**](../../docs/hosts/opencode-clones.md).

**Scope:** OpenCode clones only. On `pi` / `oh-my-pi` use [`@opencode-compat/pi-bridge`](../pi-bridge/README.md). On DeepSeek Harness use [`@opencode-compat/dsh-bridge`](../dsh-bridge/README.md). ZCode is detect/doctor only.

```bash
# from this monorepo (developers)
bun run build
bun packages/ocp/bin/ocp.ts setup --host mimo --dry-run
bun packages/ocp/bin/ocp.ts setup --dir /path/to/host/plugin/cache
```

`setup` default `--mode auto` uses local `file:` facade paths from this checkout when present; outside the monorepo use **`--mode npm`** (see the [host guide](../../docs/hosts/opencode-clones.md)).

The default provider-shim action applies the active host's LanguageModel compatibility policy and adopts tool argument keys from each call's advertised schema. Exact schema keys win; only unique case/separator-insensitive matches are renamed. Runtime identity wins for host-specific policy; a setup-time install-tree host hint covers isolated provider workers that hide host process markers.

## Commands

| Command | Role |
|---------|------|
| `ocp setup` | **Default.** Write `@opencode-ai/*` → facade overrides into the host plugin install tree |
| `ocp overrides` | Print override JSON only |
| `ocp doctor` | Host detect + capability summary |
| `ocp matrix` | OCP §10 fixtures (checkout-rooted) |
| `ocp migrate-zcode` | Companion migrator (not OCP ABI) |

`setup` options: `--dir`, `--host`, `--mode auto|npm|file`, `--version`, `--dry-run`, `--deep` / `--no-deep`, `--reify` / `--no-reify` (default auto-reify when a patched tree already has `node_modules`), `--provider-shim` / `--no-provider-shim`, `--absolute-plugins` / `--no-absolute-plugins` (symlink facades into absolute-path / `file://` plugin checkouts).

Bridge packages (`profile`, `facade-*`, `adapter`, `host-promise-v2`, `cli`, …) ship as transitive dependencies / implementation detail.

**License:** MPL-2.0

See the monorepo [README](../../README.md), [OCP 0.1](../../docs/ocp/0.1.md), and host guides under [`docs/hosts/`](../../docs/hosts/).