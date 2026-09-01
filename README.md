# opencode-plugin-compat

**OCP** — OpenCode Compatibility Protocol and a **universal compatibility bridge** for OpenCode-compatible hosts.

Run **published OpenCode plugins unchanged** (`import "@opencode-ai/plugin"` / `v2/promise`) on **MiMo Code**, **Kilo Code**, **pi**, **oh-my-pi**, and **DeepSeek Harness** via an external `@opencode-compat/*` layer. Hosts are read-only references; OCP never ships or forks host-specific plugin packages (no `cursor-mimocode-provider`, `cursor-kilocode-provider`, etc.).

Three host families are supported — **never unify the mechanisms**:

- **OpenCode clones/forks** — MiMo (`mimocode`), Kilo (`kilocode`), zcode. These ship their own OpenCode-shaped native plugin packages, so an unmodified plugin's `@opencode-ai/plugin` / `@opencode-ai/sdk` imports are resolved to *facades* that delegate to the host's native package, plus one universal autodetection adapter driven by `HostProfile` data. **zcode is detect/doctor-only** — its marketplace ABI (`.zcode-plugin`) is not the `@opencode-ai/plugin` ABI, so it is not a load target.
- **Pi family** — `pi` ([earendil-works](https://github.com/earendil-works/pi)) and `oh-my-pi` / `omp` ([can1357](https://github.com/can1357/oh-my-pi), a fork of pi). Neither is an OpenCode fork and neither has an `@opencode-ai/plugin`-shaped package, so `@opencode-compat/pi-bridge` dynamically loads an unmodified OpenCode `aisdk`-type plugin and registers it through the host's own `pi.registerProvider(...)`, translating AI-SDK `doStream` to/from the host's `Context` / `AssistantMessageEvent` stream. Live host subagent tools are also exposed to the plugin through OpenCode's canonical `task` vocabulary and translated back for execution/history, including OMP's required terminal `yield` lifecycle and asynchronous parent wake-ups.
- **DSH family** — DeepSeek Harness (`dsh` / `dsh web`). Not an OpenCode fork and not Pi; Cordis `ctx.llm.registerAdapter`. `@opencode-compat/dsh-bridge` loads the unmodified plugin and translates AI-SDK `doStream` ↔ DSH `StreamChunk`. The `ocp` CLI is not involved.

**Install** — one self-contained guide per host family:

- **MiMo / Kilo** — [**docs/hosts/opencode-clones.md**](./docs/hosts/opencode-clones.md): npm install `@opencode-compat/ocp`, then `ocp setup` (uses `cursor-opencode-provider` as the worked example).
- **pi / oh-my-pi** — [**docs/hosts/pi-family.md**](./docs/hosts/pi-family.md): install `@opencode-compat/pi-bridge` with the host's extension installer, then name your provider package in one config file.
- **DSH** — [**docs/hosts/dsh-family.md**](./docs/hosts/dsh-family.md): `dsh plugin --profile web add @opencode-compat/dsh-bridge`, then name providers in `cordis.patch.yml`.

`ocp setup` also applies LanguageModel tool-stream normalization to compatible custom provider entries. It uses each call's advertised tool schema to adopt argument-key conventions (for example, camelCase or snake_case), so providers and future OpenCode-compatible hosts remain host-agnostic.

**License:** [MPL-2.0](./LICENSE)

## Supported hosts

| Family | Host | How OCP attaches | Docs |
|--------|------|------------------|------|
| OpenCode clones | MiMo (`mimocode`) | Facades + universal adapter (`ocp setup`) | [`docs/hosts/opencode-clones.md`](./docs/hosts/opencode-clones.md) |
| | Kilo (`kilocode`) | Facades + universal adapter (`ocp setup`) | [`docs/hosts/opencode-clones.md`](./docs/hosts/opencode-clones.md) |
| | zcode | Detect / doctor only — marketplace ABI ≠ OpenCode plugin ABI | [`docs/hosts/opencode-clones.md`](./docs/hosts/opencode-clones.md) |
| Pi family | pi (earendil-works) | `@opencode-compat/pi-bridge` → `pi.registerProvider(...)` | [`docs/hosts/pi-family.md`](./docs/hosts/pi-family.md) |
| | oh-my-pi / omp (can1357) | `@opencode-compat/pi-bridge` → `pi.registerProvider(...)` | [`docs/hosts/pi-family.md`](./docs/hosts/pi-family.md) |
| DSH family | DeepSeek Harness (`dsh`) | `@opencode-compat/dsh-bridge` → `ctx.llm.registerAdapter(...)` | [`docs/hosts/dsh-family.md`](./docs/hosts/dsh-family.md) |

## Packages (`@opencode-compat/*`)

| Package | Role |
|---------|------|
| [`ocp`](./packages/ocp) | **Umbrella UX** for OpenCode clones: one install + `ocp setup` → Layer A overrides; re-exports / depends on the facade bridge packages |
| [`profile`](./packages/profile) | `HostProfile` types + host drafts (opencode / mimo / kilo / zcode) |
| [`facade-plugin`](./packages/facade-plugin) | Install-override stand-in for `@opencode-ai/plugin` |
| [`facade-sdk`](./packages/facade-sdk) | Stand-in for `@opencode-ai/sdk` (minimal) |
| [`adapter`](./packages/adapter) | **One** universal host adapter — autodetects host, dispatches via `HostProfile` |
| [`host-promise-v2`](./packages/host-promise-v2) | Shared Promise v2 aisdk host kit (wired from OCP layer) |
| [`opencode-loader`](./packages/opencode-loader) | Shared host-neutral OpenCode plugin loader (used by pi-bridge and dsh-bridge) |
| [`pi-bridge`](./packages/pi-bridge) | Pi family: dynamically load an unmodified OpenCode `aisdk` plugin and register it on pi / omp |
| [`dsh-bridge`](./packages/dsh-bridge) | DSH family: Cordis `LlmAdapter` for unmodified OpenCode `aisdk` plugins |
| [`cli`](./packages/cli) | `compat doctor` + matrix + `setup`/`overrides` (+ migrate-zcode companion) |
| [`migrate-zcode`](./packages/migrate-zcode) | Companion: plugin-package skills/commands/manifests → `.zcode-plugin` (**not** OCP ABI; **no** host MCP) |

Also: [`fixtures/`](./fixtures) (conformance), [`docs/hosts/`](./docs/hosts) (host enablement notes).

**Not in scope:** separate publishable packages per host (`adapter-mimo`, `adapter-kilo`, …). OpenCode-clone differences live in `HostProfile` data + internal dispatch inside `@opencode-compat/adapter`; pi-family differences live as data in `packages/pi-bridge/src/host/profile.ts`; DSH variance lives as data in `packages/dsh-bridge/src/host/profile.ts`. ZCode marketplace packing is a **companion** deliverable (`compat migrate-zcode`) and does not make zcode a load target.

## Docs

| Doc | Purpose |
|-----|---------|
| [`docs/hosts/opencode-clones.md`](./docs/hosts/opencode-clones.md) | **MiMo / Kilo / ZCode** — install, per-host internals, Promise v2 sidecar, troubleshooting |
| [`docs/hosts/pi-family.md`](./docs/hosts/pi-family.md) | **pi / oh-my-pi** — install, config, model variants, verification |
| [`docs/hosts/dsh-family.md`](./docs/hosts/dsh-family.md) | **DSH** — install, Cordis patch, Models list, verification |
| [`packages/pi-bridge/README.md`](./packages/pi-bridge/README.md) | pi-bridge config reference + pi/omp host-difference table |
| [`packages/dsh-bridge/README.md`](./packages/dsh-bridge/README.md) | dsh-bridge contract + Cordis patch config |
| [`docs/ocp/0.1.md`](./docs/ocp/0.1.md) | OCP contract — HostProfile, classic hooks, tiers, Promise v2, conformance |
| [`TESTING.md`](./TESTING.md) | **Manual local dev** — unpublished OCP + local plugins (`./scripts/ocp-dev.sh`) |
| [`docs/guides/kilocode-telemetry-disable.md`](./docs/guides/kilocode-telemetry-disable.md) | Disable Kilo PostHog telemetry (config / `KILO_TELEMETRY_LEVEL`) |
| [`docs/guides/mimocode-telemetry-disable.md`](./docs/guides/mimocode-telemetry-disable.md) | Disable MiMo Xiaomi usage analytics (`MIMOCODE_ENABLE_ANALYSIS=false`) |
| [`docs/guides/zcode-telemetry-block.md`](./docs/guides/zcode-telemetry-block.md) | ZCode telemetry block (**docs-only** firewall/DNS) |
| [`docs/guides/zcode-import-and-migrate.md`](./docs/guides/zcode-import-and-migrate.md) | ZCode Import UI vs `compat migrate-zcode` (companion; not OCP ABI) |
| [`docs/guides/npm-publish.md`](./docs/guides/npm-publish.md) | Publish **public** `@opencode-compat/*` (local create-publish, then OIDC Trusted Publishing on tags) |

## Develop

```bash
bun install
bun run build
bun run typecheck
bun test
bun run setup -- --host mimo --dry-run
bun run matrix
bun run doctor -- --host mimo
bun run pack:check          # publish dry-run (see docs/guides/npm-publish.md)
```

Requires [Bun](https://bun.sh) ≥ 1.2. CLI bins import `dist/` — run `bun run build` after a clean checkout.

For end-to-end checks against a real host with local checkouts, see [**TESTING.md**](./TESTING.md).

```bash
./scripts/ocp-dev.sh run                 # wire every installed host (local OCP + local provider)
./scripts/ocp-dev.sh run --mode npm      # switch those hosts to published packages
./scripts/ocp-dev.sh run kilo mimo       # only the named hosts
./scripts/ocp-dev.sh unshim              # factory restore; existing host config is preserved
```

Hosts: `opencode`, `mimo`, `kilo`, `pi`, `omp`, `dsh`. Local mode defaults to a sibling
`cursor-opencode-provider` checkout; override with `OCP_DEV_PROVIDER_PATH`.
Config edits only insert or remove the OCP/provider slot.

## Related

- Example consumer plugin (must run **unchanged** via OCP): [oakimov/cursor-opencode-provider](https://github.com/oakimov/cursor-opencode-provider)
- Research baselines: [oa-tools/mimo-review](https://github.com/oakimov/oa-tools/tree/main/mimo-review), [oa-tools/kilo-review](https://github.com/oakimov/oa-tools/tree/main/kilo-review), [oa-tools/zcode-review](https://github.com/oakimov/oa-tools/tree/main/zcode-review)
