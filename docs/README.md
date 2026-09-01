# Documentation

OCP is the **universal OpenCode plugin compatibility bridge**: published OpenCode
plugins run unchanged on three host families. Start with the page for the family
you are installing on — each one is self-contained, covering mechanism, npm
install, local development, per-host internals, and verification.

## Host guides

| Path | Covers |
|------|--------|
| [`hosts/opencode-clones.md`](./hosts/opencode-clones.md) | **MiMo · Kilo · ZCode** — facades + `ocp setup`. Install, Option B provider shims, project dirs, Promise v2 sidecar, telemetry, troubleshooting. ZCode is detect/doctor only. |
| [`hosts/pi-family.md`](./hosts/pi-family.md) | **pi · oh-my-pi (omp)** — `@opencode-compat/pi-bridge` → `pi.registerProvider(...)`. Install, config, model variants, verification. |
| [`hosts/dsh-family.md`](./hosts/dsh-family.md) | **DeepSeek Harness** — `@opencode-compat/dsh-bridge` → `ctx.llm.registerAdapter(...)`. Install, Cordis patch, Models list, verification. |
| [`hosts/README.md`](./hosts/) | Which family a host belongs to, and why the three mechanisms differ |

## Reference

| Path | Role |
|------|------|
| [`ocp/0.1.md`](./ocp/0.1.md) | **Canonical** OCP contract (`0.1.x` train) — HostProfile, classic hooks, tiers, Promise v2, conformance |
| [`../packages/pi-bridge/README.md`](../packages/pi-bridge/README.md) | pi-bridge config reference + pi/omp host-difference table |
| [`../packages/dsh-bridge/README.md`](../packages/dsh-bridge/README.md) | dsh-bridge contract + Cordis patch config |
| [`../TESTING.md`](../TESTING.md) | Manual local dev — unpublished OCP checkout + local plugins |
| [`guides/cursor-ocp-self-verify.md`](./guides/cursor-ocp-self-verify.md) | Paste-ready agent prompt: exercise Cursor-through-OCP, then score the provider debug log |
| [`guides/omp-tool-shape-self-verify.md`](./guides/omp-tool-shape-self-verify.md) | Paste-ready omp prompt: read paging, replace `edit` vs `hashline`, and OpenCode todo snapshots |
| [`guides/npm-publish.md`](./guides/npm-publish.md) | Publishing the public `@opencode-compat/*` train (OIDC Trusted Publishing on `v*` tags) |

## Companion guides (not OCP runtime)

These document **host** features or companion tooling, not the compatibility
bridge. OCP never mutates telemetry itself. Each is linked from the host page it
applies to.

| Path | Role |
|------|------|
| [`guides/mimocode-telemetry-disable.md`](./guides/mimocode-telemetry-disable.md) | Disable MiMo Xiaomi usage analytics (`MIMOCODE_ENABLE_ANALYSIS=false`) |
| [`guides/kilocode-telemetry-disable.md`](./guides/kilocode-telemetry-disable.md) | Disable Kilo PostHog telemetry (config / `KILO_TELEMETRY_LEVEL`) |
| [`guides/zcode-telemetry-block.md`](./guides/zcode-telemetry-block.md) | ZCode telemetry block (**docs-only** firewall/DNS — no first-party opt-out) |
| [`guides/zcode-import-and-migrate.md`](./guides/zcode-import-and-migrate.md) | ZCode Import UI vs `compat migrate-zcode` (packs assets; **not** OCP ABI) |

## Historical

[`plans/`](./plans/) holds the original ADR, product plan, and discovery evidence
(dated 2026-07-19). The work they describe has shipped; they are kept for
provenance — pinned upstream sources and the rationale behind decisions still in
force — and are **not** a current roadmap. `ocp/0.1.md` and the host guides
supersede them wherever they disagree.
