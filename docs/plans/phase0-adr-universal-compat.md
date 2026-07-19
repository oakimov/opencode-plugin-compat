# ADR — Universal OpenCode / MiMo / Kilo / ZCode compat product

**Date:** 2026-07-19 (revised: final-product framing)  
**Status:** **Accepted — build the final product** (no phased MVP delivery)  
**Filename note:** Kept as `phase0-adr-universal-compat.md` for link stability; content is the product ADR.  
**Repo:** `opencode-plugin-compat` (`docs/plans/`; contract at `docs/ocp/0.1.md`)  
**Scope:** Ship a truly universal compat layer across OpenCode, MiMo, Kilo, with ZCode at T0  
**Inputs:** `universal-opencode-plugin-compat-plan.md`, `phase0-hooks-parity.md`, `ocp-0.1-spec.md`, prior MiMo/dual-host plans, ZCode 3.3.6 exam, Kilo spike, public ZCode plugins (`glm-hammer`, `zcode-glm-fleet`; see [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md) §7)

---

## 1. Context

Published OpenCode plugins import `@opencode-ai/plugin` (+ optional `/v2/promise`). Forks rebrand packages and paths:

- **MiMo** → `@mimo-ai/*`, `.mimocode`, `MIMOCODE_*`, classic + **extra** actor/session hooks, **no** published v2 exports  
- **Kilo** → `@kilocode/*`, `.kilo`/`.kilocode`, `KILO_*`, classic Hooks **= OpenCode 1.18.3 key-identical**, **no** v2 exports, **no** project `.opencode` scan  
- **ZCode** → marketplace / Electron loader (`.zcode-plugin` + Claude-style hooks; public ecosystem exists); **not** the OpenCode npm plugin ABI  

Goal: one universal **compatibility bridge** so **published OpenCode plugins run unchanged** on cooperating hosts (no republish, no per-host plugin forks). Example consumer: `cursor-opencode-provider` — must work via OCP, not via `cursor-mimocode-provider` / Kilo / ZCode variants.

**Delivery rule:** No “Phase 1 T1 / Phase 2 T3 / Phase 3 …” product cuts. Research is finished. Ship the complete **external** bridge stack (facades, **one universal adapter**, host kit, doctor, fixtures, host enablement notes, matrix). Dual-host consumer packages are **out of scope**. Per-host adapter packages are **out of scope**. **Do not** open or maintain upstream PRs/forks against MiMo/Kilo for OCP.

---

## 2. Decisions

### ADR-1 — Delivery model: **external OCP layer** (operator overrides / sidecar); host source untouched

| Option | Verdict |
|--------|---------|
| External `@opencode-compat/*` layer — install-tree overrides, doctor/matrix, host-kit helpers without patching host repos | **Chosen** |
| In-fork embed — PR dual-scan / embed kit into XiaomiMiMo or Kilo-Org | **Rejected** for this project (hosts remain read-only references) |
| M2 — user sidecar / manual cache patches only | Compatible with Layer A; T3 still needs reachable provider-resolve seams via OCP, not upstream PRs |

**Consequences:** Ship and maintain OCP in this repo only. Path gaps → docs/doctor/operator copy-symlink. ZCode stays T0. Mistaken dual-scan upstream PRs were closed; do not reopen.

### ADR-2 — Protocol name & product shape: **OCP 0.1 = classic T1+T2 path story + Promise v2 aisdk (T3)**

- Spec: `ocp-0.1-spec.md`  
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

- Universal `@opencode-compat/adapter` detects `zcode` and refuses OCP load with doctor text  
- Document marketplace ≠ OCP  
- Optional future research: skills/commands bridge — **separate** from OCP  
- Do not block MiMo/Kilo progress on Z.AI politics  
- Do **not** ship a separate `adapter-zcode` package  

### ADR-6 — Universal bridge only (no per-host consumer plugin forks; no per-host adapter packages)

| Track | Role |
|-------|------|
| Universal OCP bridge | **Chosen** — facades + **one** autodetection adapter + host kit so plugins run **unchanged** |
| Per-host `@opencode-compat/adapter-*` packages | **Rejected** — host variance is `HostProfile` + internal dispatch |
| `dual-host-packages-plan.md` (`cursor-mimocode-provider`, etc.) | **Rejected / superseded** — multiplying host-specific Cursor (or other) provider packages is not this product |

**Success criterion:** green classic + `v2.aisdk.language` fixtures on MiMo + Kilo using the **same** published plugin builds (e.g. unchanged `cursor-opencode-provider`). Gaps are fixed in the bridge (or documented TX limitations), not by shipping fork-branded plugin packages from this effort.

### ADR-7 — MiMo extensions are non-portable

`actor.*` / `session.*` hooks stay **MiMo HostProfile extensions**. Portable plugins must not depend on them. Facade does not surface them on the `@opencode-ai/plugin` portable path in 0.1.

### ADR-8 — Path gaps close in the bridge, not via host PRs

MiMo and Kilo do **not** scan `.opencode` today, so T2 local OpenCode project plugins fail unless the **bridge** closes the gap. Product includes:

- Docs + doctor honesty for `.opencode` vs host-native dirs (`.mimocode` / `.kilo` / `.kilocode`)  
- Operator copy/symlink into host-native project dirs when needed  
- Matrix `--compat-scan` exercising the documented expectation  
- **Do not** open upstream dual-scan PRs from this project

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
| ADR: external layer / facade / OCP 0.1 | ✅ this document |
| Decide repo home | ✅ `opencode-plugin-compat` |

