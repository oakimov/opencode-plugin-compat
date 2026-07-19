# ADR — Universal OpenCode / MiMo / Kilo / ZCode compat product

**Date:** 2026-07-19 (revised: final-product framing)  
**Status:** **Accepted — build the final product** (no phased MVP delivery)  
**Filename note:** Kept as `phase0-adr-universal-compat.md` for link stability; content is the product ADR.  
**Repo:** `opencode-plugin-compat` (`docs/plans/`; contract at `docs/ophp/0.1.md`)  
**Scope:** Ship a truly universal compat layer across OpenCode, MiMo, Kilo, with ZCode at T0  
**Inputs:** `universal-opencode-plugin-compat-plan.md`, `phase0-hooks-parity.md`, `ophp-0.1-spec.md`, prior MiMo/dual-host plans, ZCode 3.3.6 exam, Kilo spike, public ZCode plugins (`glm-hammer`, `zcode-glm-fleet`; see `oa-tools/zcode-review/ZCODE_RESEARCH.md` §7)

---

## 1. Context

Published OpenCode plugins import `@opencode-ai/plugin` (+ optional `/v2/promise`). Forks rebrand packages and paths:

- **MiMo** → `@mimo-ai/*`, `.mimocode`, `MIMOCODE_*`, classic + **extra** actor/session hooks, **no** published v2 exports  
- **Kilo** → `@kilocode/*`, `.kilo`/`.kilocode`, `KILO_*`, classic Hooks **= OpenCode 1.18.3 key-identical**, **no** v2 exports, **no** project `.opencode` scan  
- **ZCode** → marketplace / Electron loader (`.zcode-plugin` + Claude-style hooks; public ecosystem exists); **not** the OpenCode npm plugin ABI  

Goal: one universal **product** so portable plugins run without republish where feasible; keep dual packages as escape hatch for host-aware plugins (e.g. `cursor-opencode-provider`).

**Delivery rule:** No “Phase 1 T1 / Phase 2 T3 / Phase 3 …” product cuts. Research is finished. Ship the complete stack (facades, adapters, host kit, doctor, fixtures, M1 patches, matrix, dual-host Cursor track).

---

## 2. Decisions

### ADR-1 — Delivery model: **M1-first** (in-fork), M2 overlay only for Layer A

| Option | Verdict |
|--------|---------|
| M1 — forks call compat in install/loader + provider resolve | **Chosen** |
| M2 — user sidecar / manual cache patches only | Stopgap for alias only; **cannot** deliver T3 host kit |

**Consequences:** Ship PRs/patches for MiMo + Kilo. ZCode requires vendor M1 (unlikely short-term) → T0 stub.

### ADR-2 — Protocol name & product shape: **OPHP 0.1 = classic T1+T2 path story + Promise v2 aisdk (T3)**

- Spec: `ophp-0.1-spec.md`  
- Classic core hooks from research parity; MiMo gaps explicit  
- Effect v2: export + loud fail unless host capable (not a deferred product phase)  
- Other Promise domains: loud stub in the **same** host kit release  

### ADR-3 — Facade override mechanism (not owning `@opencode-ai` scope)

Use **install-time overrides** inside fork plugin install directories:

`@opencode-ai/plugin` → `@opencode-compat/facade-plugin`  
`@opencode-ai/sdk` → `@opencode-compat/facade-sdk` (minimal)

Do **not** publish impersonating packages to the public `@opencode-ai/*` org.

### ADR-4 — Repo home: **new repo** `opencode-plugin-compat`

| Option | Verdict |
|--------|---------|
| New repo `opencode-plugin-compat` | **Chosen** — clean package scope, separate versioning/CI matrix |
| Under `cursor-opencode-provider/packages/` | Rejected as primary — couples ecosystem work to one product plugin |
| Only docs in `cursor-opencode-provider/tasks/` | **Interim** until repo is created |

### ADR-5 — ZCode is **first-class in the matrix as T0**, not “ignored”

- Ship `@opencode-compat/adapter-zcode` as **doctor stub**  
- Document marketplace ≠ OPHP  
- Optional future research: skills/commands bridge — **separate** from OPHP  
- Do not block MiMo/Kilo progress on Z.AI politics  

### ADR-6 — Cursor provider strategy vs universal layer

| Track | Role |
|-------|------|
| Universal OPHP | Ecosystem product; MiMo + Kilo adapters + host kit |
| `dual-host-packages-plan.md` | **Build in parallel** for `cursor-opencode-provider` until T3 aisdk smoke passes on both open forks **and** path bridge proves enough |

**Re-eval trigger:** first green `v2.aisdk.language` fixture on MiMo + Kilo with an unchanged provider build. Until then, dual packages remain the product path for Cursor.

### ADR-7 — MiMo extensions are non-portable

`actor.*` / `session.*` hooks stay **MiMo HostProfile extensions**. Portable plugins must not depend on them. Facade does not surface them on the `@opencode-ai/plugin` portable path in 0.1.

### ADR-8 — Path dual-scan is a host PR, not a facade feature

Without M1 changes, T2 (`.opencode` local plugins) **fails** on MiMo and Kilo. Product includes:

