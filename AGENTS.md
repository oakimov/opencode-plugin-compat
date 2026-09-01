# AGENTS.md — opencode-plugin-compat

## Product

Universal **OCP** compatibility **bridge** monorepo. The stack is complete and published — no phased MVP cuts.

- Goal: **any OpenCode plugin runs unchanged** on cooperating hosts.
- OCP is an **external compatibility layer** for MiMo/Kilo/OpenCode, the Pi family, and DeepSeek Harness — hosts are read-only references; all OCP work lives in this repo.

### Non-negotiable vendor boundary

OCP is a plugin compatibility layer. **Patching a host shipped by another vendor defeats the product and is not an implementation option.**

- **Never propose, plan, attempt, or make a change to a host checkout, host package, installed host binary, or vendor source as part of OCP work.** Do not treat a vendor patch as a fallback, experiment, diagnostic shortcut, prerequisite, or possible solution. This prohibition applies even when a host source checkout is available locally and even when changing it would be technically easy.
- MiMo, Kilo, OpenCode, pi, omp, and deepseek-harness source trees are **read-only evidence only**: use them to understand contracts and runtime behavior. No OCP task may leave modifications in those repositories.
- **Every compatibility fix must live entirely in OCP** and work against the stock installed host through public or host-injected extension/runtime seams. For Pi-family hosts, use `pi-bridge`, `ExtensionAPI`, `ExtensionAPI.pi`, live objects intentionally exposed through that runtime, extension UI, and advertised tools. For DSH, use `dsh-bridge`, Cordis `LlmAdapter` / `ctx.llm.registerAdapter`, `ctx.credentials`, and `cordis.patch.yml`.
- Private host internals may be inspected to understand behavior, but they are not an implementation surface. If the installed host's extension/runtime seams cannot express the required behavior, stop and report a concrete compatibility limitation. Do not cross the vendor boundary to make the limitation disappear.
- Before designing a fix, inspect the actual executable, resolved package, plugin symlink/install tree, and loaded `dist` entry used by the reproduction. A nearby host checkout is never presumed to be loaded and never becomes a writable dependency of the solution.
- **Interactive behavior requires an interactive acceptance test.** Unit/type tests are supporting checks, not proof. For mode switches, approval dialogs, plan review, or execution handoffs, rebuild/install OCP and the consumer provider, start the real stock host in a TTY, drive the complete user flow, and verify the host transcript, side effect, and absence of retries before saying the issue is fixed.
- These rules apply to the main agent and every delegated subagent. Prompts to subagents must identify host repositories as read-only and forbid edits there.

### Non-negotiable OCP / consumer-provider boundary

The dependency direction is one-way: **OCP may know consumer providers; consumer providers must not know OCP.** OCP must adapt published providers without requiring OCP imports, host branches, or fork vocabulary in their source.

- **Provider stays unchanged:** never solve compatibility by adding `@opencode-compat/*`, OCP detection, fork environment variables, alternate tool names, or host-specific schemas to a consumer provider. Provider-side structural capability contracts must be host-neutral; OCP installs them before provider load.
- **Generic core, optional integrations:** generic facade, adapter, loader, config, and stream translation code must work for arbitrary OpenCode/AI-SDK providers. A provider-specific integration (currently Cursor host tools) must live in a clearly named optional module, activate only for an explicit package match, fail open when that provider is absent, and never become a prerequisite for generic providers.
- **OCP owns translation end-to-end:** fork paths, canonical tool catalog translation, call inputs, results, prompt/history replay, opaque resume ids, schemas, MCP/resource vocabulary, agents, and mode semantics are OCP responsibilities. The provider must see canonical OpenCode shapes.
- **Three host families, three mechanisms — never unify them:**
  - **OpenCode clones** (MiMo, Kilo; zcode detect-only) ship OpenCode-shaped native plugin packages → facades + **one** autodetection adapter + host kit, wired by `ocp setup`. `packages/adapter` must not contain Pi/OMP/DSH ids, paths, env variables, packages, or tool roles.
  - **Pi family** (`pi` earendil-works, `oh-my-pi`/omp can1357) are **not** OpenCode forks and have no `@opencode-ai/plugin`-shaped package → `@opencode-compat/pi-bridge` dynamically loads the unmodified plugin and registers it via the host's own `pi.registerProvider(...)`, translating AI-SDK `doStream` ↔ the host's event stream. The `ocp` CLI and clone adapter are not involved.
  - **DSH family** (`dsh` / DeepSeek Harness) is **not** an OpenCode fork and not Pi → `@opencode-compat/dsh-bridge` is a Cordis plugin that registers `ctx.llm.registerAdapter(...)`, translating AI-SDK `doStream` ↔ DSH `StreamChunk`. The `ocp` CLI and clone adapter are not involved. `packages/adapter` must not contain DSH ids.
