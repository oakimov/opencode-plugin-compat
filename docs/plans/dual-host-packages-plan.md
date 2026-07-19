# Plan: Dual-host packages (OpenCode + MiMoCode) in one repo

**Date:** 2026-07-19 (revised: final-product framing)  
**Plan home:** `opencode-plugin-compat/docs/plans/` (OPHP product docs)  
**Implementation repo:** `cursor-opencode-provider` (`~/Projects/cursor-opencode-provider`) — dual packages are **not** published from this monorepo  
**Status:** **Build as part of final OPHP product** — TX escape hatch; ship in parallel with facades/adapters (not deferred)  
**Related:** `universal-opencode-plugin-compat-plan.md` (parent), `mimo-opencode-compat-layer-plan.md` (MiMo adapter)  
**Goal:** Maintain one Cursor-provider repo; publish **two npm packages** (OpenCode host + MiMoCode host); share Cursor protocol core; build/test (and optionally publish) both via GitHub Actions.

---

## 1. Background

### What this project is today
- Single package `cursor-opencode-provider` (~12k LOC).
- **AI SDK provider** (`LanguageModelV3`) that speaks Cursor’s Connect-RPC agent protocol.
- **OpenCode plugin** (classic Hooks + optional v2) for auth, model discovery, provider registration.
- Peer: `@opencode-ai/plugin`. Deps: `@ai-sdk/provider`, `protobufjs`.

### Why dual packages
- [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) is an OpenCode fork with:
  - Package rename: `@opencode-ai/*` → `@mimo-ai/*`
  - Config/data paths: `.mimocode` / XDG `mimocode` (not `.opencode`)
  - Classic plugin API retained; **no** `@mimo-ai/plugin/v2` export
  - Extra builtin agents (`compose`, `checkpoint-writer`, `dream`, `distill`, `max`, …)
- OpenCode plugins that hard-import `@opencode-ai/plugin` do not load on MiMo without adaptation.
- Most of this repo’s complexity is **Cursor-facing** (protocol/transport/LM), not host-facing. Dual packages are feasible without forking the protocol stack.

### Related decisions (from prior research)
- Prefer **two separate npm packages** (user preference), not one package with dual entrypoints.
- Prefer **one repo** + **GitHub Actions** to build both.
- Do **not** wait on Xiaomi re-exporting `@opencode-ai/plugin`.
- Do **not** duplicate `language-model` / protobuf stacks.

---

## 2. Target architecture

```
cursor-opencode-provider/          # repo (name may stay; packages rename below)
├── package.json                   # workspace root (private)
├── bun.lock / packageManager
├── .github/workflows/
│   ├── ci.yml                     # build + test both packages
│   └── publish.yml                # dual npm publish on tag (extend existing)
├── packages/
│   ├── core/                      # NEW — host-agnostic Cursor agent core
│   │   ├── package.json           # name TBD: e.g. @oakimov/cursor-agent-core (private or public)
│   │   └── src/
│   │       ├── index.ts           # createCursor, types
│   │       ├── language-model.ts
│   │       ├── session.ts
│   │       ├── auth.ts / models.ts / agent-url.ts / …
│   │       ├── protocol/
│   │       ├── transport/
│   │       └── host/              # AgentHost types + helpers (no @opencode/@mimo imports)
│   ├── cursor-opencode-provider/  # EXISTING package identity
│   │   ├── package.json           # peer: @opencode-ai/plugin
│   │   └── src/
│   │       ├── host.ts            # OpenCode AgentHost impl
│   │       ├── plugin.ts          # classic Hooks
│   │       ├── plugin-v2.ts       # OpenCode-only v2
│   │       └── index.ts           # re-export core + default CursorPlugin
│   └── cursor-mimocode-provider/  # NEW publishable package
│       ├── package.json           # peer: @mimo-ai/plugin
│       └── src/
│           ├── host.ts            # MiMo AgentHost impl
│           ├── plugin.ts          # classic Hooks only
│           └── index.ts
└── test/                          # shared or per-package; see §6
```

### Package responsibilities

| Package | Publishes? | Depends on | Responsibility |
|---------|------------|------------|----------------|
| `packages/core` | Optional (private workspace OK initially) | `@ai-sdk/provider`, `protobufjs` | Cursor protocol, LM, session, auth helpers, model cache I/O via injected paths |
| `cursor-opencode-provider` | Yes | `core` + peer `@opencode-ai/plugin` (+ types from `@opencode-ai/sdk` as today) | OpenCode paths, auth store, agent catalog, classic + v2 plugins, provider registration |
| `cursor-mimocode-provider` | Yes | `core` + peer `@mimo-ai/plugin` (+ `@mimo-ai/sdk` types) | MiMo paths, auth store, agent catalog, classic plugin only |

### AgentHost interface (core)

Keep this **small**. Core never imports `@opencode-ai/*` or `@mimo-ai/*`.