- MiMo: scan `.opencode` after `.mimocode` (fixes docs bug #1151 as behavior)  
- Kilo: opt-in or documented compat scan for `.opencode` (higher friction — they deliberately removed it)

### ADR-9 — No phased product delivery

Compatibility **tiers** (T0–T5, TX) remain labels for what a host/plugin combination supports. They are **not** engineering phases. Incomplete surfaces fail loud inside the shipped product; we do not withhold the host kit or doctor for a later “phase.”

---

## 3. Research checklist (complete)

From discovery (artifacts under `tasks/`):

| Item | Status |
|------|--------|
| Confirm Kilo env/XDG/plugin cache | ✅ |
| Confirm Kilo no project `.opencode` scan | ✅ |
| Examine ZCode 3.3.6 plugin ABI | ✅ T0 |
| Diff classic Hooks OC × MiMo × Kilo | ✅ `phase0-hooks-parity.md` |
| Inventory top OpenCode plugins classic vs v2 | ✅ sample in parity doc |
| ADR: M1 / facade / OPHP 0.1 | ✅ this document |
| Decide repo home | ✅ `opencode-plugin-compat` |

---

## 4. Final product prep (build now)

### P1 — Spec in repo
- Keep `ophp-0.1-spec.md` as the working contract  
- On repo create: copy to `docs/ophp/0.1.md`

### P2 — Repo skeleton
```
opencode-plugin-compat/
  packages/
    profile/
    facade-plugin/
    facade-sdk/
    adapter-opencode/
    adapter-mimo/
    adapter-kilo/
    adapter-zcode/          # T0 stub
    host-promise-v2/
    cli/                    # doctor + matrix
  fixtures/                 # conformance
  docs/ophp/0.1.md
  patches/                  # reference M1 patches for MiMo/Kilo
```

### P3 — M1 patch outlines (ship with product)

**MiMo**
1. Plugin install: overrides for `@opencode-ai/plugin` / `sdk`  
2. `ConfigPaths.directories`: append `.opencode` targets  
3. Embed `host-promise-v2` at provider resolve (T3)  
4. Optionally add missing `dispose` + `experimental.provider.small_model` to `@mimo-ai/plugin` (upstream hygiene)

**Kilo**
1. Same install overrides under `~/.cache/kilo/packages` / local `.kilo`  
2. Opt-in `.opencode` project scan (`KILO_COMPAT_OPENCODE_DIRS=1` or always-on compat)  
3. Embed host kit for T3  
4. Replace residual `@opencode-ai/plugin` type-casts in builtin auth plugins with facade types

**ZCode**
1. Stub adapter + doctor only  
2. Partner one-pager (optional): what an Electron OpenCode-plugin loader would need

### P4 — Conformance fixtures
Implement OPHP §10 fixtures as part of first ship (not a later phase).

### P5 — Public matrix template

| Plugin | OpenCode | MiMo | Kilo | ZCode |
|--------|----------|------|------|-------|
| classic auth sample | T1 | T1* | T1 | T0 |
| oh-my-opencode | T1/TX | TX risk | TX risk | T0 |
| cursor-opencode-provider | T3/TX | dual-pkg until T3 | dual-pkg until T3 | T0 |

\*MiMo T1 with documented no-op gaps for `dispose` / `small_model`.

### P6 — Dual-package track (Cursor provider)

| Milestone | Dual-pkg action |
|-----------|-----------------|
| Until T3 aisdk green on forks | Dual-host packages are the Cursor product path |
| T3 aisdk green on MiMo | Spike single package + overrides; keep MiMo package if TX paths remain |
| T3 green on MiMo+Kilo + path bridge | Consider deprecating extra packages |
| ZCode | Never via OPHP without vendor loader; out of dual-pkg scope |

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Classic types match but runtime invoke differs | Conformance suite before claiming T1 |
| MiMo extension hooks tempt “universal” API bloat | ADR-7 — extensions non-portable |
| Kilo refuses `.opencode` scan PR | T2 degraded; document copy-to-`.kilo` workaround |
| Facade mistaken for official SDK | Naming `@opencode-compat/*`; docs; overrides only in fork caches |
| Scope creep to ZCode marketplace bridge | Hard T0; separate project if ever |
| Effect beta skew (MiMo 48 / Kilo 74 / OC 83) | Facade avoids depending on host Effect for classic T1 |
| “Ship MVP then phases” regression | ADR-9 — one product bar |

---

## 6. What “truly universal” means (honest ceiling)

**In scope for universal OPHP product:**
- OpenCode (reference)  
- MiMo + Kilo as **cooperating open CLI forks** (M1)  
- ZCode as **explicit T0 cell** in the same matrix/docs/CLI doctor  

**Not claimed:**
- Drop-in of every plugin on every host without republish  
- ZCode marketplace plugins via `@opencode-ai/plugin`  
- Elimination of dual packages for all TX plugins on day one  
- Full Effect v2 parity on every fork  

---

## 7. Next actions (build)

1. ~~**Create repo** `opencode-plugin-compat` and move/copy OPHP docs~~ **done** (scaffold + `docs/`)  
2. **Implement full product** — profile + facades + MiMo/Kilo/OpenCode/ZCode adapters + host kit + CLI + fixtures  
3. **M1 patches** against MiMo/Kilo (overrides, dual-scan, host kit embed)  
4. **Dual-host packages** for Cursor provider in parallel (`cursor-opencode-provider`)  
5. Prefer naming **`@opencode-compat/*`** (open question #5 default)

**Recommendation:** (1)+(2)+(3) with MiMo as first adapter proof; (4) in parallel for Cursor MiMo support.

---

## 8. Document index

| Doc | Role |
|-----|------|
| `universal-opencode-plugin-compat-plan.md` | Master product plan |
| `phase0-hooks-parity.md` | Research evidence (Hooks / path / inventory) |
| `ophp-0.1-spec.md` | Protocol / product contract |
| `phase0-adr-universal-compat.md` | This ADR |
| `mimo-opencode-compat-layer-plan.md` | First adapter instance detail |
| `dual-host-packages-plan.md` | Cursor provider escape hatch |