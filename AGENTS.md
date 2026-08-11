# AGENTS.md — opencode-plugin-compat

## Product

Universal **OCP** compatibility **bridge** monorepo. The stack is complete and published — no phased MVP cuts.

- Goal: **any OpenCode plugin runs unchanged** on cooperating hosts.
- OCP is an **external compatibility layer** for MiMo/Kilo/OpenCode and the Pi family — hosts are read-only references; all OCP work lives in this repo.
- **Two host families, two mechanisms** — never unify them:
  - **OpenCode clones** (MiMo, Kilo; zcode detect-only) ship OpenCode-shaped native plugin packages → facades + **one** autodetection adapter + host kit, wired by `ocp setup`.
  - **Pi family** (`pi` earendil-works, `oh-my-pi`/omp can1357) are **not** OpenCode forks and have no `@opencode-ai/plugin`-shaped package → `@opencode-compat/pi-bridge` dynamically loads the unmodified plugin and registers it via the host's own `pi.registerProvider(...)`, translating AI-SDK `doStream` ↔ the host's event stream. The `ocp` CLI is not involved.
- Plugins are discovered through **OpenCode's own standard conventions** (`hooks.auth`, the `config` hook's `provider[id].models`, the root `createXxx()` AI-SDK factory). Never hardcode a specific plugin (no Cursor-shaped branches in bridge code) and never sniff host versions to pick behavior.
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
packages/pi-bridge    # Pi family (pi / omp) — dynamic OpenCode-plugin loader
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
- Consumer plugins (e.g. `cursor-opencode-provider`) are **test/matrix subjects**, not deliverables of this repo.
- Privacy companions: Kilo/MiMo document **in-app** telemetry opt-out; ZCode telemetry is **docs-only** firewall/DNS — never claim an OCP plugin kill.

## Docs source of truth

1. `docs/ocp/0.1.md` — protocol contract for the OpenCode-clone facade path
2. `packages/pi-bridge/README.md` — contract + config reference for the Pi family
3. `docs/hosts/opencode-clones.md` (MiMo/Kilo/ZCode) / `docs/hosts/pi-family.md` (Pi) — one self-contained guide per host family; install lives **in** them, not in a separate top-level INSTALL doc
4. `docs/plans/**` — **historical**; shipped work, kept for provenance. Superseded by the above wherever they disagree; do not treat as a roadmap.

## Version bump / publish (agent runbook)

When the user asks to **bump the version** (e.g. “bump to 0.1.3”), treat that as a **full release request** and run this checklist **end-to-end without stopping for confirmation**, unless a gate fails or the target version already exists on npm.

Canonical human guide: `docs/guides/npm-publish.md`. This section is the agent execution contract.

### Hard rules

- Ship the **whole train** together — all 9 `@opencode-compat/*` packages share one version.
- Packages are **public** (`publishConfig.access: "public"` / `--access public`). Never private.
- **Never** republish an existing version. If `npm view @opencode-compat/ocp@X.Y.Z version` already returns that version, stop and ask.
- **Never** bump by hand-editing only `package.json`. Always use `bun scripts/bump-version.ts <ver>` so **`bun.lock` workspace versions** stay in sync.
- Bun `pm pack` rewrites `workspace:*` from **`bun.lock`**, not `package.json`. A stale lock publishes wrong transitive pins (this is how `0.1.1` broke). `pack:check` must pass before commit/tag.
- Do **not** use local `bun run publish:npm` for later releases — Trusted Publishers + OIDC on tag `v*` is the path.
- Tag format is **`v` + train version** (example: packages `0.1.2` → tag `v0.1.2`). Tag must match package versions.
- Root `package.json` version is monorepo metadata and may lag; do **not** require it to match the train.

### Packages in the train

`profile` → `host-promise-v2` → `migrate-zcode` → `adapter` → `facade-sdk` → `facade-plugin` → `cli` → `ocp` → `pi-bridge`

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
   - `publish-ready: 9 public packages @ X.Y.Z`
   - nine packs at `X.Y.Z`
   - `packed-deps-ok: 9 tarballs pin @opencode-compat/* @ X.Y.Z`
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
   - Confirm registry for all 9 (or at least umbrella + leaves):
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