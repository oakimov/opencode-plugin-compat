# Phase 0 — Classic Hooks parity matrix

**Date:** 2026-07-19  
**Status:** Research / discovery artifact (evidence for OPHP product)  
**Repo:** `opencode-plugin-compat` (`docs/plans/`)  
**Sources (pinned):**
| Host | Plugin package | Version / pin | Source |
|------|----------------|---------------|--------|
| OpenCode | `@opencode-ai/plugin` | **1.18.3** (npm) + local `opencode-research` `dev` | npm pack + `/Users/mitra/Projects/opencode-research` |
| MiMo | `@mimo-ai/plugin` | **0.1.6** (npm) + GitHub `main` `packages/plugin/src/index.ts` | npm pack + raw GitHub |
| Kilo | `@kilocode/plugin` | **7.4.11** (npm); fork pin `.opencode-version` = **v1.17.4** | npm pack + `/tmp/kilocode-spike` |
| ZCode | *(no `@*-plugin` OpenCode ABI)* | Desktop **3.3.6** | DMG/`app.asar` exam — marketplace only |

Related: `universal-opencode-plugin-compat-plan.md`, `ophp-0.1-spec.md`, `phase0-adr-universal-compat.md`.

---

## 1. Executive finding

| Comparison | Result |
|------------|--------|
| **OpenCode 1.18.3 ↔ Kilo 7.4.11 classic `Hooks` keys** | **Identical** (21 hooks). Normalized `index.d.ts` differs only by SDK import / `create*Client` name. |
| **OpenCode 1.18.3 ↔ MiMo 0.1.6 classic `Hooks`** | **Near-superset conflict.** MiMo **adds 6** host-specific hooks; MiMo **lacks 2** OpenCode hooks. |
| **v2 exports** | OpenCode: yes (`./v2/promise`, `./v2/effect`, …). MiMo/Kilo published exports: **classic only** (`.`, `./tool`, `./tui`). |
| **ZCode** | **Not an OPHP host.** Marketplace ABI (`.zcode-plugin/plugin.json`, Claude-style hooks). Public examples: `tmdgusya/glm-hammer`, marketplace `jhlee0409/zcode-glm-fleet`. See `oa-tools/zcode-review/ZCODE_RESEARCH.md` §7. |

**Implication for OPHP 0.1:** Classic facade can treat **OpenCode ∩ Kilo** as the portable core. MiMo extras are **host-extension hooks** (optional, never required for T1). Missing MiMo hooks must be documented as **compat gaps** (no-op or polyfill policy).

---

## 2. Package surface matrix

| Surface | OpenCode 1.18.3 | MiMo 0.1.6 | Kilo 7.4.11 | ZCode 3.3.6 |
|---------|-----------------|------------|-------------|-------------|
| Export `.` | ✅ | ✅ | ✅ | ❌ N/A |
| Export `./tool` | ✅ | ✅ | ✅ | ❌ |
| Export `./tui` | ✅ | ✅ | ✅ | ❌ |
| Export `./v2/promise` | ✅ | ❌ | ❌ | ❌ |
| Export `./v2/effect` | ✅ | ❌ | ❌ | ❌ |
| Native plugin pkg | `@opencode-ai/plugin` | `@mimo-ai/plugin` | `@kilocode/plugin` | marketplace manifests |
| Native SDK pkg | `@opencode-ai/sdk` | `@mimo-ai/sdk` | `@kilocode/sdk` | `@zcode/*` internals |
| Client factory in `PluginInput` | `createOpencodeClient` | `createOpencodeClient` *(residual name on `@mimo-ai/sdk`)* | `createKiloClient` | — |
| `@ai-sdk/provider` on plugin pkg | ✅ (v2) | ❌ | ❌ | — |
| `effect` dep on plugin pkg | ✅ beta.83 | ✅ beta.48 | ✅ beta.74 | — |

**Note:** MiMo still types `PluginInput.client` as `ReturnType<typeof createOpencodeClient>` imported from `@mimo-ai/sdk`. That residual naming **helps** aliasing mental model but must not be confused with the real `@opencode-ai/sdk` package.

