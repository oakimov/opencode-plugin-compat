# Plan: Plugin package → ZCode `.zcode-plugin` migrator (companion)

**Date:** 2026-07-19  
**Status:** **Complete (A–I)** — library, CLI, guide, and optional multi-plugin marketplace wrap landed  
**Repo:** [oakimov/opencode-plugin-compat](https://github.com/oakimov/opencode-plugin-compat)  
**Related:**
- Research: [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md) §7–§9 (esp. §9 Option 3)
- OCP contract: `docs/ocp/0.1.md` (ZCode remains **T0**)
- Product ADR: `phase0-adr-universal-compat.md`
- Parent plan: `universal-opencode-plugin-compat-plan.md`

**Goal:** Ship a **companion** library/CLI that migrates a **plugin package** vendoring `skills/`, `commands/`, and marketplace manifests into a ZCode `.zcode-plugin` tree. This is **not** OCP plugin ABI compatibility and **must not** flip `zcode` to `supported: true`.

**Explicit non-goal (user decision):** **Do not** migrate host MCP from `opencode.json`. ZCode has its own MCP; this tool never reads or packs MCP maps.

---

## 1. Product boundary (non-negotiable)

| Claim | Allowed? |
|-------|----------|
| “Migrate plugin-packaged skills / commands / marketplace manifests into a `.zcode-plugin` tree” | **Yes** |
| “Migrate host `opencode.json` MCP into the emitted plugin” | **No** |
| “Run `@opencode-ai/plugin` packages unchanged on ZCode” | **No** (still T0 / needs host loader) |
| Change `HostProfile` for `zcode` to T1+ | **No** |
| Live under `@opencode-compat/*` as a **named companion** | **Yes** (this plan) |
| Imply matrix cells for classic/v2 plugins on ZCode pass via migrator | **No** |

**Framing in docs/doctor:** migrator = **plugin marketplace asset packager**; OCP doctor for ZCode continues to say marketplace ≠ `@opencode-ai/plugin`, and may add a one-liner pointer: “for skills/commands packing see `compat migrate-zcode`”.

Privacy companions are the precedent: shipped in-repo, clearly **not** runtime OCP bridge features.

---

## 2. Deliverable shape

### 2.1 New package

| Item | Value |
|------|--------|
| Package | `@opencode-compat/migrate-zcode` |
| Role | Library: scan plugin package → sanitize → emit `.zcode-plugin` tree + report |
| License | MPL-2.0 |
| Deps | Prefer stdlib + existing workspace only; **no** dependency on facades / adapter / host-promise-v2 |
| Optional soft dep | `@opencode-compat/profile` only if we reuse path helpers — **do not** couple to detect/doctor support flags |

### 2.2 CLI surface

Extend `@opencode-compat/cli` (thin wrapper; logic lives in `migrate-zcode`):

```text
opencode-compat migrate-zcode \
  --plugin <dir> [--plugin <dir>...]   # repeatable; multi requires --marketplace-name
  [--out <dir>]                        # required unless --dry-run
  [--name <plugin-name>] \             # single-plugin mode only
  [--version <semver>] \
  [--marketplace-name <catalog>] \     # multi-plugin (or single) marketplace wrap
  [--marketplace-description <text>] \
  [--owner-name <name>] [--owner-url <url>] \
  [--allow-empty] \
  [--dry-run] \
  [--format text|json]
```

Root scripts:

```json
"migrate-zcode": "bun packages/cli/bin/compat.ts migrate-zcode"
```

Marketplace wrap emits glm-fleet shape:

```text
<out>/
  .zcode-plugin/marketplace.json
  plugins/<slug>/.zcode-plugin/plugin.json
  plugins/<slug>/skills|commands/...
```

Child plugins omit nested `marketplace.json` (catalog lives at the root only).
### 2.3 Docs / charter updates

| File | Change |
|------|--------|
| `AGENTS.md` | Companion deliverable; ZCode T0; no host MCP; migrator ≠ OCP loadability |
| `README.md` | Packages table row + explicit “not OCP ABI / no host MCP” |
| `docs/README.md` | Link this plan |
| `docs/ocp/0.1.md` | Short § companion note: migrator optional; does not change tiers |
| `packages/profile` doctor | Optional one-liner pointing at `migrate-zcode` / this plan |
| `docs/guides/zcode-import-and-migrate.md` (new) | How ZCode Import UI vs CLI migrator relate |

---

## 3. Mapping contract (MVP)

### 3.1 Input: one plugin package directory

Scan **only** the given `pluginDir` (no project/global OpenCode config roots, no `opencode.json` MCP):

| Asset | Paths under `pluginDir` |
|-------|-------------------------|
| Skills | `skills/**/*.md` (prefer `skills/<name>/SKILL.md`) |
| Commands | `commands/**/*.md` |
| Manifests | `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.zcode-plugin/marketplace.json`, root `marketplace.json` |
| Package identity | `package.json` `name` / `version` / `main` / `exports` |

Never execute JS. Record JS entrypoints as `skipped` with reason `ocp-abi-not-migratable`.

### 3.2 Transforms

**Skills**

- Prefer `**/SKILL.md` directories; also accept flat `*.md` under `skills/`.
- Emit as `skills/<slug>/SKILL.md`.
- Frontmatter keep: `name`, `description` only. Drop / report other keys (e.g. `slash`).
- Collision policy: duplicate skill names → **fail closed**.

**Commands**

- Collect `**/*.md` under `commands/`.
- Keep body as command template; frontmatter keep `description` (name from filename / frontmatter).
- Drop / report: `agent`, `model`, `subtask`, and unknown keys.
- Collision policy: duplicate command names → **fail closed**.

**Manifests**

- Prefer existing `.zcode-plugin/plugin.json` fields for emitted `name` / `version` / `description`.
- Else fall back to `.claude-plugin` / `.codex-plugin` / `package.json`.
- Copy first found `marketplace.json` to `.zcode-plugin/marketplace.json`.
- Carry non-runtime path hints (`agents`, `hooks`, `lsp`) from an existing zcode manifest when present.
- **Never** emit MCP / `mcpServers` / `.mcp.json` from host config.

**Skipped always (report clearly)**

- JS entrypoints (`package.json` `main` / `exports`) — `ocp-abi-not-migratable`
- Programmatic `skill.transform` / `command.transform`
- Auth / provider / `tool()` registrations
- Rewriting OC hooks → ZCode `hooks.json` subprocess hooks
- Host MCP from `opencode.json`

Hooks-only packages (JS entry, no marketplace assets) → warning `hooks-only-plugin` and `ok: false` unless `allowEmpty`.

### 3.3 Output tree

```text
<out>/
  .zcode-plugin/
    plugin.json          # name, version, description, skills?, commands?
    marketplace.json     # optional, if source had one
  skills/...
  commands/...
  README.md              # generated: provenance + “not OC npm ABI”
```

`plugin.json` minimum fields:

```json
{
  "name": "migrated-plugin",
  "version": "0.0.0",
  "description": "Migrated by @opencode-compat/migrate-zcode — marketplace assets only; not an OpenCode npm plugin ABI package.",
  "skills": "./skills",
  "commands": "./commands"
}
```

Optional stretch: also emit `.claude-plugin/plugin.json` mirror for dual-manifest ecosystems — **out of MVP**.

### 3.4 Report schema

```ts
type MigrateReport = {
  ok: boolean
  outDir?: string
  pluginDir: string
  included: { skills: string[]; commands: string[]; manifests: string[] }
  skipped: { path: string; reason: string }[]
  warnings: string[]
}
```

Exit code (CLI): `0` if emit succeeded (even with JS skips); `1` on I/O/schema/collision errors; `2` if nothing includable and not `--allow-empty`.

---

## 4. Non-goals (explicit)

1. OCP facades, dual-scan, or host-promise-v2 for ZCode  
2. Host MCP migration from `opencode.json` / config dirs  
3. Executing or sandbox-running OC plugins to extract dynamic skills/commands  
4. Faithful OC → ZCode **hooks** translation  
5. Importing into a live ZCode app install (user installs the emitted plugin via ZCode UI / `plugins.dirs`)  
6. Migrating MiMo/Kilo assets (different product; revisit later)  
7. Claiming matrix/ZCode T1 in fixtures  
8. Checked-in filesystem fixtures that can leak private configs — **mock/temp dirs only**

---

## 5. Tests

### 5.1 Approach

- **In-memory / temp-dir mocks only** under `test/migrate-zcode.test.ts` (no `fixtures/migrate-zcode/`, no real `opencode.json`).
- Cover: skills+commands+manifest emit, frontmatter sanitization, hooks-only / `allowEmpty`, marketplace copy, name collisions, required `pluginDir`.

### 5.2 Runner

- Root `bun test` includes `test/migrate-zcode.test.ts`
- Package `tsc -b` via workspace project reference
- **Do not** add ZCode classic/v2 matrix passes

### 5.3 Manual acceptance (after CLI)

1. `bun run migrate-zcode -- --plugin …/mock-plugin --out /tmp/zcode-plugin --dry-run`  
2. Real emit; inspect tree  
3. Optional: install into ZCode via Import / local plugin dir (manual QA in guide)

---

## 6. Implementation order

| Step | Work | Done when | Status |
|------|------|-----------|--------|
| **A** | Plan + docs index / AGENTS / README charter | T0 + no-MCP boundary clear | **Done** |
| **B** | Scaffold `packages/migrate-zcode` + tsconfig project reference | `tsc -b` green | **Done** |
| **C** | Types + report + markdown sanitizers | Unit tests for frontmatter | **Done** |
| **D** | `scanPluginPackage` (skills/commands/manifests/JS skips) | Mock scan tests | **Done** |
| **E** | Emitter writes tree + README provenance | Mock emit tests | **Done** |
| **F** | CLI `migrate-zcode` subcommand + root script | `--help` + dry-run | **Done** |
| **G** | Doctor one-liner | Doctor text reviewed | **Done** |
| **H** | `docs/guides/zcode-import-and-migrate.md` | Guide published | **Done** |
| **I** | (Optional) multi-plugin marketplace wrapper polish | Documented as stretch | **Done** |

No MiMo/Kilo M1 work is blocked by this; keep bridge PRs independent.

---

## 7. API (library — current)

```ts
export type MigrateZcodeOptions = {
  pluginDir: string
  outDir?: string
  name?: string
  version?: string
  dryRun?: boolean
  allowEmpty?: boolean
}

export declare function migrateZcode(
  options: MigrateZcodeOptions,
): Promise<MigrateZcodeResult>

export type MigrateZcodeMarketplaceOptions = {
  pluginDirs: string[]
  outDir?: string
  marketplaceName: string
  marketplaceDescription?: string
  ownerName?: string
  ownerUrl?: string
  dryRun?: boolean
  allowEmpty?: boolean
}

export declare function migrateZcodeMarketplace(
  options: MigrateZcodeMarketplaceOptions,
): Promise<MigrateZcodeMarketplaceResult>
```

Internal modules: `types.ts`, `markdown.ts`, `scan.ts`, `emit.ts`, `marketplace.ts`, `report.ts`, `index.ts`.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Handbook / `plugin.json` field drift across ZCode versions | Pin notes to researched 3.3.6; validate against glm-hammer + handbook; version the emitter |
| Users think migrator = OCP on ZCode | Hard banners in CLI, package README, doctor, OCP § companion |
| Secret leakage from host configs | **Do not read** host MCP / `opencode.json`; mock-only tests; no checked-in private fixtures |
| Empty / hooks-only plugins | Honest `allowEmpty` / exit 2; report `ocp-abi-not-migratable` |
| Scope creep into hooks or MCP rewrite | Listed in non-goals; reject PRs that claim equivalence |

---

## 9. Acceptance criteria

1. `@opencode-compat/migrate-zcode` builds and tests pass in CI/local `bun test` + `tsc -b`.  
2. Library (and later CLI) produces a loadable-shaped `.zcode-plugin` tree from mocked plugin packages.  
3. JS entrypoints always appear under `skipped` with reason `ocp-abi-not-migratable`.  
4. Docs state ZCode OCP tier remains **T0**; matrix behavior unchanged.  
5. Tool never reads or emits host MCP from `opencode.json`.  
6. AGENTS.md lists the companion without redefining OCP success as “unchanged OC plugins on ZCode.”

---

## 10. Decision log

| Decision | Choice |
|----------|--------|
| In-monorepo vs separate repo | **In-monorepo** companion package (user request) |
| Package name | `@opencode-compat/migrate-zcode` |
| OCP tier impact | **None** (T0 stays) |
| Input shape | **Plugin package directory** (not OC project/config roots) |
| Host MCP | **Out of scope** (ZCode has its own MCP) |
| Hooks translation | **Out of scope** |
| Fixtures | **Mock/temp dirs only** (no checked-in MCP goldens) |
| Name collisions | **Fail closed** (MVP) |
| CLI home | Subcommand on existing `opencode-compat` / `compat` bin |

---

## 11. Next action

Migrator plan complete (**A–I**). Use:

```bash
bun run migrate-zcode -- --plugin <dir> --dry-run
bun run migrate-zcode -- \
  --plugin <dir-a> --plugin <dir-b> \
  --marketplace-name my-fleet --out /tmp/fleet --dry-run
```

Keep bridge/M1 work independent; ZCode OCP tier stays **T0**.