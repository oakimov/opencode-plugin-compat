# AGENTS.md — opencode-plugin-compat

## Product

Universal **OCP** compatibility **bridge** monorepo. Ship the **complete** stack — no phased MVP cuts.

- Goal: **any OpenCode plugin runs unchanged** on cooperating hosts via facades + **one** autodetection adapter + host kit.
- OCP is an **external compatibility layer** for MiMo/Kilo/OpenCode — hosts are read-only references; all OCP work lives in this repo.
- **User delivery UX (locked):** one installable umbrella package (`@opencode-compat/ocp`) + **`ocp setup`** that writes install-tree overrides; users then add **consumer** plugins via host config (`plugin` / equivalent) unchanged. Listing OCP itself in `plugin` is optional bootstrap only — it does **not** intercept other plugins’ imports by itself.
- Facades remapped in **plugin install trees / operator overrides** (not spoofing public `@opencode-ai` on npm; npm publish held until necessary).
- Scope: `@opencode-compat/*` — **host bridge packages** (internal) + umbrella UX package + named **companions** that must not redefine OCP success.
- License: **MPL-2.0** (all packages).
- ZCode is **T0 only** for OCP (marketplace ≠ OpenCode plugin ABI). Companion `@opencode-compat/migrate-zcode` migrates **plugin-packaged** skills/commands/marketplace manifests into `.zcode-plugin` trees (**not** host MCP; **not** unchanged `@opencode-ai/plugin` loadability).
- **Do not** create or plan host-specific forks of consumer plugins (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, ZCode variants, etc.). Close gaps in the bridge.
- **Do not** ship separate per-host adapter packages. Host differences are `HostProfile` data + dispatch inside `@opencode-compat/adapter`.

## Layout

```
packages/ocp          # umbrella UX (+ setup) — planned / ship with product
packages/profile|facade-*|adapter|host-promise-v2|cli|migrate-zcode
fixtures/          # OCP conformance (migrator tests use in-memory mocks)
patches/           # host enablement notes (operator attach)
docs/ocp/0.1.md   # contract
docs/plans/        # ADR + product plan + evidence (+ zcode-asset-migrator-plan.md)
docs/guides/       # companion privacy / ZCode import notes (non-OCP runtime)
```

## Build rules

- Prefer Bun workspaces; TypeScript strict; ESM only.
- Facades / universal adapter must not hardcode a single fork’s XDG paths — use `HostProfile` + autodetection.
- MiMo extension hooks (`actor.*`, `session.*`) are **non-portable** — never require them for T1 plugins.
- Facade `v2/effect` may loud-fail unless host declares capability; `v2/promise` + aisdk is the T3 bar.
- Do not claim ZCode drop-in without a Z.AI vendor loader.
- Consumer plugins (e.g. `cursor-opencode-provider`) are **test/matrix subjects**, not deliverables of this repo.
- Privacy companions: Kilo/MiMo document **in-app** telemetry opt-out; ZCode telemetry is **docs-only** firewall/DNS — never claim an OCP plugin kill.

## Docs source of truth

1. `docs/ocp/0.1.md` — protocol
2. `docs/plans/phase0-adr-universal-compat.md` — decisions
3. `docs/plans/universal-opencode-plugin-compat-plan.md` — product plan

## Suggested next work

1. Ship `@opencode-compat/ocp` umbrella + `ocp setup` (auto-write Layer A overrides into host plugin install trees); keep internal packages as implementation detail.
2. Prove unchanged plugins (classic + `v2/promise`, incl. `cursor-opencode-provider`) on MiMo/Kilo via setup + facades + adapter + host kit.
3. Close path/env gaps in the bridge (`HostProfile`, doctor, docs, optional operator copy/symlink into host-native project dirs).
4. Expand `facade-sdk` surface from real plugin smoke failures; keep matrix green. Wire `host-promise-v2` from the OCP layer where provider-resolve allows.
5. Companion migrator MVP is landed (`migrate-zcode` library + `compat migrate-zcode`); keep ZCode OCP at T0; never pack host MCP. Optional Step I = marketplace polish only.
6. Hold npm publish of `@opencode-compat/*` until necessary (umbrella can ship from git/tarball first).

Companion privacy guides (§7.1) are shipped under `docs/guides/` (Kilo/MiMo in-app opt-out; ZCode docs-only firewall/DNS). Doctor prints one-liner pointers; OCP never mutates telemetry.