---

## 3. Classic `Hooks` key matrix

Legend: **Y** = present on published types · **-** = absent · **Ext** = host extension (not portable)

| Hook | OpenCode | Kilo | MiMo | OPHP 0.1 portable? | Notes |
|------|----------|------|------|--------------------|-------|
| `dispose` | Y | Y | **-** | **Core (gap on MiMo)** | Facade should accept; MiMo adapter may no-op with doctor warning |
| `event` | Y | Y | Y | Core | |
| `config` | Y | Y | Y | Core | |
| `tool` | Y | Y | Y | Core | |
| `auth` | Y | Y | Y | Core | High-value for auth plugins |
| `provider` | Y | Y | Y | Core | |
| `chat.message` | Y | Y | Y | Core | |
| `chat.params` | Y | Y | Y | Core | |
| `chat.headers` | Y | Y | Y | Core | |
| `permission.ask` | Y | Y | Y | Core | |
| `command.execute.before` | Y | Y | Y | Core | |
| `tool.execute.before` | Y | Y | Y | Core | |
| `tool.execute.after` | Y | Y | Y | Core | |
| `shell.env` | Y | Y | Y | Core | |
| `tool.definition` | Y | Y | Y | Core | |
| `experimental.chat.messages.transform` | Y | Y | Y | Core (experimental) | |
| `experimental.chat.system.transform` | Y | Y | Y | Core (experimental) | |
| `experimental.provider.small_model` | Y | Y | **-** | **Core (gap on MiMo)** | |
| `experimental.session.compacting` | Y | Y | Y | Core (experimental) | |
| `experimental.compaction.autocontinue` | Y | Y | Y | Core (experimental) | |
| `experimental.text.complete` | Y | Y | Y | Core (experimental) | |
| `actor.preStop` | - | - | Y | **Ext (MiMo)** | Trajectory / actor harness |
| `actor.postStop` | - | - | Y | **Ext (MiMo)** | |
| `session.pre` | - | - | Y | **Ext (MiMo)** | Includes `trajectory: TrajectoryMessage[]` |
| `session.post` | - | - | Y | **Ext (MiMo)** | |
| `session.userQuery.pre` | - | - | Y | **Ext (MiMo)** | |
| `session.userQuery.post` | - | - | Y | **Ext (MiMo)** | |

### Signature drift (spot-check)

For the **shared 19 hooks**, published `Hooks` method shapes on OpenCode / Kilo / MiMo appear aligned (same input/output field names in `.d.ts`). Deep runtime drift (when host *invokes* hooks, part schemas, SDK `Event` unions) is **out of this research static diff** — the shipped OPHP conformance suite must cover invocation.

MiMo extension hooks pull in MiMo-only types (`ActorPreStopRegistration`, `TrajectoryMessage`, …). OPHP must **not** require these for portable plugins.

---

## 4. Path / env / install matrix (HostProfile inputs)

