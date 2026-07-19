# opencode-plugin-compat

**OCP** — OpenCode Compatibility Protocol and a **universal compatibility bridge** for OpenCode forks.

Run **published OpenCode plugins unchanged** (`import "@opencode-ai/plugin"` / `v2/promise`) on cooperating forks (**MiMo Code**, **Kilo Code**). **ZCode** stays honestly at T0 (marketplace ABI ≠ OpenCode plugin ABI). This repo does **not** ship or plan host-specific forks of individual plugins (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, etc.).

**License:** [MPL-2.0](./LICENSE)

## Status

Final-product monorepo scaffold. Research and ADRs live under [`docs/`](./docs/). Implementation of packages is next.

## Packages (`@opencode-compat/*`)

| Package | Role |
|---------|------|
| [`profile`](./packages/profile) | `HostProfile` types + host drafts (opencode / mimo / kilo / zcode) |
| [`facade-plugin`](./packages/facade-plugin) | Install-override stand-in for `@opencode-ai/plugin` |
| [`facade-sdk`](./packages/facade-sdk) | Stand-in for `@opencode-ai/sdk` (minimal) |
| [`adapter`](./packages/adapter) | **One** universal host adapter — autodetects host, dispatches via `HostProfile` |
| [`host-promise-v2`](./packages/host-promise-v2) | Shared Promise v2 aisdk host kit (M1 embed) |
| [`cli`](./packages/cli) | `compat doctor` + matrix runner |

Also: [`fixtures/`](./fixtures) (conformance), [`patches/`](./patches) (reference M1 patches), [`docs/ocp/0.1.md`](./docs/ocp/0.1.md).

**Not in scope:** separate publishable packages per host (`adapter-mimo`, `adapter-kilo`, …). Host differences live in `HostProfile` data + internal dispatch inside `@opencode-compat/adapter`.

## Docs

| Doc | Purpose |
|-----|---------|
| [`docs/ocp/0.1.md`](./docs/ocp/0.1.md) | OCP 0.1 contract |
| [`docs/plans/universal-opencode-plugin-compat-plan.md`](./docs/plans/universal-opencode-plugin-compat-plan.md) | Parent product plan |
| [`docs/plans/phase0-adr-universal-compat.md`](./docs/plans/phase0-adr-universal-compat.md) | Product ADR |
| [`docs/plans/phase0-hooks-parity.md`](./docs/plans/phase0-hooks-parity.md) | Hooks / path evidence |
| [`docs/plans/mimo-opencode-compat-layer-plan.md`](./docs/plans/mimo-opencode-compat-layer-plan.md) | MiMo M1 integration detail (an **equal** `HostProfile` target, not a separate adapter package) |
| [`docs/plans/dual-host-packages-plan.md`](./docs/plans/dual-host-packages-plan.md) | **Superseded** — historical dual-package sketch (out of scope) |
| [`docs/guides/kilocode-telemetry-disable.md`](./docs/guides/kilocode-telemetry-disable.md) | Disable Kilo PostHog telemetry (config / `KILO_TELEMETRY_LEVEL`) |
| [`docs/guides/zcode-telemetry-block.md`](./docs/guides/zcode-telemetry-block.md) | ZCode telemetry block (**docs-only** firewall/DNS) |

## Develop

```bash
bun install
bun run typecheck
bun test
```

Requires [Bun](https://bun.sh) ≥ 1.2.

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