---

## 4. Final product prep (build now)

### P1 — Spec in repo
- Keep `ocp-0.1-spec.md` as the working contract  
- On repo create: copy to `docs/ocp/0.1.md`

### P2 — Repo skeleton
```
opencode-plugin-compat/
  packages/
    profile/                # HostProfile + detect() + drafts
    facade-plugin/
    facade-sdk/
    adapter/                # ONE universal autodetection adapter
    host-promise-v2/
    cli/                    # doctor + matrix
  fixtures/                 # conformance
  docs/ocp/0.1.md
  patches/                  # host enablement notes (NOT upstream PR patches)
```

**Rejected layout:** `adapter-opencode` / `adapter-mimo` / `adapter-kilo` / `adapter-zcode` as separate packages.
### P3 — Host enablement notes (external layer; not upstream PRs)

See [`patches/`](https://github.com/oakimov/opencode-plugin-compat/tree/main/patches) — operator-facing notes for MiMo/Kilo. **Not** patch series or PR sources.

**MiMo / Kilo (via OCP)**
1. Plugin install: overrides for `@opencode-ai/plugin` / `sdk` → facades  
2. Project dirs: document native dirs; optional operator copy/symlink `.opencode` assets into `.mimocode` / `.kilo`  
3. Wire `host-promise-v2` from the OCP layer where provider-resolve can be reached without host source changes  
4. Facade policy for MiMo classic gaps (`dispose`, `small_model`) — accept + no-op + warn

**ZCode**
1. Stub adapter + doctor only  
2. Partner one-pager (optional): what an Electron OpenCode-plugin loader would need

### P4 — Conformance fixtures
Implement OCP §10 fixtures as part of first ship (not a later phase).

### P5 — Public matrix template

| Plugin | OpenCode | MiMo | Kilo | ZCode |
|--------|----------|------|------|-------|
| classic auth sample | T1 | T1* | T1 | T0 |
| oh-my-opencode | T1/TX | TX risk | TX risk | T0 |
| cursor-opencode-provider | T3 | T3 target (unchanged) | T3 target (unchanged) | T0 |

\*MiMo T1 with documented no-op gaps for `dispose` / `small_model`.

### P6 — No dual-package consumer track

| Rule | Action |
|------|--------|
| Any OpenCode plugin | Run **unchanged** through OCP on MiMo/Kilo |
| Host path/env gaps (TX) | Fix in bridge (`HostProfile`, path dual-scan, env mapping) or document residual limits |
| ZCode | T0 only without vendor OpenCode-plugin loader |
| `dual-host-packages-plan.md` | Historical only — do not implement |

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Classic types match but runtime invoke differs | Conformance suite before claiming T1 |
| MiMo extension hooks tempt “universal” API bloat | ADR-7 — extensions non-portable |
| Kilo / MiMo lack `.opencode` scan | T2 via docs/doctor/operator copy-symlink; **do not** upstream dual-scan PRs from this project |
| Facade mistaken for official SDK | Naming `@opencode-compat/*`; docs; overrides only in plugin install trees / operator tooling |
| Scope creep to ZCode marketplace bridge | Hard T0; separate project if ever |
| Effect beta skew (MiMo 48 / Kilo 74 / OC 83) | Facade avoids depending on host Effect for classic T1 |
| “Ship MVP then phases” regression | ADR-9 — one product bar |

---

## 6. What “truly universal” means (honest ceiling)

**In scope for universal OCP product:**
- OpenCode (reference)  
- MiMo + Kilo as **equal host targets** of the external OCP bridge  
- ZCode as **explicit T0 cell** in the same matrix/docs/CLI doctor  

**Not claimed:**
- Drop-in of every plugin on every host without any residual TX limits  
- ZCode marketplace plugins via `@opencode-ai/plugin`  
- Full Effect v2 parity on every fork  
- Host-branded republishes of consumer plugins as a compatibility strategy  
- Upstream PRs or long-lived forks of XiaomiMiMo/MiMo-Code or Kilo-Org/kilocode as the OCP delivery path  

---

## 7. Next actions (build)

1. ~~**Create repo** `opencode-plugin-compat` and move/copy OCP docs~~ **done** (scaffold + `docs/`)  
2. ~~**Implement full product** — profile + facades + **universal adapter** (autodetect) + host kit + CLI + fixtures~~ **done** (matrix green; T3 needs OCP-layer wiring)  
3. **Prove unchanged plugins** on MiMo/Kilo via external overrides / sidecar (classic + `v2/promise` samples, incl. `cursor-opencode-provider`) — **not** via host PRs  
4. Close path/env gaps in bridge docs + doctor; hold npm publish until necessary  

**Recommendation:** Keep all work in this repo. Hosts are read-only references. Do **not** implement dual-host consumer packages, per-host adapter packages, or upstream host PRs.

---

## 8. Document index

| Doc | Role |
|-----|------|
| `universal-opencode-plugin-compat-plan.md` | Master product plan |
| `phase0-hooks-parity.md` | Research evidence (Hooks / path / inventory) |
| `ocp-0.1-spec.md` | Protocol / product contract |
| `phase0-adr-universal-compat.md` | This ADR |
| `mimo-opencode-compat-layer-plan.md` | MiMo integration detail — MiMo is an **equal** `HostProfile` target, not a separate adapter package |
| `dual-host-packages-plan.md` | **Superseded** historical sketch |