- **Neutral path contract:** install `Symbol.for("opencode.host.path-bridge")` with structural cache/data/config/project paths. Legacy symbols may be emitted only as time-bounded backward compatibility; new provider code must not import OCP or name the installer. Generic bridge paths and cache namespaces must not be named after Cursor or another consumer.
- **Capability/catalog integrity:** preserve every enabled tool and deterministic order through translation. A lifecycle call with no tools remains a lifecycle signal; session affinity and cancellation must reach the downstream provider so it can correlate a sibling full-catalog call. Never invent/filter a catalog to accommodate one provider.
- **Functionality relocation gate:** before removing a compatibility branch from a consumer provider, add OCP tests proving equivalent catalog, call, result, resume-id, schema, and prompt-history behavior. Refactoring the boundary must not delete working compatibility.
- **Architecture checks:** tests must cover at least one generic fake/Acme provider on clone and Pi paths, explicit optional Cursor activation, no Pi/DSH logic in clone runtime, no mandatory/static Cursor import in generic Pi or DSH code, and no Pi logic in `packages/dsh-bridge` clone-facing runtime (DSH must not import Pi host packages).

Plugins are discovered through **OpenCode's own standard conventions** (`hooks.auth`, the `config` hook's `provider[id].models`, the root `createXxx()` AI-SDK factory). Never hardcode a specific plugin in generic bridge code and never sniff host versions to pick behavior.
- **User delivery UX (locked):** one installable umbrella package (`@opencode-compat/ocp`) + **`ocp setup`** that writes install-tree overrides; users then add **consumer** plugins via host config (`plugin` / equivalent) unchanged. Listing OCP itself in `plugin` is optional bootstrap only — it does **not** intercept other plugins’ imports by itself.
- Facades remapped in **plugin install trees / operator overrides** (not spoofing public `@opencode-ai` on npm). Publish **public** `@opencode-compat/*` — agent bump/publish runbook in this file; human guide `docs/guides/npm-publish.md`.
- Scope: `@opencode-compat/*` — **host bridge packages** (internal) + umbrella UX package + named **companions** that must not redefine OCP success.
- License: **MPL-2.0** (all packages).
- ZCode is **T0 only** for OCP (marketplace ≠ OpenCode plugin ABI). Companion `@opencode-compat/migrate-zcode` migrates **plugin-packaged** skills/commands/marketplace manifests into `.zcode-plugin` trees (**not** host MCP; **not** unchanged `@opencode-ai/plugin` loadability).
- **Do not** create or plan host-specific forks of consumer plugins (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, ZCode variants, etc.). Close gaps in the bridge.
- **Do not** ship separate per-host adapter packages. Host differences are `HostProfile` data + dispatch inside `@opencode-compat/adapter`.

## Layout

```
packages/ocp          # umbrella UX (+ ocp setup) — OpenCode clones
packages/profile|facade-*|adapter|host-promise-v2|cli|migrate-zcode
packages/opencode-loader  # shared OpenCode plugin loader (pi-bridge + dsh-bridge)
packages/pi-bridge    # Pi family (pi / omp) — dynamic OpenCode-plugin loader
packages/dsh-bridge   # DSH family — Cordis LlmAdapter
fixtures/          # OCP conformance (migrator tests use in-memory mocks)
docs/hosts/        # ONE self-contained page per host family (install + internals)
docs/ocp/0.1.md    # contract (OpenCode-clone facade protocol)
docs/plans/        # historical: ADR + product plan + discovery evidence (shipped)
docs/guides/       # companion privacy / ZCode import notes (non-OCP runtime)
```

## Build rules

