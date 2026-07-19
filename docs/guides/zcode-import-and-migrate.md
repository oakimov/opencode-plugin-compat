# ZCode Import UI vs `compat migrate-zcode`

**Companion guide** — not OCP runtime. ZCode remains **T0** for `@opencode-ai/plugin`.

## What each tool is for

| Path | Use when |
|------|----------|
| **ZCode Import / marketplace UI** | Installing an existing `.zcode-plugin` (or Claude-/Codex-shaped) marketplace package into ZCode |
| **`compat migrate-zcode`** | You have a **plugin package directory** that already vendors `skills/`, `commands/`, and/or marketplace manifests, and you want a clean `.zcode-plugin` tree to install |

## What the migrator does

```bash
bun run migrate-zcode -- --plugin /path/to/plugin-package --out /tmp/my-zcode-plugin
# or dry-run:
bun run migrate-zcode -- --plugin /path/to/plugin-package --dry-run --format json

# multi-plugin marketplace wrap (glm-fleet shape):
bun run migrate-zcode -- \
  --plugin /path/to/plugin-a \
  --plugin /path/to/plugin-b \
  --marketplace-name my-fleet \
  --owner-name oakimov \
  --out /tmp/my-fleet
```

- Scans `skills/`, `commands/`, `.zcode-plugin` / `.claude-plugin` / `.codex-plugin`, `marketplace.json`
- Sanitizes skill/command frontmatter for ZCode handbook expectations
- Emits `.zcode-plugin/plugin.json` + assets + a short README
- With `--marketplace-name`, emits root `.zcode-plugin/marketplace.json` plus `plugins/<slug>/…` children
- Reports JS entrypoints as `ocp-abi-not-migratable` (hooks still will not run on ZCode)
## What it does **not** do

- Does **not** make ZCode load `@opencode-ai/plugin` / classic or v2 hooks
- Does **not** migrate host MCP from `opencode.json` (ZCode has its own MCP)
- Does **not** rewrite OpenCode hooks into ZCode `hooks.json` subprocess hooks
- Does **not** change OCP doctor/matrix support for `zcode` (stays T0)

## Related

- Plan: [`docs/plans/zcode-asset-migrator-plan.md`](../plans/zcode-asset-migrator-plan.md)
- Package: [`packages/migrate-zcode`](../../packages/migrate-zcode)
- OCP ZCode policy: [`docs/ocp/0.1.md`](../ocp/0.1.md) §9