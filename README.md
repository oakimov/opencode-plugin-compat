# opencode-plugin-compat

**OPHP** — OpenCode Plugin Host Protocol and compatibility stack for OpenCode forks.

Ship published OpenCode plugins (`import "@opencode-ai/plugin"` / `v2/promise`) on cooperating forks (**MiMo Code**, **Kilo Code**) without republish, with **ZCode** honestly at T0. Dual-host Cursor packages remain a parallel TX escape hatch in [`cursor-opencode-provider`](https://github.com/oakimov/cursor-opencode-provider).

**License:** [MPL-2.0](./LICENSE)

## Status

Final-product monorepo scaffold. Research and ADRs live under [`docs/`](./docs/). Implementation of packages is next.

## Packages (`@opencode-compat/*`)

| Package | Role |
|---------|------|
| [`profile`](./packages/profile) | `HostProfile` types + host drafts |
| [`facade-plugin`](./packages/facade-plugin) | Install-override stand-in for `@opencode-ai/plugin` |
| [`facade-sdk`](./packages/facade-sdk) | Stand-in for `@opencode-ai/sdk` (minimal) |
| [`adapter-opencode`](./packages/adapter-opencode) | Identity adapter |
| [`adapter-mimo`](./packages/adapter-mimo) | MiMo (`@mimo-ai/*`) — first adapter instance |
| [`adapter-kilo`](./packages/adapter-kilo) | Kilo (`@kilocode/*`) |
| [`adapter-zcode`](./packages/adapter-zcode) | T0 stub / doctor only |
| [`host-promise-v2`](./packages/host-promise-v2) | Shared Promise v2 aisdk host kit (M1 embed) |
| [`cli`](./packages/cli) | `compat doctor` + matrix runner |

Also: [`fixtures/`](./fixtures) (conformance), [`patches/`](./patches) (reference M1 patches), [`docs/ophp/0.1.md`](./docs/ophp/0.1.md).

## Docs

| Doc | Purpose |
|-----|---------|
| [`docs/ophp/0.1.md`](./docs/ophp/0.1.md) | OPHP 0.1 contract |
| [`docs/plans/universal-opencode-plugin-compat-plan.md`](./docs/plans/universal-opencode-plugin-compat-plan.md) | Parent product plan |
| [`docs/plans/phase0-adr-universal-compat.md`](./docs/plans/phase0-adr-universal-compat.md) | Product ADR |
| [`docs/plans/phase0-hooks-parity.md`](./docs/plans/phase0-hooks-parity.md) | Hooks / path evidence |
| [`docs/plans/mimo-opencode-compat-layer-plan.md`](./docs/plans/mimo-opencode-compat-layer-plan.md) | MiMo adapter plan |
| [`docs/plans/dual-host-packages-plan.md`](./docs/plans/dual-host-packages-plan.md) | Cursor TX dual-package track (impl in `cursor-opencode-provider`) |

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
| T1 | Classic Hooks via facade + adapter |
| T2 | Path / env / project-dir bridge |
| T3 | Promise v2 aisdk via host kit |
| TX | Host-aware; dual packages / patches |

## Related

- Cursor dual-host implementation: `~/Projects/cursor-opencode-provider` (see dual-host plan)
- Research baselines: `oa-tools/mimo-review`, `oa-tools/zcode-review`
