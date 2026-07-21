# opencode-plugin-compat

**OCP** — OpenCode Compatibility Protocol and a **universal compatibility bridge** for OpenCode-compatible hosts.

Run **published OpenCode plugins unchanged** (`import "@opencode-ai/plugin"` / `v2/promise`) on **MiMo Code** and **Kilo Code** via an **external** `@opencode-compat/*` layer. Hosts are read-only references. **ZCode** stays honestly at T0 (marketplace ABI ≠ OpenCode plugin ABI). This repo does **not** ship or plan host-specific forks of individual plugins (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, etc.).

**Install:** see [**INSTALL.md**](./INSTALL.md) — npm install of `@opencode-compat/ocp`, then `ocp setup` on MiMo/Kilo (includes a `cursor-opencode-provider` example).

`ocp setup` also applies LanguageModel tool-stream normalization to compatible custom provider entries. It uses each call's advertised tool schema to adopt argument-key conventions (for example, camelCase or snake_case), so providers and future OpenCode-compatible hosts remain host-agnostic.

**License:** [MPL-2.0](./LICENSE)

## Status

Bridge packages, OCP §10 fixtures, CLI doctor/matrix/setup, host enablement notes, and the **`@opencode-compat/ocp`** umbrella are in-tree. First npm publish of **public** `@opencode-compat/*` is documented in [`docs/guides/npm-publish.md`](./docs/guides/npm-publish.md) (local create-publish, then OIDC Trusted Publishing on tags).

## Packages (`@opencode-compat/*`)

| Package | Role |
|---------|------|
| [`ocp`](./packages/ocp) | **Umbrella UX**: one install + `ocp setup` → Layer A overrides; re-exports / depends on bridge packages |
| [`profile`](./packages/profile) | `HostProfile` types + host drafts (opencode / mimo / kilo / zcode) |
| [`facade-plugin`](./packages/facade-plugin) | Install-override stand-in for `@opencode-ai/plugin` |
| [`facade-sdk`](./packages/facade-sdk) | Stand-in for `@opencode-ai/sdk` (minimal) |
| [`adapter`](./packages/adapter) | **One** universal host adapter — autodetects host, dispatches via `HostProfile` |
| [`host-promise-v2`](./packages/host-promise-v2) | Shared Promise v2 aisdk host kit (wired from OCP layer) |
| [`cli`](./packages/cli) | `compat doctor` + matrix + `setup`/`overrides` (+ migrate-zcode companion) |
| [`migrate-zcode`](./packages/migrate-zcode) | Companion: plugin-package skills/commands/manifests → `.zcode-plugin` (**not** OCP ABI; **no** host MCP — [plan](./docs/plans/zcode-asset-migrator-plan.md)) |

Also: [`fixtures/`](./fixtures) (conformance), [`docs/hosts/`](./docs/hosts) (host enablement notes), [`docs/ocp/0.1.md`](./docs/ocp/0.1.md).

**Not in scope:** separate publishable packages per host (`adapter-mimo`, `adapter-kilo`, …). Host differences live in `HostProfile` data + internal dispatch inside `@opencode-compat/adapter`. ZCode marketplace packing is a **companion** deliverable and does not make ZCode T1+.

## Docs

| Doc | Purpose |
|-----|---------|
| [`INSTALL.md`](./INSTALL.md) | **User install** — npm OCP on MiMo/Kilo (+ `cursor-opencode-provider` example) |
| [`docs/ocp/0.1.md`](./docs/ocp/0.1.md) | OCP 0.1 contract |
| [`docs/plans/universal-opencode-plugin-compat-plan.md`](./docs/plans/universal-opencode-plugin-compat-plan.md) | Parent product plan |
| [`docs/plans/phase0-adr-universal-compat.md`](./docs/plans/phase0-adr-universal-compat.md) | Product ADR |
| [`docs/plans/phase0-hooks-parity.md`](./docs/plans/phase0-hooks-parity.md) | Hooks / path evidence |
| [`docs/plans/zcode-asset-migrator-plan.md`](./docs/plans/zcode-asset-migrator-plan.md) | Companion plugin-package → `.zcode-plugin` migrator (ZCode stays T0; no host MCP) |
| [`docs/guides/kilocode-telemetry-disable.md`](./docs/guides/kilocode-telemetry-disable.md) | Disable Kilo PostHog telemetry (config / `KILO_TELEMETRY_LEVEL`) |
| [`docs/guides/zcode-telemetry-block.md`](./docs/guides/zcode-telemetry-block.md) | ZCode telemetry block (**docs-only** firewall/DNS) |
| [`docs/guides/npm-publish.md`](./docs/guides/npm-publish.md) | First-time + OIDC publish of **public** `@opencode-compat/*` |

## Develop

```bash
bun install
bun run build
bun run typecheck
bun test
bun run setup -- --host mimo --dry-run
bun run matrix
bun run doctor -- --host mimo
bun run pack:check          # publish dry-run (see docs/guides/npm-publish.md)
```

Requires [Bun](https://bun.sh) ≥ 1.2. CLI bins import `dist/` — run `bun run build` after a clean checkout.

## Compatibility tiers (labels, not phases)

| Tier | Meaning |
|------|---------|
| T0 | Detect / doctor only (ZCode) |
| T1 | Classic Hooks via facade + universal adapter |
| T2 | Path / env / project-dir bridge |
| T3 | Promise v2 aisdk via host kit |
| TX | Host-aware risk (hardcoded paths/env); bridge may not fully cover — **fix the bridge or the plugin**, do not fork the plugin per host |

## Related

- Example consumer plugin (must run **unchanged** via OCP): [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)
- Research baselines: [oa-tools/mimo-review](https://github.com/oakimov/oa-tools/tree/main/mimo-review), [oa-tools/kilo-review](https://github.com/oakimov/oa-tools/tree/main/kilo-review), [oa-tools/zcode-review](https://github.com/oakimov/oa-tools/tree/main/zcode-review)