```ts
export type AgentHostId = "opencode" | "mimocode"

export type AgentHost = {
  id: AgentHostId
  /** XDG / home layout for config, data (auth.json), cache (models). */
  paths: {
    configDir: () => string
    dataDir: () => string
    cacheDir: () => string
    /** Project-local dirs to scan: [".opencode"] or [".mimocode"] (+ shared fallbacks if desired). */
    projectPluginDirs: string[]
    projectAgentDirs: string[]
    projectSkillDirs: string[]
  }
  /** Config basenames: opencode.json(c) vs mimocode.json(c). */
  configFiles: string[]
  /** Env keys for auth injection / home override. */
  env: {
    authContent?: string   // OPENCODE_AUTH_CONTENT vs MIMOCODE_*
    home?: string          // OPENCODE_HOME / MIMOCODE_HOME if used
  }
  agents: {
    /** Names the host advertises / allows for tool→agent mapping. */
    builtins: ReadonlySet<string>
    /** Map Cursor subagent protocol ids → host agent names. */
    mapCursorSubagent: (subagentType: string) => string
  }
}
```

Host packages construct `AgentHost` at plugin load and pass it into `createCursor` / language-model / context builders (constructor arg or explicit context — avoid hidden globals where tests need isolation).

### What moves into `core` vs stays in host packages

**→ `core` (host-agnostic)**  
- `protocol/**`, `transport/**`  
- `language-model.ts`, `session.ts`, shell-timeout (host-neutral parts)  
- Cursor auth PKCE / API key / refresh (`auth.ts`)  
- Model discovery / cache format (`models.ts`) — cache **directory** injected  
- `agent-url.ts`, framing, device-id, etc.  
- `AgentHost` **type** + shared defaults (e.g. `generalPurpose` → `general`)

**→ host packages**  
- Classic `plugin.ts` (and OpenCode `plugin-v2.ts`)  
- Path implementations (`~/.config/opencode` vs `mimocode`)  
- Auth store read paths / env names  
- Context discovery roots (`.opencode` vs `.mimocode`, config file names)  
- Builtin agent sets  
- Peer SDK type imports (`Hooks`, `PluginInput`, `Auth`, …)

---

## 3. OpenCode vs MiMo host deltas (checklist)

| Concern | OpenCode | MiMoCode |
|---------|----------|----------|
| Plugin peer | `@opencode-ai/plugin` | `@mimo-ai/plugin` |
| SDK types | `@opencode-ai/sdk` | `@mimo-ai/sdk` |
| Plugin v2 | `plugin/v2` via `@opencode-ai/plugin/v2/promise` | **Absent** — do not ship v2 entry |
| Project plugin dir | `.opencode/plugin(s)/` | `.mimocode/plugin(s)/` |
| Global config | `~/.config/opencode` | `~/.config/mimocode` |
| Global data / auth | `~/.local/share/opencode` | `~/.local/share/mimocode` (or `$MIMOCODE_HOME`) |
| Global cache | `~/.cache/opencode` | `~/.cache/mimocode` |
| Config files | `opencode.json` / `opencode.jsonc` | `mimocode.json` / `mimocode.jsonc` |
| CLI auth | `opencode auth login` | `mimo` auth equivalent |
| Builtin agents | `build`, `plan`, `general`, `explore`, `compaction`, … | Above + `compose`, `checkpoint-writer`, `dream`, `distill`, `max`, … |
| Install config snippet | `"plugin": ["cursor-opencode-provider"]` | `"plugin": ["cursor-mimocode-provider"]` under MiMo schema |

---

## 4. Final product workstreams (no phases)

**Total: ~3–6 engineer-days** for a usable dual-package monorepo with CI.  
(Hardening + dual live smoke may push toward the upper end.)

Build **all** of the following as the Cursor TX slice of the OPHP product (parallel with facades/adapters — not deferred):

| Workstream | Work | Estimate |
|------------|------|----------|
| **Scaffold (A)** | Private workspace `packages/*`; create `core`, `cursor-opencode-provider`, `cursor-mimocode-provider`; move `src/`; keep OpenCode package name/exports green; root `build`/`typecheck`/`test` | 1–2 days |
| **AgentHost (B)** | Introduce `AgentHost` in core; replace hardcoded `opencodeGlobal*Dir()`; thread into context/auth-store/model cache/plugin discovery; OpenCode parity; mocked-host path tests; **zero** `@opencode-ai`/`@mimo-ai` imports in core | ~1 day (overlaps A) |
| **MiMo package (C)** | `cursor-mimocode-provider` peer `@mimo-ai/plugin`; classic plugin only; MiMo paths/config/env/builtins; agent map tests; `.mimocode` install docs | 1–2 days |
| **CI / publish (D)** | `ci.yml` builds both packages + unit tests (+ optional `npm pack`); extend `publish.yml` for dual npm publish on tag (dry-run first) | 0.5–1 day |
| **Docs + smoke (E)** | Root + per-package READMEs; `AGENTS.md` diagram; manual smoke OpenCode + MiMo (auth + one stream) | 0.5–1 day |

