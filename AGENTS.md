# AGENTS.md — opencode-plugin-compat

## Product

Universal **OCP** compatibility **bridge** monorepo. Ship the **complete** stack — no phased MVP cuts.

- Goal: **any OpenCode plugin runs unchanged** on cooperating hosts via facades + **one** autodetection adapter + host kit.
- Facades remapped **inside fork install trees** (not spoofing public `@opencode-ai` on npm).
- Scope: `@opencode-compat/*` (host bridge packages only).
- License: **MPL-2.0** (all packages).
- ZCode is **T0 only** (marketplace ≠ OpenCode plugin ABI).
- **Do not** create or plan host-specific forks of consumer plugins (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, ZCode variants, etc.). Dual-package tracks are **out of scope**; close gaps in the bridge.
- **Do not** ship separate per-host adapter packages. Host differences are `HostProfile` data + dispatch inside `@opencode-compat/adapter`.

## Layout

```
packages/profile|facade-*|adapter|host-promise-v2|cli
fixtures/          # conformance
patches/           # reference M1 MiMo/Kilo patches
docs/ocp/0.1.md   # contract
docs/plans/        # ADRs + plans
docs/guides/       # companion privacy notes (non-runtime)
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

1. Implement `@opencode-compat/profile` HostProfile + drafts + detect().
2. Classic exports on `facade-plugin` / `facade-sdk`.
3. `@opencode-compat/adapter` — one runtime: detect host, dispatch to native SDK (opencode / mimo / kilo; zcode → T0 doctor).
4. `host-promise-v2` aisdk kit + CLI doctor + fixtures.
5. Prove unchanged plugins (incl. classic + `v2/promise` samples) on MiMo/Kilo via the bridge — not via republished host forks.