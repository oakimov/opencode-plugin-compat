# Changelog

All notable user-facing changes to the `@opencode-compat/*` release train are documented here.

The monorepo ships **one shared train version** across all eleven packages, so unlike per-package changelogs this file is the single source of release notes. See `AGENTS.md` § Changelog for the agent contract.

## [Unreleased]

### Changed

- Clone-host provider shims add one event-only `__ocpUsageEvents` plugin export and keep the provider's own exports unchanged, so the provider plugin loads once; rerun `ocp setup` to refresh existing shims.

### Fixed

- Pi and OMP keep context occupancy and billed usage accurate without inflating held-run totals.
- Generic provider token reporting preserves input aggregates, cache writes, reasoning subsets, and unknown totals across host bridges.
- DSH uses explicit provider context snapshots for metering (including sessions with offloaded images) and preserves model context and output limits.
- Devin cached-context snapshots no longer inflate billed token buckets on Pi, OMP, DSH, Kilo, or MiMo.
- DSH lists bridged providers (Cursor, Devin, …) in Settings → Models again on DSH 0.1.7+, which keeps live settings in each plugin's Cordis Config; `apiKeyEnv` names the credential (`apiKey` remains an alias).
- DSH passes a provider credential from `apiKeyEnv` to the plugin's API-key login instead of treating it as an OAuth session, so Cursor `crsr_` keys work again (`preferAuthMethod: oauth` restores the old behavior).
- Kilo and MiMo normalize generation-result usage and reconcile accounting for providers without their own event bridge, once per host event; separate installed runtimes share reconciliation state.

## [0.4.3] - 2026-10-04

### Added

- Pi-family hosts can drive OpenCode plan mode through `@pify/plan-mode`, including plan review flows on oh-my-pi / omp.
- DSH workspace instructions are folded into the system prompt for Cursor so host workspace context reaches the provider.

### Fixed

- Canonical prompt references are normalized, and todo tool results are isolated so sibling tools do not see stale todo state.
- Cursor session affinity and `auth.loader` options stay aligned across Pi and DSH bridges.
- MiMo `in_progress` session starts create correctly; DSH/Pi package resolution is stricter about the installed entry that actually loads.
- Hardened Cursor compatibility across DSH and Pi hosts (catalog, call, and history translation edges).

## [0.4.2] - 2026-09-24

### Fixed

- `pi-bridge` and `dsh-bridge` keep exact train pins for `@opencode-compat/*` dependencies so foreign `file:` installs (pnpm / host plugin add) no longer fail with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

## [0.4.1] - 2026-09-24

### Changed

- OpenCode plugin loading is shared through `@opencode-compat/opencode-loader` for both Pi and DSH bridges.
- Provider-specific usage translation stays inside OCP; Kilo uses host-based generic usage reconciliation.

### Fixed

- Pi-bridge preserves Cursor occupancy and rebases local compactions so resume/history replay stays coherent.
- omp plan review stays open until the user answers instead of closing early.
- OpenCode `glob` `pattern`+`path` arguments fold into omp's expected `path` shape.

## [0.4.0] - 2026-09-01

### Added

- DeepSeek Harness support via `@opencode-compat/dsh-bridge` (Cordis `LlmAdapter`, AI-SDK `doStream` ↔ DSH `StreamChunk`).
- Shared `@opencode-compat/opencode-loader` package for host-neutral OpenCode plugin loading.

## [0.3.2] - 2026-09-01

### Changed

- Patch train release; packaging and docs aligned with the 0.3.1 runtime fixes.

## [0.3.1] - 2026-08-19

### Fixed

- omp OpenCode `read` / `edit` / hashline / todo bridges hardened for live host schemas.
- Pi-bridge read selectors use raw host forms; CodeQL ReDoS patterns cleared.

## [0.3.0] - 2026-08-17

### Fixed

- Pi-bridge model refresh and edit-history replay hardened after 0.2.4 review findings.
- Optional Cursor image-save import is no longer typechecked when the provider package is absent.

## [0.2.4] - 2026-08-13

### Fixed

- Pi-bridge edit aliases are gated on the live host schema; sibling-host vocabulary is accepted and history is replayed in the advertised shape.

## [0.2.3] - 2026-08-13

### Added

- Standalone cleanup for leftover local OCP test state.

### Fixed

- Pi-bridge tool and catalog compatibility with host-advertised shapes.

## [0.2.2] - 2026-08-12

### Fixed

- OpenCode tool arguments map to per-host Pi schemas before execution.

## [0.2.1] - 2026-08-11

### Changed

- Patch train after the 0.2.0 Pi-bridge introduction.

## [0.2.0] - 2026-08-11

### Added

- Pi-family support via `@opencode-compat/pi-bridge`: load an unmodified OpenCode `aisdk` plugin and register it on pi / oh-my-pi through `pi.registerProvider(...)`.

## [0.1.5] - 2026-08-08

### Fixed

- CodeQL incomplete-sanitization and polynomial-ReDoS findings cleared in bridge paths.

## [0.1.4] - 2026-07-25

### Added

- Native host config path bridging so unchanged plugins resolve cache/data/config/project paths through the host.

### Fixed

- Provider shim writes `ocp-shim-meta.json` beside the package entry for install-tree diagnosis.

## [0.1.2] - 2026-07-20

### Added

- Schema-driven LanguageModel argument-key adoption for provider shims (camelCase / snake_case from advertised tool schemas).
- User-facing install guide and version bump / publish runbook.

### Fixed

- Releases gated on `bun.lock` and packed train dependency pins so workspace protocol cannot leak to npm.

## [0.1.1] - 2026-07-20

### Added

- Public npm publish tooling and Option B LanguageModel adoption for OpenCode-clone hosts.