| Item | OpenCode | MiMo | Kilo | ZCode |
|------|----------|------|------|-------|
| Env prefix | `OPENCODE_*` | `MIMOCODE_*` | `KILO_*` | `ZCODE_*` |
| XDG app / home | `opencode` | `mimocode` (+ `MIMOCODE_HOME` absolute root mode) | `kilo` | `~/.zcode` (`ZCODE_HOME`) |
| Config dir | `~/.config/opencode` (`OPENCODE_CONFIG_DIR`) | `~/.config/mimocode` or `$MIMOCODE_HOME/config` | `~/.config/kilo` (`KILO_CONFIG_DIR`) | `~/.zcode/v2/setting.json` etc. |
| Cache / npm plugins | `~/.cache/opencode` (packages under cache) | `~/.cache/mimocode` or `$MIMOCODE_HOME/cache` | `~/.cache/kilo/packages/<pkg>` | marketplace, not OC npm cache |
| Project dirs scanned | `.opencode` | `.mimocode` **only** (docs mention `.opencode` — bug #1151) | `.kilo`, `.kilocode` **only** (deliberately dropped `.opencode`) | not OC plugin dirs |
| Compat dual-scan `.opencode` | native | **needs M1 PR** | **needs M1 PR** | N/A |
| Config basenames | `opencode.json(c)` | `mimocode.json(c)` | `kilo.json(c)`, also merges leftover global `opencode.json(c)` in kilo config dir | ZCode settings / marketplace |
| `scansDotOpencode` | true | false today | false today | false |

---

## 5. Plugin inventory sample (classic vs v2)

Static import scan of npm tarballs (2026-07-19). Not exhaustive; enough to size OPHP MVP.

| Package | Tier (static) | Notes |
|---------|---------------|-------|
| `opencode-gitlab-auth@2.1.0` | classic | auth hook pattern |
| `opencode-poe-auth@0.0.4` | classic | |
| `opencode-copilot-auth@0.0.12` | classic | |
| `opencode-anthropic-auth@0.0.13` | classic | |
| `opencode-openai-codex-auth@4.4.0` | classic | also `@opencode-ai/sdk` |
| `opencode-models-discovery@1.0.2` | classic | |
| `opencode-subagent-statusline@1.2.1` | classic | + `./tui` |
| `oh-my-opencode@4.19.0` | classic | tool/tui; **host-path sensitive** (TX risk) |
| `@caplets/opencode@0.8.20` | classic | |
| `litopencode@0.1.50` | classic | |
| `@tarquinen/opencode-dcp@3.1.14` | classic+v2 | uses `@opencode-ai/sdk/v2` |
| `oh-my-opencode-slim@2.2.4` | classic+v2 | |
| `@cortexkit/opencode-magic-context@0.32.3` | classic+v2 | |
| **`cursor-opencode-provider` (local)** | **classic+v2** | `@opencode-ai/plugin` + `/v2/promise` + sdk — **TX / dual-package** candidate |
| `orca-opencode-plugin@1.2.8` | unclear | no direct `@opencode-ai/plugin` import in pack |
| `@webpresso/opencode-plugin@3.1.22` | unclear | adapter wrapper |

**Rough mix:** majority of sampled plugins are **classic-only** → T1 unlocks the most plugins first. A meaningful minority (incl. this Cursor provider) need **T3 Promise v2 aisdk** (or TX dual packages).

---

## 6. Conformance implications (prep only)

1. **Core suite (T1):** exercise the 19 shared hooks + document MiMo gaps for `dispose` / `experimental.provider.small_model`.  
2. **Extension suite (MiMo-only):** optional; never block portable plugins.  
3. **Alias suite:** resolve `@opencode-ai/plugin` → facade → `@mimo-ai/plugin` / `@kilocode/plugin`.  
4. **Negative suite:** importing `@opencode-ai/plugin/v2/promise` on MiMo/Kilo without host kit → loud error.  
5. **ZCode doctor:** any OPHP probe on ZCode → T0 message (marketplace ≠ OPHP).

---

## 7. Evidence pointers

- OpenCode Hooks: `opencode-research/packages/plugin/src/index.ts`; npm `@opencode-ai/plugin@1.18.3` `dist/index.d.ts`  
- MiMo Hooks: npm `@mimo-ai/plugin@0.1.6` `dist/index.d.ts`; GitHub `XiaomiMiMo/MiMo-Code` `packages/plugin/src/index.ts`  
- Kilo Hooks: npm `@kilocode/plugin@7.4.11` `dist/index.d.ts`; spike `/tmp/kilocode-spike/packages/plugin/src/index.ts`  
- MiMo paths: `packages/shared/src/global.ts` (`APP = "mimocode"`, `MIMOCODE_HOME`); `packages/opencode/src/config/paths.ts` (`.mimocode` only)  
- Kilo paths: spike `packages/core/src/global.ts`, `packages/opencode/src/config/paths.ts`  
- Artifact workspace used for packs: `/tmp/ophp-phase0/`