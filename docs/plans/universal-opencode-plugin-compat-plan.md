# Plan: Universal OpenCode plugin compatibility across forks

**Date:** 2026-07-19  
**Status:** **Build the final product** — no phased MVP rollout; ship the complete OPHP stack  
**Repo:** [oakimov/opencode-plugin-compat](https://github.com/oakimov/opencode-plugin-compat)  
**Docs location:** `docs/plans/` (canonical OPHP contract: `docs/ophp/0.1.md`)  
**Related plans:**
- `mimo-opencode-compat-layer-plan.md` — MiMo M1 integration detail; MiMo is an **equal** `HostProfile` target, not a separate adapter package
- `dual-host-packages-plan.md` — **Superseded** historical dual-package sketch (out of scope)
- `phase0-hooks-parity.md` — Research evidence: Hooks / path / plugin inventory  
- `ophp-0.1-spec.md` / `../ophp/0.1.md` — OPHP 0.1 product specification  
- `phase0-adr-universal-compat.md` — Product ADR + deliverables  

**Goal:** Ship a **complete** universal compatibility **bridge** so **published OpenCode plugins** (`import "@opencode-ai/plugin"` / `v2/promise`) run **unchanged** on cooperating OpenCode forks (**MiMo Code**, **Kilo Code**), with **ZCode** honestly at T0. Do **not** create host-specific forks of consumer plugins (no `cursor-mimocode-provider` / Kilo / ZCode variants).

---

## 1. Research summary (fork landscape)

### 1.1 OpenCode (upstream) — the ABI source of truth

| Item | Value |
|------|--------|
| Org / repo | anomalyco/opencode |
| Plugin SDK | `@opencode-ai/plugin` — `.`, `./tool`, `./tui`, `./v2/promise`, `./v2/effect` |
| SDK | `@opencode-ai/sdk` (+ `/v2`) |
| Project dirs | `.opencode/` |
| XDG | `~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode` |
| Config | `opencode.json` / `opencode.jsonc` |
| Env prefix | `OPENCODE_*` |
| v2 host | Effect-first in `packages/core/src/plugin/*`; Promise via `fromPromise` |

Plugins assume this ABI + host wiring.

---

### 1.2 MiMo Code (Xiaomi)

| Item | Value |
|------|--------|
| Repo | XiaomiMiMo/MiMo-Code |
| Relationship | Declared OpenCode fork; long-horizon harness additions |
| Plugin SDK | `@mimo-ai/plugin` — **only** `.`, `./tool`, `./tui` (**no v2 exports**); classic Hooks ≈ OpenCode but **+actor/session**, **-dispose/small_model** (see `phase0-hooks-parity.md`) |
| SDK | `@mimo-ai/sdk` |
| Project dirs | `.mimocode/` (`.opencode/` not scanned — docs bug #1151) |
| XDG | `mimocode` / `MIMOCODE_HOME` |
| Config | `mimocode.json(c)` |
| Env | `MIMOCODE_*` |
| Openness | MIT + use restrictions; source available |

**Breakage for OpenCode plugins:** package rename, paths, missing v2 host/exports, env/XDG.

---

### 1.3 Kilo Code / Kilo CLI — **verified 2026-07-19** (source: `Kilo-Org/kilocode` tip, pin `.opencode-version` = **v1.17.4**)

| Item | Value |
|------|--------|
| Repo | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) |
| Relationship | Declared OpenCode fork; pin file `.opencode-version` = **v1.17.4** |
| CLI npm | `@kilocode/cli` / bins `kilo`, `kilocode` (**7.4.11** on npm at check time) |
| Plugin SDK | `@kilocode/plugin` **7.4.11** — exports **only** `.`, `./tool`, `./tui` (**no `./v2/*`**) |
| SDK | `@kilocode/sdk` |
| Residual OpenCode deps | Internal packages still import `@opencode-ai/core/*` in places; external auth plugins cast from `@opencode-ai/plugin` types → `@kilocode/plugin` |
| XDG app name | **`kilo`** (`packages/core/src/global.ts`) → `~/.config/kilo`, `~/.local/share/kilo`, `~/.cache/kilo`, `~/.local/state/kilo`, tmp `…/kilo` |
| Config override | `KILO_CONFIG_DIR` replaces global config dir; also `KILO_CONFIG`, `KILO_CONFIG_CONTENT` |
| Env prefix | **`KILO_*`** (confirmed: `KILO_CONFIG`, `KILO_CONFIG_DIR`, `KILO_DISABLE_PROJECT_CONFIG`, `KILO_DISABLE_DEFAULT_PLUGINS`, `KILO_PLUGIN_META_FILE`, …) — **not** `OPENCODE_*` |
| Project dirs | **`.kilo`** (current) + **`.kilocode`** (legacy). **`.opencode` project dirs are NOT loaded** (CHANGELOG #11638 / #12034; system prompt: “Do not use `.kilocode/` or `.opencode/`”) |
| Global config basenames (precedence / merge) | `~/.config/kilo/config.json`, `kilo.json(c)`, and still merges leftover **`opencode.json(c)`** in the **global** kilo config dir |
| Project config | `kilo.json` / `kilo.jsonc` under `.kilo` / `.kilocode`; schema `https://app.kilo.ai/config.json` |
| Plugin install cache | npm packages land under **`~/.cache/kilo/packages/<sanitized-pkg>`** (`Npm.add` → `Global.cache/packages`) |
| Local plugin install root | writable `.kilo` (or legacy `.kilocode` / `KILO_CONFIG_DIR`); installer also ensures `@kilocode/plugin` in that tree |
| Platform extras | VS Code extension, JetBrains, gateway, memory, telemetry — larger than CLI-only |
| Openness | MIT; source available |

**Breakage for OpenCode plugins:**
1. Package rename `@opencode-ai/*` → `@kilocode/*`  
2. No plugin v2 exports / host  
3. Project path rename; **no dual-scan of `.opencode`** (harder than MiMo’s docs bug — Kilo deliberately stopped fallback)  
4. Env/XDG `OPENCODE_*` / `opencode` → `KILO_*` / `kilo`  
5. Plugins that hardcode OpenCode config/model paths misbehave (community: oh-my-openagent)

**Nuance vs MiMo:** Kilo’s tree is closer to modern OpenCode (`core`/`llm`/plugin loader with `server()`/`tui()` + classic hooks). Still **classic-only** on the published `@kilocode/plugin` surface. `engines.opencode` remains the plugin engine key in compatibility checks.

---

### 1.4 ZCode (Z.AI / Zhipu) — **verified 2026-07-19** from [ZCode-3.3.6-mac-arm64.dmg](https://cdn-zcode.z.ai/zcode/electron/releases/3.3.6/macos-arm64/ZCode-3.3.6-mac-arm64.dmg)

| Item | Value |
|------|--------|
| Artifact | `ZCode.app` 3.3.6 arm64; bundle id **`dev.zcode.app`**; product `@zcode/desktop`; homepage **`https://zcode.z.ai`** |
| Relationship | Closed Electron desktop built from OpenCode-**architecture** lineage (`@zcode/{desktop,client,server,services,shared,ui,rpc}`, electron-vite, Effect/Hono markers historically) |
| Frontend | Custom React 19 desktop UI (not OpenCode TUI) |
| OpenCode npm plugin ABI | **Absent.** No `@opencode-ai/*` packages, no `OPENCODE_*` env, no `v2/promise` / `v2/effect` strings in main/host bundles |
| “OpenCode” in product | **External agent CLI provider** only — enum alongside `claude` / `gemini` / `codex` / `glm`. Native config map points OpenCode at **`~/.config/opencode` + `opencode.json`** for *importing that CLI’s settings*, not for loading `@opencode-ai/plugin` |
| ZCode’s own plugins | **First-party marketplace plugin system** (RPC: `plugins/install`, `plugins/uninstall`, `plugins/marketplace/*`, `plugins/restoreBuiltin`, …). Manifests: **`.zcode-plugin/plugin.json`**, also recognizes **`.claude-plugin/plugin.json`** / **`.codex-plugin/...`**. Components resemble Claude-style roots (`skills`, `commands`, `hooks`, `agents`, `templates`). Official bundled plugins e.g. `document-skills-plugin`, `skill-creator-plugin`, `zcode-guide-plugin`, … |
| Home / data | `ZCODE_HOME` default **`$HOME/.zcode`**; settings under **`~/.zcode/v2/setting.json`**; CLI config **`~/.zcode/cli/config.json`**; desktop userData via `ZCODE_DESKTOP_*` / appData/`ZCode` |
| Env prefix | **`ZCODE_*`** (large surface: `ZCODE_HOME`, `ZCODE_DATA_BASE_DIR`, agent spawn envs, CUA helper, telemetry, …) |
| Telemetry | Still always-on class (ARMS + product telemetry paths; see [oa-tools/zcode-review](https://github.com/oakimov/oa-tools/tree/main/zcode-review); 3.3.6 still has `telemetry-state` under `.zcode/v2`) |
| Openness | **Closed binary** — no published OpenCode-plugin install hook to patch from outside |

**Telemetry endpoints (3.3.6 `out/main`, verified 2026-07-19):**
- ARMS RUM (hardcoded hostname URL): `https://proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com/rum/web/v2?...` via `RF.init({enable:!0, endpoint:…})`
- Product events (default): `https://zcode.z.ai/api/v1/event/report` — may rewrite onto a custom ZCode endpoint origin when `ZCODE_BASE_URL` / endpoint override is set
- **No reverse-DNS / PTR / IP-literal telemetry fallback** in main bundles or `@arms/rum-electron` (searched `dns.reverse`, `in-addr.arpa`, `lookupService`, hardcoded public telemetry IPs). Only unrelated literal found: `http://192.168.6.166:8080` (ZAPI catalog stub). Hostname DNS sinkhole / host firewall is therefore an effective mitigation class — **not** an OPHP plugin feature.

**Implication (final):** ZCode is **not** an OpenCode-plugin host. It is:
1. A **desktop agent orchestrator** that can spawn OpenCode (and others) as subprocess agents, and  
2. A **separate plugin marketplace** (Claude-/Codex-adjacent layout + `.zcode-plugin`), not OPHP.

**Public ecosystem confirmation (2026-07-19):** real third-party plugins/marketplaces exist (`tmdgusya/glm-hammer`, `jhlee0409/zcode-glm-fleet`, …). They implement `.zcode-plugin/plugin.json` + Claude-style hook events — zero `@opencode-ai/plugin`. Full ABI notes in [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md) §7.

Universal OPHP **cannot** target ZCode without Z.AI adding an explicit OpenCode-plugin loader (unlikely while Agent-mode marketplace is the product path). Keep ZCode at **T0** with an honest adapter stub / docs only. Companion privacy guidance (firewall/DNS) is **out-of-band** from the bridge runtime — see §7.1.

---

### 1.5 Divergence dimensions (what any universal layer must abstract)

| Dimension | OpenCode | MiMo | Kilo | ZCode 3.3.6 |
|-----------|----------|------|------|-------------|
| npm / plugin scope | `@opencode-ai/plugin` | `@mimo-ai/plugin` | `@kilocode/plugin` | **N/A** (marketplace `.zcode-plugin`, not npm OC ABI) |
| v2 exports + host | yes | no | no | **no** (not present) |
| Project plugin dir | `.opencode` | `.mimocode` | `.kilo` (+ legacy `.kilocode`); **no `.opencode` scan** | workspace `.zcode` / marketplace installs |
| Config basename | `opencode.json(c)` | `mimocode.json(c)` | `kilo.json(c)` + global `config.json` (+ leftover global `opencode.json(c)`) | `~/.zcode/v2/setting.json` |
| XDG / home profile | `opencode` | `mimocode` | **`kilo`** | **`ZCODE_HOME` → `~/.zcode`** (not XDG app name) |
| Env prefix | `OPENCODE_` | `MIMOCODE_` | **`KILO_`** | **`ZCODE_`** |
| Upstream pin | tip | older OpenCode-shaped | **v1.17.4** pin file | opaque closed bundle **3.3.6** |
| Distribution | open CLI | open CLI | open CLI + IDEs | closed Electron |
| Role of “OpenCode” | self | renamed fork | renamed fork | **external CLI agent** only |

**Pattern:** open CLI forks repeatedly apply the same rename playbook (scope, paths, config, env) and lag/drop plugin v2. Closed ZCode diverged into a **different plugin product** plus multi-agent spawning.

---

## 2. Problem with “per-fork compat layers”

Building MiMo-only + Kilo-only + ZCode-only shims:

- Multiplies maintenance by fork count.  
- Each fork re-implements alias + path scan + partial v2.  
- Plugins still break when the next fork appears.  
- No shared **compatibility contract** or test matrix.

A **universal** approach needs a **shared ABI + host profile**, with **thin fork adapters**.

---

## 3. Design: OpenCode Plugin Host Profile (OPHP)

### 3.1 Core idea

Define an explicit, versioned **OpenCode Plugin Host Profile**:

1. **Stable plugin author ABI** — what plugins import (`@opencode-ai/plugin` classic + `v2/promise`).  
2. **Host capability interface** — what a runtime must implement to claim “OpenCode-plugin compatible.”  
3. **Fork adapter pack** — maps profile → MiMo / Kilo / OpenCode / (future) native packages & paths.  
4. **Install-time resolution** — ensure `@opencode-ai/*` imports resolve to the **profile facade**, which delegates to the fork’s native SDK.

```
┌──────────────────────────┐
│  Unchanged OpenCode plugin│
│  @opencode-ai/plugin(+v2) │
└────────────┬─────────────┘
             │ resolve (alias / facade package)
┌────────────▼─────────────┐
│  opencode-plugin-compat   │  ← universal facade (this project)
│  (implements OPHP)        │
│  detect host → adapter    │
└────────────┬─────────────┘
     ┌───────┼────────┬────────────┐
     ▼       ▼        ▼            ▼
  OpenCode  MiMo    Kilo     (ZCode adapter stub)
  native    native  native   if/when loader exists
```

### 3.2 Two delivery models (choose explicitly)

| Model | How it ships | Pros | Cons |
|-------|--------------|------|------|
| **M1 — In-fork integration** | Each fork vendors/calls `opencode-plugin-compat` in install/loader | Reliable; correct place for path scan & v2 host hooks | Needs PR/cooperation per fork |
| **M2 — Sidecar / user overlay** | User installs a wrapper CLI or patches plugin cache overrides manually | No upstream required | Fragile; can’t add v2 **host** wiring without fork hooks |

**Recommendation:** Design the **library + profile** for **M1**; provide **M2 overlays** only for Layer A (module alias) as a stopgap. v2 host **requires M1**.

ZCode only works under M1 with vendor cooperation.

---

## 4. Universal package architecture

### 4.1 Proposed packages (new repo or monorepo)

| Package | Purpose |
|---------|---------|
| `@opencode-compat/profile` | Types: `HostProfile`, capability flags, path/env schema, OPHP semver, **`detect()`** |
| `@opencode-compat/facade-plugin` | Published **as drop-in stand-in** used via install overrides named `@opencode-ai/plugin` *inside fork caches* (or re-exports) |
| `@opencode-compat/facade-sdk` | Same for `@opencode-ai/sdk` |
| `@opencode-compat/adapter` | **One** universal host adapter — **autodetects** host, dispatches via `HostProfile` to native `@opencode-ai/*` / `@mimo-ai/*` / `@kilocode/*`; `zcode` → T0 doctor |
| `@opencode-compat/host-promise-v2` | Shared **Promise v2 host kit** (aisdk required) forks embed |
| `@opencode-compat/cli` | Dev tool: `compat doctor`, matrix runner, generate fork overrides |

**Rejected:** separate `@opencode-compat/adapter-{opencode,mimo,kilo,zcode}` packages. Host variance is profile data + internal dispatch in the single adapter.

**Important npm constraint:** You cannot publish the real `@opencode-ai/*` scope without anomalyco. Universal layer uses:

- **Fork install overrides:** `"@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@…"` inside the fork’s plugin install directory, **or**
- Forks depend on facade and set Bun/Node import maps / aliases at runtime.

### 4.2 HostProfile (sketch)

```ts
type HostId = "opencode" | "mimo" | "kilo" | "zcode" | "unknown"

type HostProfile = {
  id: HostId
  /** Semver of OPHP implemented by this adapter */
  ophpVersion: string
  /** Fork’s native plugin package name to peer on */
  nativePlugin: string        // @opencode-ai/plugin | @mimo-ai/plugin | @kilocode/plugin
  nativeSdk: string
  upstreamPin?: string        // e.g. kilo ".opencode-version" = v1.17.4
  paths: {
    configDir: string         // ~/.config/{opencode|mimocode|kilo}
    dataDir: string
    cacheDir: string          // kilo npm plugins: ~/.cache/kilo/packages/*
    projectDirs: string[]     // kilo: [".kilo", ".kilocode"] — do NOT assume ".opencode" is scanned
    /** Compat suggestion hosts should add via M1 PR */
    compatProjectDirs?: string[]  // e.g. [".opencode"] for kilo/mimo
  }
  configFiles: string[]       // basenames, precedence order
  envPrefix: string           // OPENCODE | MIMOCODE | KILO | ZCODE (zcode = non-OPHP)
  capabilities: {
    classicHooks: boolean
    promiseV2: boolean        // exports + host
    effectV2: boolean
    aisdkProviderHooks: boolean
    localPluginScan: boolean
    scansDotOpencode: boolean // kilo today: false
  }
  agents?: { builtins: string[]; aliases?: Record<string, string> }
}

/** Concrete verified drafts (research — not shipped code) */
const OPENCODE_PROFILE_DRAFT = {
  id: "opencode",
  ophpVersion: "0.1.0",
  nativePlugin: "@opencode-ai/plugin",
  nativeSdk: "@opencode-ai/sdk",
  pluginVersionObserved: "1.18.3",
  paths: {
    configDir: "~/.config/opencode",
    dataDir: "~/.local/share/opencode",
    cacheDir: "~/.cache/opencode",
    projectDirs: [".opencode"],
  },
  configFiles: ["opencode.json", "opencode.jsonc"],
  envPrefix: "OPENCODE",
  capabilities: {
    classicHooks: true,
    promiseV2: true,
    effectV2: true,
    aisdkProviderHooks: true,
    localPluginScan: true,
    scansDotOpencode: true,
  },
  hooks: {
    core: "/* 21 keys — see phase0-hooks-parity.md */",
    missing: [],
    extensions: [],
  },
} as const

const MIMO_PROFILE_DRAFT = {
  id: "mimo",
  ophpVersion: "0.1.0", // target after M1 — not current
  nativePlugin: "@mimo-ai/plugin",
  nativeSdk: "@mimo-ai/sdk",
  pluginVersionObserved: "0.1.6",
  paths: {
    configDir: "~/.config/mimocode", // or $MIMOCODE_HOME/config
    dataDir: "~/.local/share/mimocode",
    cacheDir: "~/.cache/mimocode",
    projectDirs: [".mimocode"],
    compatProjectDirs: [".opencode"], // needs M1 PR (#1151 behavior fix)
  },
  configFiles: ["mimocode.json", "mimocode.jsonc"],
  envPrefix: "MIMOCODE",
  capabilities: {
    classicHooks: true,
    promiseV2: false, // no published exports; host kit required for T3
    effectV2: false,
    aisdkProviderHooks: false,
    localPluginScan: true,
    scansDotOpencode: false,
  },
  hooks: {
    missing: ["dispose", "experimental.provider.small_model"],
    extensions: [
      "actor.preStop",
      "actor.postStop",
      "session.pre",
      "session.post",
      "session.userQuery.pre",
      "session.userQuery.post",
    ],
  },
  note: "PluginInput still types createOpencodeClient from @mimo-ai/sdk (residual name)",
} as const

const KILO_PROFILE_DRAFT = {
  id: "kilo",
  ophpVersion: "0.1.0", // target after M1 — not current
  nativePlugin: "@kilocode/plugin",
  nativeSdk: "@kilocode/sdk",
  pluginVersionObserved: "7.4.11",
  upstreamPin: "v1.17.4",
  paths: {
    configDir: "~/.config/kilo",
    dataDir: "~/.local/share/kilo",
    cacheDir: "~/.cache/kilo",
    pluginInstallDir: "~/.cache/kilo/packages",
    projectDirs: [".kilo", ".kilocode"],
    compatProjectDirs: [".opencode"], // requires upstream PR — not current behavior
  },
  configFiles: ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"],
  envPrefix: "KILO",
  capabilities: {
    classicHooks: true, // Hooks keys identical to OpenCode 1.18.3
    promiseV2: false,
    effectV2: false,
    aisdkProviderHooks: false,
    localPluginScan: true,
    scansDotOpencode: false,
  },
  hooks: { missing: [], extensions: [] },
} as const

const ZCODE_PROFILE_DRAFT = {
  id: "zcode",
  nativePlugin: "(marketplace .zcode-plugin — not @opencode-ai/plugin)",
  ophpVersion: "none",
  paths: {
    home: "${ZCODE_HOME:-$HOME/.zcode}",
    settings: "~/.zcode/v2/setting.json",
    cliConfig: "~/.zcode/cli/config.json",
  },
  envPrefix: "ZCODE",
  capabilities: {
    classicHooks: false,
    promiseV2: false,
    effectV2: false,
    aisdkProviderHooks: false,
    localPluginScan: false, // OpenCode ABI
    marketplacePlugins: true, // different ABI
    externalOpencodeAgent: true,
  },
} as const
```

Detection order (runtime):
1. Explicit `OPENCODE_COMPAT_HOST=mimo|kilo|opencode`  
2. Presence of native packages / binary names (`mimo`, `kilo`, `opencode`)  
3. Config dir heuristics (`~/.config/kilo` vs `mimocode` vs `opencode`)  
4. `zcode` → refuse OPHP with doctor message (marketplace ≠ OpenCode plugins)  
5. `unknown` → fail with doctor message  

---

## 5. Compatibility layers (universal)

Same stack as MiMo plan, generalized:

### Layer A — Module identity (all open forks)
Install-time overrides so plugin code importing `@opencode-ai/plugin` / `sdk` / `v2/*` resolves to facade → adapter → native.

### Layer B — Path & config federation
Each adapter declares `projectDirs` + `configFiles`. Hosts **should** scan OpenCode dirs as fallback **plus** native dirs (documented precedence: native wins).

Suggested default scan for maximum plugin reuse (requires **M1 host PRs** — Kilo currently refuses `.opencode`):
1. Native project dir (`.mimocode` / `.kilo` / …)  
2. `.opencode` (compat)  

### Layer C — Env / XDG bridge (opt-in)
`OPENCODE_COMPAT_PATH_BRIDGE=1`: map missing `OPENCODE_*` to host prefix; **do not** dual-write secrets by default.

### Layer D — Classic Hooks facade
Facade re-exports classic Hooks types and runtime registration by delegating to native plugin SDK. Maintain a **Hooks parity table** across OpenCode tip × MiMo × Kilo pin.

### Layer E — Promise v2 (shared host kit)
**This is the hard universal piece.**

Forks currently lack v2 exports (MiMo, Kilo). Options:

| Approach | Description |
|----------|-------------|
| **E-univ** | Ship `@opencode-compat/host-promise-v2` implementing `define` + `PluginContext` + **aisdk** hook bus; each fork **calls into it** at provider-resolve time |
| **E-port** | Each fork cherry-picks OpenCode `core` Effect host (Kilo closer; MiMo harder) |
| **E-stub** | Export v2 that throws “host incomplete” |

**Product = E-univ with aisdk required**, embedded by cooperating forks. Catalog/agent/… domains ship as part of the same host kit with **loud stubs** until a domain is fully wired (no “ship T1 now, T4 later” product split — one release trains the full surface; incomplete domains fail loud).

Effect v2 (`./v2/effect`): ship export + clear unsupported error unless a fork already has Effect host parity; do not gate the product on Effect completeness.

### Layer F — Conformance suite
`@opencode-compat/cli` runs fixtures against each adapter:

- Classic auth/config/tool hooks  
- Promise v2 aisdk injection  
- Local `.opencode/plugins` scan  
- Negative: unsupported domain errors  

Publish public **compat matrix**: Plugin × Host × OPHP tier × last pass.

---

## 6. Compatibility tiers (universal)

| Tier | Meaning | Hosts in scope |
|------|---------|----------------|
| **T0** | Broken / unsupported | ZCode today; unknown forks |
| **T1** | Classic npm plugins via alias | OpenCode, MiMo, Kilo (with M1) |
| **T2** | Local `.opencode` plugins | Same |
| **T3** | Promise v2 + `aisdk` | Forks that embed host kit |
| **T4** | Promise v2 domains (catalog/agent/…) | Progressive |
| **T5** | Effect v2 | Opt-in / upstream-aligned forks |
| **TX** | Host-aware plugins (hardcoded XDG) | Close in bridge / document residual limits — **not** per-host plugin forks |

---

## 7. ZCode-specific strategy (post 3.3.6 exam + public plugin repos)

1. **Product stance:** ZCode remains **T0 / out of scope** for drop-in `@opencode-ai/plugin` packages. Confirmed in 3.3.6 **and** by public plugins: marketplace ABI is `.zcode-plugin/plugin.json` (+ Claude/Codex manifests), subprocess hooks (`SessionStart`…`Stop`), skills/commands/MCP — **not** npm classic/v2. Evidence: [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md) §7; samples `tmdgusya/glm-hammer`, `jhlee0409/zcode-glm-fleet`.  
2. **Do not confuse** ZCode’s “OpenCode” agent tile / MCP-import-from-`opencode.json` with plugin compat.  
3. **Partner path (only if Z.AI wants it):** Electron loader for npm OpenCode plugins — product-political, not a sidecar we can force.  
4. **Possible narrow bridge (optional, not OPHP):** package markdown skills/commands as `.zcode-plugin` (ecosystem already does this). Hooks do **not** map cleanly to `@opencode-ai/plugin` Hooks.  
5. **Adapter stub** = types + doctor message only; never claim T1+. Doctor text may cite marketplace ABI + example repos above.  
6. **Telemetry kill via OPHP/marketplace plugin:** **not deliverable.** No in-app opt-out; Electron hooks cannot disable ARMS/`event/report`; ASAR patch/resign rejected as product path.

### 7.1 Companion privacy docs (non-runtime)

| Host | In-app opt-out? | Deliverable |
|------|-----------------|-------------|
| **Kilo** | **Yes** — PostHog via config / env | [`docs/guides/kilocode-telemetry-disable.md`](../guides/kilocode-telemetry-disable.md) |
| **MiMo** | **Yes** — `MIMOCODE_ENABLE_ANALYSIS=false` | Cross-link from guides (no separate long guide required yet) |
| **ZCode** | **No** — docs-only firewall/DNS | [`docs/guides/zcode-telemetry-block.md`](../guides/zcode-telemetry-block.md) |

#### Kilo — disable PostHog (shipped guide)

**Evidence:** `@kilocode/kilo-telemetry` → `https://us.i.posthog.com`; CLI bootstrap `Telemetry.init({ enabled: cfg.experimental?.openTelemetry !== false })`; if `KILO_TELEMETRY_LEVEL` is set, only `all` enables. VS Code respects `vscode.env.isTelemetryEnabled` and `POST /telemetry/setEnabled`.

**Must cover (done in guide):** config `experimental.openTelemetry: false`; env `KILO_TELEMETRY_LEVEL=off`; VS Code consent path; optional `us.i.posthog.com` sinkhole; naming caveat (key name says OpenTelemetry but gates PostHog); not an OPHP plugin feature.

#### ZCode — thorough telemetry block (incl. `zcode.z.ai`) — **documentation only**

**Why:** 3.3.6 has **no** reverse-DNS / IP-literal bypass for telemetry hostnames, so host-level DNS/firewall blocks work. Users who want product-event suppression also need guidance that **includes** `zcode.z.ai` — with explicit control-plane / Coding Plan breakage.

**Must cover:**
1. **Targets**
   - ARMS: `proj-xtrace-…cn-beijing.log.aliyuncs.com` and broader `*.log.aliyuncs.com` / `*.rum.aliyuncs.com` as needed
   - Product analytics: `zcode.z.ai` path `/api/v1/event/report` (and whole-host block when path filtering unavailable)
2. **Evidence** — hostname-only endpoints; no PTR/IP fallback; `192.168.6.166` is **not** telemetry
3. **Tiered recipes**
   - **Tier A (ARMS-only):** DNS sinkhole / Little Snitch / `pf` / Pi-hole for Alibaba ARMS hosts — keeps `zcode.z.ai` control plane
   - **Tier B (ARMS + product events, keep BYO LLM):** also block `zcode.z.ai` (or HTTPS MITM/path proxy only for `/api/v1/event/report` if available)
   - **Tier C (maximum isolation):** block `zcode.z.ai` + ARMS; use API-key BYO against `api.z.ai` / `open.bigmodel.cn` / catalog hosts — document what breaks
4. **Breakage matrix when blocking `zcode.z.ai`**
   - Breaks: OAuth/token, client configs, updates, WebSocket remote (`wss://zcode.z.ai/ws`), Coding Plan / Start Plan LLM proxy (`/api/v1/zcode-plan*`)
   - Keeps (typical): local UI; API-key BYO inference to non-`zcode.z.ai` catalog hosts
5. **Verification** — Console.app / `lsof -i` / packet filter logs; confirm ARMS + `event/report` fail while optional BYO chat still works
6. **Honesty** — not an OPHP feature; not a marketplace plugin; do not claim silent perfect privacy if CDN/IP ranges change; re-check after ZCode upgrades
7. **Cross-links** — Kilo guide (in-app opt-out); MiMo `MIMOCODE_ENABLE_ANALYSIS=false` (ZCode has no equivalent)

**Doctor/CLI:** optional one-liner pointers from host doctor text — **no** automated firewall mutation from OPHP; **no** ZCode in-process kill.

---

## 8. Final product — scope & delivery (no phases)

**Rule:** We are not shipping “Phase 1 then Phase 2.” Research is done. Build and ship the **complete product** below as one coherent deliverable (workstreams may run in parallel; none are deferred “later phases”).

### 8.1 Research (already done — evidence only)

Completed 2026-07-19; see `phase0-hooks-parity.md`, `ophp-0.1-spec.md`, `phase0-adr-universal-compat.md`:

- Kilo env/XDG/plugin cache; no project `.opencode` scan  
- ZCode 3.3.6 = T0 (marketplace ≠ OPHP)  
- Classic Hooks: OC ↔ Kilo identical; MiMo +extensions / −dispose / −small_model  
- Sample plugin inventory (classic vs classic+v2)  
- ADR: M1-first, facade overrides, OPHP 0.1, new repo `opencode-plugin-compat`

### 8.2 Product deliverables (ship all)

| Workstream | Deliverable |
|------------|-------------|
| **Repo** | Create `opencode-plugin-compat`; move/copy OPHP docs into `docs/` |
| **Profile** | `@opencode-compat/profile` — HostProfile types + opencode/mimo/kilo/zcode drafts |
| **Facades** | `@opencode-compat/facade-plugin` + `facade-sdk` (classic + v2/promise exports; effect throws unless capable) |
| **Adapter** | `@opencode-compat/adapter` — **one** universal autodetection runtime (opencode / mimo / kilo dispatch; zcode → T0 doctor) |
| **Host kit** | `@opencode-compat/host-promise-v2` — aisdk language/sdk end-to-end; other domains loud-stub |
| **CLI** | `@opencode-compat/cli` — `compat doctor` + matrix runner |
| **Fixtures** | Full conformance set from OPHP §10 (T0–T3 + unsupported-domain) |
| **M1 patches** | Reference patches/PRs for MiMo + Kilo: install overrides, `.opencode` dual-scan (MiMo always / Kilo opt-in), embed host kit |
| **Docs** | Per-host enablement, public Plugin×Host×Tier matrix, ZCode T0 honesty |
| **Companion (non-runtime)** | Kilo telemetry **disable** guide + ZCode telemetry **block** guide — §7.1 / `docs/guides/kilocode-telemetry-disable.md` + `docs/guides/zcode-telemetry-block.md` (ZCode = firewall/DNS docs only; **not** an OPHP plugin kill) |
| **Out of scope** | Cursor dual-host packages (`dual-host-packages-plan.md`) — historical only; close TX/path gaps in the bridge instead |

### 8.3 Repo skeleton (create when building)

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
  docs/ophp/0.1.md
  patches/                  # reference M1 patches for MiMo/Kilo
```

### 8.4 Suggested build order (parallelizable; not gated phases)

1. Scaffold monorepo + profile + facade classic exports.  
2. Universal `@opencode-compat/adapter` (autodetect + mimo/kilo/opencode dispatch) + alias resolve fixtures (T1).  
3. Host kit aisdk + facade `v2/promise` + provider-resolve patch outlines (T3).  
4. Dual-scan / env bridge docs + M1 patch PRs (T2).  
5. Doctor CLI + public matrix + ZCode T0 doctor path.  
6. Re-eval any remaining TX plugins against the T3+path bridge; **do not** ship host-specific consumer plugin forks.

Order is for dependency convenience only — the **release bar** is the full product (§13), not a mid-stack MVP cut.

### 8.5 Out of the “final product” bar (explicit non-goals)

- ZCode marketplace↔OPHP translation / vendor Electron loader (blocked on Z.AI)  
- **In-process ZCode telemetry kill** (plugin/ASAR/`NODE_OPTIONS`) — host firewall/DNS **docs only** (§7.1); Kilo/MiMo use in-app opt-out guides instead  
- Full Effect v2 host parity on every fork (export + loud fail is enough)  
- Owning `@opencode-ai` npm org  
- Host-specific dual packages (`cursor-mimocode-provider`, etc.) as an escape hatch — close gaps in the bridge instead  
- Guaranteeing every deeply host-aware (TX) plugin without further bridge work  

---

## 9. Effort & feasibility

| Scope | Estimate | Feasibility |
|-------|----------|-------------|
| Full **library** + profile + facades + **one** universal adapter + CLI + fixtures | ~3–6 weeks eng | High — we control it |
| M1 patches landing on MiMo + Kilo | Calendar depends on upstream review | Medium — political/process |
| T3 aisdk green on both open forks | Included in product bar once seams found | Medium — needs provider seams |
| “All plugins on all forks unchanged” | Not realistic | Low |
| ZCode drop-in | Blocked without Z.AI | Low until partner |

**Honest ceiling:** Universal layer makes **open CLI forks** converge on OPHP. Deeply host-aware (TX) plugins may still need bridge gaps closed (paths, agents, env). It **does not** unlock closed ZCode without vendor work. Dual-package consumer forks are **out of scope**.

---

## 10. Maintainability vs alternatives

| Strategy | Long-term maintenance |
|----------|------------------------|
| Per-plugin dual/triple packages | Easy per product; scales poorly across many plugins |
| Per-fork compat (MiMo-only × N) | Medium-hard; duplicated |
| **Universal OPHP + one autodetection adapter (this product)** | Harder upfront; **best asymptote** if ≥2 forks cooperate |
| Wait for OpenCode “official fork ABI” | Ideal but uncertain |

**Cursor provider:** ship **unchanged** via OPHP (`cursor-opencode-provider`); close path/TX gaps in the bridge. Do **not** create `cursor-mimocode-provider` / Kilo / ZCode variants.  
**Ecosystem goal:** OPHP + one universal adapter is the primary product. Every cooperating host is an **equal** `HostProfile` target of that adapter — no host is a privileged "proof" and none gets its own adapter package or code path. The MiMo plan is M1 integration detail only.

---

## 11. Relationship to existing plans

| Plan | Role |
|------|------|
| `mimo-opencode-compat-layer-plan.md` | MiMo M1 integration detail — MiMo is an **equal** `HostProfile` target, not a separate `@opencode-compat/adapter-mimo` package |
| `dual-host-packages-plan.md` | **Superseded / out of scope** — historical dual-package sketch only |
| **This plan** | Shared profile, facades, host kit, multi-fork matrix, ZCode policy |

Build sequencing (dependency only):
1. OPHP packages + classic facade + **one** universal adapter (`mimo` profile first).  
2. Add `kilo` / `opencode` / `zcode` `HostProfile` data in the same adapter (no new packages) once MiMo proves overrides.  
3. Host kit + M1 patches for T3.  
4. TX/path smoke for unchanged plugins (incl. `cursor-opencode-provider`); no dual-package track.

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Forks refuse PRs | Ship library + overlay docs; run unofficial fork builds; matrix shows “community build” |
| API skew between Kilo 1.17.4 pin and OpenCode tip | Profile `upstreamPin`; test against pin + tip; facade version gates |
| Facade mistaken for official `@opencode-ai` | Clear naming, docs, no trademark abuse; overrides only inside fork caches |
| Security / supply chain | Pin facade versions; checksums; no auto-exec of unreviewed plugins beyond host policy |
| Over-claiming ZCode support | Explicit T0 until loader exists |
| Scope creep disguised as “phases later” | **No deferred phases** — incomplete domains = loud stub in the same product, not a future phase gate |

---

## 13. Success criteria (final product bar)

1. Published OPHP 0.1 with capability flags + `@opencode-compat/*` packages.  
2. Universal `@opencode-compat/adapter` with `mimo` + `kilo` profiles passes classic conformance suite (T1).  
3. Dual-scan / documented path story for T2 (MiMo PR and/or Kilo opt-in; workarounds documented).  
4. Promise v2 aisdk fixture green where host kit is embedded (T3); unsupported domains fail loud.  
5. At least one unchanged community classic plugin runs on MiMo and Kilo.  
6. Public matrix lists OpenCode / MiMo / Kilo / ZCode with honest tiers.  
7. ZCode documented as unsupported (T0 doctor).  
8. Unchanged `cursor-opencode-provider` (and similar) passes T3+path smoke on cooperating hosts; dual-package forks remain out of scope.  
9. Doctor CLI + governance (semver, CI matrix against pinned forks, security note).

---

## 14. Out of scope

- Phased MVP / “Phase N later” delivery.  
- Owning `@opencode-ai` npm scope.  
- Guaranteeing closed-source forks (ZCode loader).  
- Building host-specific dual packages (`cursor-mimocode-provider`, etc.) as a TX escape hatch.  
- Building IDE-specific Kilo VS Code/JetBrains extension bridges (CLI/OpenCode-ABI first).  
- Full Effect v2 host port on every fork.

---

## 15. Immediate next actions

1. Create repo `opencode-plugin-compat`; copy OPHP docs; scaffold packages (§8.3).  
2. Implement profile + facade + **one** universal adapter + host kit + CLI + fixtures as **one product**.  
3. Land/draft M1 patches: install overrides → facade + `.opencode` dual-scan + host kit embed.  
4. Prove unchanged plugins (incl. `cursor-opencode-provider`) via the bridge — **no** dual-host consumer forks.  
5. ZCode remains T0 stub/doctor only.  
6. **Write** §7.1 companion guides: `docs/guides/kilocode-telemetry-disable.md` (config/env opt-out) + `docs/guides/zcode-telemetry-block.md` (ARMS + optional `zcode.z.ai` block tiers; docs only). Link from doctor/docs.

---

## 16. Research appendix (evidence pointers)

### Kilo (`Kilo-Org/kilocode` clone, 2026-07-19)
- `packages/core/src/global.ts` — `app = "kilo"`; XDG join; `KILO_TEST_HOME`; `Flag.KILO_CONFIG_DIR`
- `packages/core/src/flag/flag.ts` — `KILO_CONFIG`, `KILO_CONFIG_DIR`, `KILO_CONFIG_CONTENT`, …
- `packages/core/src/npm.ts` — install dir `global.cache/packages/<pkg>`
- `packages/opencode/src/config/paths.ts` — project targets `[.kilocode, .kilo]` only
- `packages/opencode/src/config/config.ts` — global merge of `config.json` / `kilo.json(c)` / `opencode.json(c)`
- `packages/plugin/package.json` — exports `.` / `./tool` / `./tui` only
- `.opencode-version` — `v1.17.4`
- CHANGELOG — stop loading `.opencode` (#11638); leftover `.opencode` notice (#12034)

### ZCode 3.3.6 ([ZCode-3.3.6-mac-arm64.dmg](https://cdn-zcode.z.ai/zcode/electron/releases/3.3.6/macos-arm64/ZCode-3.3.6-mac-arm64.dmg) → extracted `app.asar`)
- `package.json` — `@zcode/desktop` 3.3.6, homepage `https://zcode.z.ai`
- `out/host` + `out/main` — RPC `plugins/*`; manifests `.zcode-plugin` / `.claude-plugin` / `.codex-plugin`
- Public plugin ABI follow-up — [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md) §7 (`tmdgusya/glm-hammer`, `jhlee0409/zcode-glm-fleet`)
- External agent enum includes `opencode` with `nativeConfigDir: ".config/opencode"`
- No `@opencode-ai/plugin` / `v2/promise` / `OPENCODE_*` in main/host bundles