**Exit bar:** Both packages build/test in CI; OpenCode consumers unchanged (same package name); MiMo classic install documented; live smoke once per host.

---

## 5. Versioning & publish strategy

**Recommendation (simple):**
- Lockstep version both public packages (e.g. `0.3.0` / `0.3.0`) from one tag: `v0.3.0`.
- `core` stays private workspace dependency (`"cursor-agent-core": "workspace:*"`) until there’s an external need to publish it.

**Alternatives:**
- Independent semver per host package (more flexible, more Actions complexity).
- Publish `core` as `@scope/cursor-agent-core` if other hosts appear later.

**npm names:**
- Keep: `cursor-opencode-provider`
- Add: `cursor-mimocode-provider` (clear, parallel naming)

**Breaking changes:** Prefer extract-core as **minor** if OpenCode public API unchanged; major only if exports/paths break consumers.

---

## 6. Testing strategy

| Layer | Location | Focus |
|-------|----------|--------|
| Protocol / transport / LM | `packages/core` or shared `test/` importing core | Existing Bun tests moved with minimal change |
| OpenCode host | `packages/cursor-opencode-provider` or tagged tests | Plugin hooks, paths, agent map |
| MiMo host | `packages/cursor-mimocode-provider` | Paths, agents, classic plugin shape |
| CI | Both packages | Typecheck + unit; no live Cursor account required in CI |

Preserve existing `test/*.test.ts` coverage when moving files; fix import paths only during scaffold.

Live Cursor credentials stay local/manual (never in CI secrets unless explicitly decided later).

---

## 7. GitHub Actions sketch

### `ci.yml` (conceptual)
```yaml
# on: pull_request, push to main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build        # core → opencode → mimocode
      - run: bun test
      - run: bun run typecheck
```

### `publish.yml` (conceptual extension)
```yaml
# on: push tags v*
jobs:
  publish:
    # permissions: id-token write if OIDC
    steps:
      - # install, build
      - run: npm publish --workspace cursor-opencode-provider --access public
      - run: npm publish --workspace cursor-mimocode-provider --access public
```

Exact npm vs bun publish CLI should match current `publish.yml` patterns in-repo.

---

## 8. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Import churn when extracting `core` | Broken OpenCode install mid-refactor | Land scaffold with OpenCode-only first; MiMo package empty stub until AgentHost + MiMo package workstreams |
| MiMo plugin types diverge from OpenCode Hooks | Compile errors / subtle auth bugs | Compare `@mimo-ai/plugin` Hooks before writing MiMo `plugin.ts`; keep classic-only |
| No MiMo v2 | Confusion if docs copy OpenCode v2 setup | Explicit “classic only” in MiMo README |
| Agent allowlist too strict on MiMo | Blocks compose/subagents | Host-specific `builtins`; default map only `generalPurpose`/`bugbot` |
| Context discovery misses `.mimocode` | Silent empty context | Host `project*Dirs` + tests |
| Dual publish partial failure | One package published, other not | Publish job fails closed; retry; consider `npm publish` sequential with rollback note |
| Workspace `core` not published | Consumers can’t deep-import core | OK initially; host packages bundle/reexport needed symbols |

---

## 9. Non-goals (this plan)

- Porting MiMo long-horizon features (checkpoints, `/goal`, workflows) into OpenCode.
- Automatic rewrite of arbitrary third-party OpenCode plugins.
- Runtime detection of host inside a **single** published package (explicitly rejected in favor of two packages).
- Deferring dual packages “until OPHP finishes first” — they ship in parallel as the TX path.

---

## 10. Success criteria

1. One git repo; two npm packages published (or packable) from CI.  
2. Shared Cursor core with **no** host SDK dependency.  
3. OpenCode consumers: no forced migration beyond normal semver (same package name).  
4. MiMo consumers: install `cursor-mimocode-provider`, configure `.mimocode`, classic plugin auth works.  
5. PR CI builds and tests both packages on every change.  
6. Tag pipeline can release both packages together.

---

## 11. Immediate next actions

1. Workspace + move code behind `packages/cursor-opencode-provider` still working.  
2. Extract `packages/core` + `AgentHost`; OpenCode host adapter.  
3. Add `packages/cursor-mimocode-provider`.  
4. CI matrix/build both.  
5. Docs + manual smoke both hosts.  
6. Extend publish workflow; first dual release.

---

## 12. Effort summary

| Workstream | Estimate |
|------------|----------|
| Scaffold + OpenCode green | 1–2 days |
| AgentHost extraction | ~1 day |
| MiMo package | 1–2 days |
| GitHub Actions | 0.5–1 day |
| Docs + smoke | 0.5–1 day |
| **Total** | **~3–6 days** |

**Feasibility:** High — architecture matches how the code is already layered; Actions dual-build/publish is routine once workspaces exist.