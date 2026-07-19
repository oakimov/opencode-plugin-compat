# Plan: MiMo OpenCode plugin compatibility (M1 integration detail)

**Date:** 2026-07-19 (revised: final-product framing)  
**Status:** **Build as part of final OPHP product** — no phased MVP. MiMo is an **equal** cooperating host and `HostProfile` target of the one universal adapter (this doc is M1 integration detail, worked first only for build sequencing), **not** a privileged "proof" and **not** a separate adapter package  
**Primary target:** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) (upstream PR / fork work) via universal `@opencode-compat/adapter` + `HostProfile` `mimo`  
**Repo:** `opencode-plugin-compat` (`docs/plans/`)  
**Related:** `universal-opencode-plugin-compat-plan.md` (parent); `dual-host-packages-plan.md` is **superseded / out of scope** (historical only)  
**Goal:** Let **published OpenCode plugins** load on MiMoCode with **no republish**, including **plugin v2** (`@opencode-ai/plugin/v2/promise`), via the universal compat product (facade + **one** adapter + host kit + M1 patches).

---

## 1. Problem statement

MiMoCode is an OpenCode fork but breaks drop-in plugins because:

1. **Package rename** — plugins import `@opencode-ai/plugin` / `@opencode-ai/sdk`; MiMo ships `@mimo-ai/*` only.
2. **Path rename** — loader scans `.mimocode/`; docs still mention `.opencode/` which is ignored ([MiMo issue #1151](https://github.com/XiaomiMiMo/MiMo-Code/issues/1151)).
3. **No plugin v2 surface** — `@mimo-ai/plugin` exports `.`, `./tool`, `./tui` only. OpenCode exports `./v2/promise` and `./v2/effect`. OpenCode’s **host** for v2 lives mainly under `packages/core/src/plugin/` (Effect-first; Promise adapted via `fromPromise`). MiMo has no equivalent host.
4. **Env / XDG** — `OPENCODE_*` vs `MIMOCODE_*`; auth/cache under `opencode` vs `mimocode`.
5. **API drift** — classic Hooks are similar, but MiMo adds actor/trajectory hooks; OpenCode continues to evolve v2 domains.

**Desired outcome:**  
`{ "plugin": ["some-opencode-plugin"] }` in MiMo config works for a documented compatibility tier without editing the plugin.

**Non-goal:** Perfect behavioral identity with upstream OpenCode for every plugin forever.

---

## 2. Design principles

1. **Compat lives in MiMo** (install + loader + runtime), not in each plugin repo.
2. **Alias, don’t spoof npm scope ownership** — resolve `@opencode-ai/*` inside MiMo’s plugin install tree to `@opencode-compat/facade-*` (which dispatch via the universal adapter to `@mimo-ai/*`). Do not require publishing to the real `@opencode-ai` npm org.
3. **Tiered compatibility** — ship full OPHP surface (T1–T3 + loud stubs); document gaps honestly.
4. **v2 is a host problem, not only an export problem** — re-exporting types without invoking `ctx.aisdk.*` / catalog transforms does nothing.
5. **Promise v2 before Effect v2** — most third-party providers (e.g. `cursor-opencode-provider`) use `@opencode-ai/plugin/v2/promise`. Effect v2 is larger and tied to OpenCode’s Effect plugin host.
6. **Fail loud** — unsupported v2 domains / missing hooks should error with actionable messages, not silent no-ops (except where OpenCode itself no-ops).

---

## 3. Compatibility architecture

```
┌─────────────────────────────────────────────────────────────┐
│  OpenCode plugin (unchanged on npm)                         │
│    import "@opencode-ai/plugin"                             │
│    import "@opencode-ai/plugin/v2/promise"                  │
│    import "@opencode-ai/sdk"                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ dynamic import after install
┌───────────────────────────▼─────────────────────────────────┐
│  MiMo plugin install (resolvePluginTarget)                  │
│    • bun/npm install plugin into cache                      │
│    • package.json overrides / alias:                        │
│        @opencode-ai/plugin -> @opencode-compat/facade-plugin│
│        @opencode-ai/sdk    -> @opencode-compat/facade-sdk   │
│    • facade → @opencode-compat/adapter (detect mimo)        │
│              → native @mimo-ai/plugin / @mimo-ai/sdk        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  OPHP facade + universal adapter (mimo HostProfile)         │
│    "."           classic Hooks via adapter→@mimo-ai/plugin  │
│    "./v2/promise" define() + PluginContext (host kit)       │
│    "./v2/effect"  loud unsupported unless capable           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  MiMo runtime host                                          │
│    • classic loader (existing)                              │
│    • v2 promise host: setup(ctx) + aisdk/catalog/… hooks    │
│    • path compat: scan .opencode + .mimocode                │
│    • env/path bridge for plugin-side FS assumptions         │
└─────────────────────────────────────────────────────────────┘
```

### Suggested package split (OPHP + MiMo M1)

| Artifact | Role |
|----------|------|
| `@opencode-compat/facade-plugin` / `facade-sdk` | Install-override stand-ins for `@opencode-ai/*` (Layer A target) |
| `@opencode-compat/adapter` | Universal autodetection; `mimo` dispatch → `@mimo-ai/*` |
| `@opencode-compat/host-promise-v2` | Shared Promise v2 aisdk kit MiMo embeds (M1) |
| MiMo `packages/opencode/src/plugin/*` | Install overrides → facade, dual-dir scan, v2 loader/host wiring |

**Do not** alias `@opencode-ai/plugin` straight to `@mimo-ai/plugin` as the product path — that skips OPHP (v2 surface, doctor, shared host kit). Prefer **one export surface** plugins already know: `@opencode-ai/plugin` → **facade** → universal adapter → `@mimo-ai/plugin`.

---

## 4. Layer details

### 4.1 Install-time module alias (Layer A) — required

**When:** `resolvePluginTarget` / npm plugin install into MiMo cache.

**Mechanism (pick one, prefer overrides → facade):**
- Write/merge `overrides` (npm) or Bun equivalent in the plugin install `package.json`:
  - `"@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@<ophp-version>"`
  - `"@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@<ophp-version>"`
- Facade → `@opencode-compat/adapter` (autodetect `mimo`) → native `@mimo-ai/plugin` / `@mimo-ai/sdk`.
- Do **not** override `@opencode-ai/plugin` straight to `@mimo-ai/plugin` as the product path (skips OPHP v2 surface, doctor, shared host kit).
- Optional fallback for experiments only: a tiny local `file:` / `link:` shim that re-exports under `@opencode-ai/*` names **inside the cache only** — still prefer the published facades.

**Must cover subpath exports (via facade):**
- `@opencode-ai/plugin` → `@opencode-compat/facade-plugin` → adapter → `@mimo-ai/plugin`
- `@opencode-ai/plugin/tool`, `/tui`
- `@opencode-ai/plugin/v2/promise` (+ `/v2/effect` when ready)
- `@opencode-ai/sdk`, `@opencode-ai/sdk/v2`, … (match what plugins import)

**Acceptance:** A minimal plugin whose only code is `import from "@opencode-ai/plugin"` loads under MiMo without source changes.

**Estimate:** 2–4 days (install plumbing + tests + version pinning policy).

---

### 4.2 Path & config discovery (Layer B) — required for local plugins

**Today:** MiMo scans `.mimocode/{plugin,plugins}/*`; `.opencode/` ignored.

**Change:**
1. Auto-load local plugins from, in order (document precedence):
   - `.mimocode/plugin(s)/`
   - `.opencode/plugin(s)/` (compat)
2. When merging project config, optionally read `opencode.json` / `opencode.jsonc` if `mimocode.json(c)` absent (or merge with mimocode winning).
3. Fix docs (`plugins.mdx`) so they match behavior.

**Acceptance:** Dropping a classic plugin file under `.opencode/plugins/foo.ts` loads on MiMo.

**Estimate:** 1–2 days.

---

### 4.3 Env / XDG bridge (Layer C) — recommended

Plugins often hardcode `~/.config/opencode`, `~/.cache/opencode`, `~/.local/share/opencode`, or `OPENCODE_*`.

**Options (combine lightly):**
1. **Document** that host-aware plugins must use MiMo paths (compat tier excludes them).
2. **Runtime bridge (opt-in):** at process start, if `MIMOCODE_OPENCODE_PATH_COMPAT=1`, set dual env or symlink/profile helpers:
   - Treat missing `OPENCODE_*` as fallthrough to `MIMOCODE_*`
   - Optional: ensure cache/data dirs — **do not** silently write secrets to OpenCode paths by default
3. Longer-term: encourage plugins to accept injected dirs (out of scope for “unchanged”).

**Acceptance:** Documented matrix; optional bridge behind flag; no surprise dual auth stores by default.

**Estimate:** 1–2 days for flag + docs; deep FS virtualization out of scope.

---

### 4.4 Classic Hooks parity (Layer D) — mostly done

MiMo already exposes classic `Hooks` (`auth`, `config`, `chat.*`, `tool.execute.*`, experimental transforms, plus MiMo-only `actor.*`).

**Work:**
- Diff OpenCode `@opencode-ai/plugin` Hooks vs MiMo; fill any missing **stable** classic hooks plugins rely on.
- Ensure `PluginInput` / auth method shapes remain load-compatible.
- Compatibility tests: fixture classic plugin (auth + `chat.params` + tool hooks).

**Estimate:** 1–3 days depending on diff size.

---

### 4.5 Plugin v2 compatibility (Layer E) — core of this plan

OpenCode v2 is two public APIs + an in-process **host**:

| Piece | OpenCode location | Role |
|-------|-------------------|------|
| Types + `define()` | `packages/plugin/src/v2/promise`, `v2/effect` | Plugin author surface (~400 LOC types) |
| Effect host | `packages/core/src/plugin/*` | Actually runs hooks (thousands of LOC incl. providers) |
| Promise adapter | `core/.../promise.ts` `fromPromise` | Adapts Promise plugins onto Effect host |

MiMo must provide **both** export paths **and** a host that calls hooks.

#### 4.5.1 Public exports (shim package surface)

Add to `@mimo-ai/plugin` (matching OpenCode export map) **and/or** via OPHP facade `v2/promise`:

```
./v2/promise          → define, PluginContext, domain hook types
./v2/effect           → loud unsupported unless Effect host exists
```

`define()` remains identity (`return plugin`) as upstream.

#### 4.5.2 Promise v2 host with `aisdk` (product requirement)

**Why required in first ship:** Provider plugins (Cursor, custom AI SDK wrappers) primarily use:

```ts
await ctx.aisdk.sdk((event) => { … event.sdk = … })
await ctx.aisdk.language((event) => { … event.language = … })
```

**Implement via `@opencode-compat/host-promise-v2`** embedded by MiMo M1 (do **not** require full Effect port):

1. Config field parity: support OpenCode-style `plugins: ["pkg/plugin/v2"]` **or** map legacy `plugin` entries that export v2 `define()` shapes.
2. Loader: detect v2 module (`export` with `{ id, setup }` / known export path).
3. On session/provider resolve, build `PluginContext` with:
   - **Implemented:** `options`, `aisdk.sdk`, `aisdk.language`, `plugin.add/remove` (minimal)
   - **Loud unsupported:** `agent`, `catalog`, `command`, `integration`, `reference`, `skill` until wired — same release, not a later phase
4. Wire `aisdk` hooks into MiMo’s provider → LanguageModel resolution path.

**Acceptance:** Unchanged `cursor-opencode-provider`-style v2 entry (`define` + `ctx.aisdk.*`) registers a custom LanguageModel on MiMo when classic auth plugin also loads — close path/TX gaps in the bridge; do **not** ship a host-specific Cursor package.

#### 4.5.3 Promise domains beyond aisdk

Implement transform/reload for domains plugins use in the wild, prioritized by survey, **inside the same product** (loud stub until complete):

1. `catalog.transform` — inject/disable providers  
2. `agent.transform` — custom agents  
3. `skill` / `command` — if common  
4. `integration` / `reference` — as needed  

#### 4.5.4 Effect v2

Options:
- **A.** Cherry-pick / port OpenCode Effect plugin host + `fromPromise` (best long-term parity).  
- **B.** Promise-only; `./v2/effect` throws clear “use promise” / “not supported.”  

**Product default:** B unless Effect-only plugins block real users. Effect completeness is **not** a deferred phase of this plan — it is an explicit non-goal until demanded.

---

## 5. Compatibility tiers (document in MiMo docs)

| Tier | What works | Mechanism |
|------|------------|-----------|
| **T0 — Broken (today)** | Almost no `@opencode-ai/*` plugins | — |
| **T1 — Classic npm** | Classic Hooks plugins using `@opencode-ai/plugin` imports | Layer A (+ D) |
| **T2 — Classic local** | Files under `.opencode/plugins` | A + B |
| **T3 — Promise v2 providers** | `v2/promise` + `aisdk` hooks | A + E (host kit) |
| **T4 — Promise v2 full domains** | catalog/agent/skill transforms | E (domain wiring; loud stub until done) |
| **T5 — Effect v2** | `@opencode-ai/plugin/v2/effect` | Loud fail unless Effect host exists |
| **Excluded / TX** | Hardcoded OpenCode XDG paths, OpenCode-only env, version-skewed private APIs | Dual host package / plugin patch |

Publish a **compat matrix** page: plugin name × tier × last tested MiMo version.

---

## 6. Final product workstreams (no phases)

Research (Hooks diff, package surface, path scan) is **done** — see universal plan / `phase0-hooks-parity.md`.

Build **all** of the following as the MiMo slice of the OPHP product:

| Workstream | Work |
|------------|------|
| **Alias (A)** | Install-time `@opencode-ai/plugin` + `sdk` (+ v2 subpaths) → facade / `@mimo-ai/*` |
| **Paths (B)** | Dual-scan `.opencode` + `.mimocode`; fix docs (#1151) |
| **Env bridge (C)** | Opt-in path bridge; no secret dual-write |
| **Classic (D)** | Gaps: `dispose`, `experimental.provider.small_model` (no-op + doctor or upstream add); fixture plugins |
| **v2 host (E)** | Facade `v2/promise` + embed `host-promise-v2` aisdk; other domains loud-stub |
| **Release** | Compat matrix row for MiMo; M1 PR to XiaomiMiMo/MiMo-Code; changelog |

**Exit bar (MiMo):** T1 + T2 path story + T3 aisdk fixture; Effect = loud fail unless ported.

---

## 7. Testing strategy

| Test | Asserts |
|------|---------|
| Unit: override map generation | Alias entries for plugin/sdk/v2 subpaths |
| Unit: path scan order | `.mimocode` wins over `.opencode` when both exist (define rule) |
| Integration: classic fixture plugin | Hooks fire under alias import |
| Integration: v2 aisdk fixture | `setup` runs; sdk/language hooks invoked on model resolve |
| Integration: unsupported domain | Clear error when plugin calls stubbed `ctx.catalog.transform` |
| Manual smoke matrix | Real plugins from inventory |
| Regression | Existing MiMo-native plugins still load |

CI should **not** require Cursor credentials; use fake LanguageModel fixtures.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Alias breaks bun/npm resolution edge cases | Single install codepath + lockfile tests; pin override target versions |
| v2 host incomplete → plugins “load” but do nothing | Fail on unsupported domain use; matrix honesty |
| OpenCode core Effect host too large to port | Promise host + loud Effect stub |
| Fork drift: OpenCode adds v2 hooks MiMo lacks | Compat tests against pinned OpenCode plugin package versions; periodic diff job |
| Security: installing arbitrary npm plugins | Unchanged threat model; document trust boundary (same as OpenCode) |
| Path compat dual-writes auth | Default off; no silent copy of `auth.json` |
| Community expects 100% unchanged | Publish tiers; excluded list |

---

## 9. Relationship to dual-host packages plan

| Approach | Role |
|----------|------|
| **This MiMo adapter + OPHP** | **In scope** — third-party OpenCode plugins on MiMo without republish |
| **`dual-host-packages-plan.md`** | **Superseded / out of scope** — do not build `cursor-mimocode-provider` or other host-specific forks |

Close TX/path gaps in the bridge so unchanged plugins (including `cursor-opencode-provider`) work. Dual-package tracks are not a parallel product path.

---

## 10. Effort summary

| Scope | Estimate |
|-------|----------|
| Alias + paths + classic gaps | ~1 week |
| Promise v2 aisdk host + wiring | ~1–2 weeks |
| Path bridge + domain stubs/wiring | ~1–2 weeks (overlap) |
| Effect stub (default) | days |
| Docs / matrix / upstream PR | parallel ~1 week |
| **MiMo product slice** | **~3–5 weeks eng** (calendar + upstream review) |

---

## 11. Success criteria

1. Documented tiers T1–T3 with CI fixtures on MiMo.  
2. Unchanged classic OpenCode plugin installs via MiMo config and runs auth/config hooks.  
3. Unchanged Promise v2 plugin using only `ctx.aisdk.*` can supply a LanguageModel on MiMo (bridge closes TX/path gaps; no dual-package fallback).  
4. `.opencode/plugins` local plugins load (documented precedence vs `.mimocode`).  
5. `@opencode-ai/plugin/v2/promise` import resolves under MiMo install alias/facade.  
6. Unsupported Effect/domains fail clearly.  
7. Compat matrix updated for at least 3 real community plugins on MiMo.

---

## 12. Ownership & delivery options

| Option | Pros | Cons |
|--------|------|------|
| **PR to XiaomiMiMo/MiMo-Code** | Right layer; benefits ecosystem | Review latency |
| **Hard fork of MiMo with compat** | Ship faster | Ongoing merge cost |
| **External installer wrapper** | No upstream needed | Fragile; doesn’t fix runtime v2 host |

**Recommendation:** Design for upstream PR; develop on a short-lived fork if needed; ship full MiMo product slice (A–E above), not a classic-only interim.

---

## 13. Immediate next actions

1. Implement universal `@opencode-compat/adapter` (`mimo` `HostProfile` dispatch) + facade overrides under `opencode-plugin-compat`.  
2. M1 patch: install overrides → **facade** (not direct `@mimo-ai/*`) + dual-scan + host kit embed.  
3. Classic + aisdk fixtures green.  
4. Upstream PR + matrix row.  
5. Prove unchanged `cursor-opencode-provider` via the bridge — **no** `cursor-mimocode-provider` / dual-package track.

---

## 14. Out of scope

- Republishing all OpenCode plugins under `@mimo-ai/*`.  
- Guaranteeing plugins that import private OpenCode `packages/core` paths.  
- Implementing MiMo long-horizon features inside the compat layer.  
- Automatic source rewriting of plugin git repos.  
- Phased “classic now / v2 later” product cuts.  
- Full Effect v2 host parity unless demanded.