- Prefer Bun workspaces; TypeScript strict; ESM only.
- Facades / universal adapter must not hardcode a single fork’s XDG paths — use `HostProfile` + autodetection.
- MiMo extension hooks (`actor.*`, `session.*`) are **non-portable** — never require them for T1 plugins.
- Facade `v2/effect` may loud-fail unless host declares capability; `v2/promise` + aisdk is the T3 bar.
- Do not claim ZCode drop-in without a Z.AI vendor loader.
- `pi-bridge` host variance is data in `packages/pi-bridge/src/host/profile.ts` (`PiHostProfile`) + narrow dispatch — same rule as `HostProfile`; never fork the package per host. Optional host packages (`@oh-my-pi/pi-ai`, `@earendil-works/pi-ai`) must stay **lazy dynamic imports**; a top-level import breaks the other host and the test run.
- `dsh-bridge` host variance is data in `packages/dsh-bridge/src/host/profile.ts` (`DshHostProfile`) + narrow dispatch. Optional DSH packages (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm`) must stay **lazy / structural**; a top-level import breaks pack and hosts that are not DSH.
- Consumer plugins (e.g. `cursor-opencode-provider`) are **test/matrix subjects**, not deliverables of this repo.
- Privacy companions: Kilo/MiMo document **in-app** telemetry opt-out; ZCode telemetry is **docs-only** firewall/DNS — never claim an OCP plugin kill.

## Docs source of truth

1. `docs/ocp/0.1.md` — protocol contract for the OpenCode-clone facade path
2. `packages/pi-bridge/README.md` — contract + config reference for the Pi family
3. `packages/dsh-bridge/README.md` — contract + Cordis patch config for the DSH family
4. `docs/hosts/opencode-clones.md` (MiMo/Kilo/ZCode) / `docs/hosts/pi-family.md` (Pi) / `docs/hosts/dsh-family.md` (DSH) — one self-contained guide per host family; install lives **in** them, not in a separate top-level INSTALL doc
5. Provider-maintained interactive acceptance checklist: `cursor-opencode-provider/docs/host-compat-acceptance.md`; run the OMP/Pi/DSH items against stock hosts before claiming interactive parity.
6. `docs/plans/**` — **historical**; shipped work, kept for provenance. Superseded by the above wherever they disagree; do not treat as a roadmap.

## Version bump / publish (agent runbook)

When the user asks to **bump the version** (e.g. “bump to 0.1.3”), treat that as a **full release request** and run this checklist **end-to-end without stopping for confirmation**, unless a gate fails or the target version already exists on npm.

Canonical human guide: `docs/guides/npm-publish.md`. This section is the agent execution contract.

### Hard rules

- Ship the **whole train** together — all 11 `@opencode-compat/*` packages share one version.
- Packages are **public** (`publishConfig.access: "public"` / `--access public`). Never private.
- **Never** republish an existing version. If `npm view @opencode-compat/ocp@X.Y.Z version` already returns that version, stop and ask.
- **Never** bump by hand-editing only `package.json`. Always use `bun scripts/bump-version.ts <ver>` so **`bun.lock` workspace versions** stay in sync.
- Bun `pm pack` rewrites `workspace:*` from **`bun.lock`**, not `package.json`. A stale lock publishes wrong transitive pins (this is how `0.1.1` broke). `pack:check` must pass before commit/tag.
- Do **not** use local `bun run publish:npm` for later releases — Trusted Publishers + OIDC on tag `v*` is the path.
- Tag format is **`v` + train version** (example: packages `0.1.2` → tag `v0.1.2`). Tag must match package versions.
- Root `package.json` version is monorepo metadata and may lag; do **not** require it to match the train.

### Packages in the train

`profile` → `opencode-loader` → `host-promise-v2` → `migrate-zcode` → `adapter` → `facade-sdk` → `facade-plugin` → `cli` → `ocp` → `pi-bridge` → `dsh-bridge`

This order is `PACKAGES` in `scripts/publish.ts` — keep the two in sync when adding a package.

### Automatic steps (do all of these)

1. **Preflight**
   - `git status` clean (or only intentional release edits); on `main`; pull/pushable.
   - Confirm target version is **new**: `npm view @opencode-compat/ocp@X.Y.Z version` must fail / not equal target.
   - Confirm current train is consistent: all `packages/*/package.json` versions equal; `bun.lock` workspace versions equal that train.
   - Optional sanity: last Publish workflow succeeded (`gh run list --workflow=publish.yml -L 3`).

2. **Bump**
   ```bash
   bun scripts/bump-version.ts X.Y.Z
   ```
   This updates each package `package.json`, `VERSION` / profile `OCP_VERSION` (`packages/profile/src/version.ts`), and **`bun.lock`**, then runs `bun install`.

3. **Docs / defaults sync**
   - CLI setup default is `OCP_VERSION` from `@opencode-compat/profile` — no hardcoded train pin needed in `setup.ts`.
   - Update user-facing train mentions in `docs/hosts/opencode-clones.md` §2.4 (example `--version` / “today **X.Y.Z**”) when they still name an older train.
   - Do **not** churn historical narrative in `docs/guides/npm-publish.md` bootstrap sections, plan docs, or host-profile `drafts.ts` `ocpVersion` contract examples unless the user asks.

4. **Verify (fail closed)**
   ```bash
   bun run pack:check
   ```
   Must show:
    - `publish-ready: 11 public packages @ X.Y.Z`
    - eleven packs at `X.Y.Z`
    - `packed-deps-ok: 11 tarballs pin @opencode-compat/* @ X.Y.Z`
   Spot-check tarballs under `.tmp/npm-pack/` if anything looks off: every `@opencode-compat/*` dependency must be the **exact** train version.

5. **Commit + push `main`**
   ```bash
   git add -A
   git commit -m "chore: release X.Y.Z"
   git push origin main
   ```
   Include `bun.lock` and any INSTALL/default sync files.

6. **Tag + push tag (triggers OIDC publish)**
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   `.github/workflows/publish.yml` runs on `v*` → install → typecheck → test → build → `bun scripts/publish.ts --publish --oidc --skip-tests`.

7. **Verify publish**
   - Watch the run: `gh run watch` / `gh run list --workflow=publish.yml -L 1` until success.
    - Confirm registry for all 11 (or at least umbrella + leaves):
     ```bash
     npm view @opencode-compat/ocp version          # X.Y.Z
     npm view @opencode-compat/ocp@X.Y.Z dependencies
     ```
     Transitive `@opencode-compat/*` deps on the published umbrella must be **X.Y.Z**, not an older train.
   - `npm dist-tag ls @opencode-compat/ocp` → `latest` should be `X.Y.Z`.
   - Consumer smoke (when host caches are available):
     ```bash
     bun add -g @opencode-compat/ocp@X.Y.Z
     ocp setup --host mimo --mode npm --version X.Y.Z
     ocp setup --host kilo --mode npm --version X.Y.Z
     ocp doctor --host mimo
     ```

### If something fails

- **`pack:check` / packed-deps gate:** fix lock/train drift (`bun scripts/bump-version.ts X.Y.Z` or repair `bun.lock`); do not tag.
- **Publish workflow OIDC / ENEEDAUTH:** check Trusted Publisher settings (repo `oakimov/opencode-plugin-compat`, workflow filename exactly `publish.yml`) and `repository.url` in each package; do not fall back to a long-lived `NPM_TOKEN` unless the user explicitly asks.
- **Partial train on npm (should not happen via OIDC, but if recovering a local publish):** `bun scripts/publish.ts --publish --skip-existing` — only with user intent.
- **Bad version already on registry:** you cannot fix-in-place. Deprecate if needed (`npm deprecate pkg@ver "reason"`), bump to the **next** patch, and ship a good train. Do not rely on `npm unpublish` for patched mistakes.

### Intentionally out of scope unless asked

- Retagging `latest` onto an older version.
- Deprecating prior trains.
- Live MiMo/Kilo model listing beyond setup/doctor smoke.
- Bumping root private workspace `package.json` version.

## Standing constraints

- **ZCode stays T0.** `migrate-zcode` packs plugin-packaged skills/commands/manifests into `.zcode-plugin` trees; it never packs host MCP and never makes ZCode an `@opencode-ai/plugin` load target.
- **Expand `facade-sdk` from real smoke failures**, not speculation; keep the conformance matrix green.
- **`host-promise-v2` is wired from the OCP layer** wherever provider-resolve is reachable without modifying host source. Live clone hosts still need an operator/sidecar call into `resolveProvider` for T3.
- **Consumer plugins** (e.g. `cursor-opencode-provider`) are test/matrix subjects, not deliverables of this repo. Gaps close in the bridge, never by forking the plugin.
- **Releases** follow **Version bump / publish** above (OIDC on `v*`). First-time bootstrap details stay in `docs/guides/npm-publish.md`.

Companion privacy guides live under `docs/guides/` (Kilo/MiMo in-app opt-out; ZCode docs-only firewall/DNS). Doctor prints one-liner pointers; OCP never mutates telemetry.