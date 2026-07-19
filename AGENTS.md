# AGENTS.md — opencode-plugin-compat

## Product

Universal **OPHP** (OpenCode Plugin Host Protocol) monorepo. Ship the **complete** stack — no phased MVP cuts.

- Facades remapped **inside fork install trees** (not spoofing public `@opencode-ai` on npm).
- Scope: `@opencode-compat/*`
- License: **MPL-2.0** (all packages).
- ZCode is **T0 only** (marketplace ≠ OpenCode plugin ABI).
- Cursor dual-host packages are a **parallel TX track** in `cursor-opencode-provider`, not this repo’s publishables.

## Layout

```
packages/profile|facade-*|adapter-*|host-promise-v2|cli
fixtures/          # conformance
patches/           # reference M1 MiMo/Kilo patches
docs/ophp/0.1.md   # contract
docs/plans/        # ADRs + plans (moved from cursor-opencode-provider/tasks)
```

## Build rules

- Prefer Bun workspaces; TypeScript strict; ESM only.
- Core facades/adapters must not hardcode a single fork’s XDG paths — use `HostProfile`.
- MiMo extension hooks (`actor.*`, `session.*`) are **non-portable** — never require them for T1 plugins.
- Facade `v2/effect` may loud-fail unless host declares capability; `v2/promise` + aisdk is the T3 bar.
- Do not claim ZCode drop-in without a Z.AI vendor loader.

## Docs source of truth

1. `docs/ophp/0.1.md` — protocol
2. `docs/plans/phase0-adr-universal-compat.md` — decisions
3. `docs/plans/universal-opencode-plugin-compat-plan.md` — product plan

## Suggested next work

1. Implement `@opencode-compat/profile` HostProfile + drafts.
2. Classic exports on `facade-plugin` / `facade-sdk`.
3. `adapter-mimo` first, then `adapter-kilo`, identity `adapter-opencode`, T0 `adapter-zcode`.
4. `host-promise-v2` aisdk kit + CLI doctor + fixtures.
5. Parallel: dual-host packages in `cursor-opencode-provider`.
