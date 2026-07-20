# Documentation

| Path | Role |
|------|------|
| [`../INSTALL.md`](../INSTALL.md) | **User install** — npm `@opencode-compat/ocp` on MiMo/Kilo (+ Option B provider shims via `ocp setup`) |
| [`ocp/0.1.md`](./ocp/0.1.md) | **Canonical** OCP 0.1 contract (`0.1.x` train; Layer A + Option B) |
| [`hosts/`](./hosts/) | Host enablement notes (MiMo/Kilo operator attach via OCP) |
| [`guides/npm-publish.md`](./guides/npm-publish.md) | First-time local create-publish + later OIDC Trusted Publishing of **public** `@opencode-compat/*` |
| [`plans/`](./plans/) | Product plan, ADR, evidence, companion migrator plan |
| [`plans/zcode-asset-migrator-plan.md`](./plans/zcode-asset-migrator-plan.md) | Companion: plugin-package → `.zcode-plugin` migrator (**not** OCP ABI; no host MCP; ZCode stays T0) |
| [`guides/kilocode-telemetry-disable.md`](./guides/kilocode-telemetry-disable.md) | Disable Kilo PostHog telemetry (config / env; host feature) |
| [`guides/mimocode-telemetry-disable.md`](./guides/mimocode-telemetry-disable.md) | Disable MiMo Xiaomi usage analytics (`MIMOCODE_ENABLE_ANALYSIS=false`; host feature) |
| [`guides/zcode-telemetry-block.md`](./guides/zcode-telemetry-block.md) | ZCode telemetry block (**docs-only** firewall/DNS; not OCP) |
| [`guides/zcode-import-and-migrate.md`](./guides/zcode-import-and-migrate.md) | ZCode Import UI vs `compat migrate-zcode` (companion; not OCP ABI) |

This monorepo is the **universal OpenCode plugin compatibility bridge**. Plans under `plans/` describe that product. Companion privacy guides are **not** runtime bridge features.