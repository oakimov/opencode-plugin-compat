# DeepSeek Harness (DSH) — `dsh` / `dsh web`

DSH is a Cordis-based agent harness (`deepseek-harness`). OCP runs **unmodified** OpenCode `aisdk`-type plugins as LLM adapters via `@opencode-compat/dsh-bridge`.

Authoritative contract: [`packages/dsh-bridge/README.md`](../../packages/dsh-bridge/README.md). This page is the family install/verify guide. The discovery plan under `tasks/plans/` is historical.

## Mechanism: `dsh-bridge`, not facades

DSH is **not** an OpenCode clone and has no `@opencode-ai/plugin`-shaped package, so the facade/`ocp setup` mechanism does **not** apply.

Instead, `@opencode-compat/dsh-bridge` is a **Cordis plugin** (`name`/`inject`/`Config`/`apply`) that dynamically loads unmodified OpenCode plugins and registers each as a `ctx.llm.registerAdapter()` `LlmAdapter`:

| Discovered | From the plugin's own… |
|---|---|
| provider id | `auth.provider` (else package name, de-collided against `deepseek-official` etc.) |
| model catalog | `config` hook — `config.provider[id].models`, models.dev entry shape, variant `effort` → DSH ACP `reasoningEffort` |
| API key | `CredentialRef` env name (`CURSOR_API_KEY`, `DEVIN_API_KEY` — native, not `DSH_`-prefixed) via `ctx.credentials.resolve`, then the plugin `auth.loader` |
| streaming | `createXxx()` AI-SDK V3 factory (`doStream`) → `StreamChunk` |
| session affinity | `GenerateOptions.sessionId` (DSH-native) → V3 `headers["x-opencode-session-id"]` |

Host variance is **data** (`DshHostProfile` single `dsh` profile) — same rule as `HostProfile`/`PiHostProfile`.

## Install via DSH plugin

```bash
dsh plugin --profile web add @opencode-compat/dsh-bridge
# then set config.providers[].package (npm name or absolute dist/index.js)
# restart dsh web
```

`@opencode-compat/dsh-bridge` and `@opencode-compat/opencode-loader` ship in the same train. The provider package is loaded by the bridge from `config.providers[].package`; it does not need to be listed as a DSH bundle.

### Configuration — DSH yml way

No `dsh-bridge.json` file search. Configuration is the Cordis patch `config.providers[]` (native DSH `cordis.patch.yml`):

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml  (written by `dsh plugin add`)
- insert:
    - id: ocp-dsh-bridge
      name: '@opencode-compat/dsh-bridge'
      config:
        providers:
          - package: cursor-opencode-provider
            providerName: cursor          # optional
            apiKey: CURSOR_API_KEY      # CredentialRef env name, not a secret
            createOptions: { apiKey: "$apiKey" }
          - package: devin-opencode-provider
            apiKey: DEVIN_API_KEY
```

Only `package` is required. The same `OpenCodePluginSpec` shape as `pi-bridge` is accepted (`providerName`, `apiKey`, `createOptions`, `disableOAuth`, `preferAuthMethod`, `splitDimensions`, `directory`) but stored in yml, not a JSON file.

The Models list is the `dsh-bridge` settings section (same shape as `llm-pi-ai.providers.<id>`). The bridge seeds `dsh-bridge.providers.<route>` from the patch (`apiKeyEnv` = the `apiKey` CredentialRef) so a registered adapter shows as a configured row without Add provider.

Variant `effort` dimensions map to the host ACP effort picker via `LlmResolvedModelInfo.reasoning.efforts`.

## Development helper

Local/npm switch is via `scripts/ocp-dev.sh` (DSH family, local checkout + npm mode — not `ocp setup`):

```bash
./scripts/ocp-dev.sh run dsh
./scripts/ocp-dev.sh run dsh --mode npm
```

`local` runs `pnpm install` and the harness documented build (`build:native-system`, host/client lib, `build:web`; tsdown only for directories with `package.json`), builds local `opencode-loader` + `dsh-bridge` and the provider, stages dsh-bridge with a `file:` pin to the local loader (profile pnpm cannot resolve Bun `workspace:*` or an unpublished train pin), adds that stage via `dsh plugin add`, syncs those packages' `dist` into the profile `node_modules` copy (pnpm `file:` does not pick up newly emitted files), and points the patch entry at the provider's absolute `dist/index.js`. `npm` switches back to bare npm names. Mirrors `docs/hosts/pi-family.md:87` for `pi/omp`.

**Train pin rule:** `packages/dsh-bridge/package.json` must keep `@opencode-compat/opencode-loader` as an **exact train pin**, never `workspace:*`. Profile pnpm reads the source manifest on `dsh plugin add file:…` and fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` otherwise (0.4.1 regression). `bun scripts/bump-version.ts` rewrites the pin and refuses workspace protocol on dsh-bridge / pi-bridge — see [`docs/guides/npm-publish.md`](../guides/npm-publish.md).

## Verify

1. From a checkout, `node apps/cli/lib/bin.js web` starts (after the harness lib build). Do not use `pnpm dsh web` — that tsx source launcher dual-loads `dsh-tools` and every tool dies on `prepare`. Model picker shows `cursor/*` (or `cursor-opencode/*` if de-collided) and, when the Devin checkout is wired, `devin-opencode/*` (`devin` is reserved on DSH).
2. One full turn: user → model stream → `StreamChunk` `tool-call` → DSH executes → follow-up turn.
3. New provider = yml row only.

Programmatic smoke (no yml):

```ts
import { registerDshPlugin } from "@opencode-compat/dsh-bridge/src/register.js"
await registerDshPlugin(ctx, { package: "cursor-opencode-provider" })
```

## Tool vocabulary

`dsh-bridge` remaps only the host tools that have an OpenCode-equivalent
vocabulary (same rule as pi-bridge `providerName`):

| Host | Advertised | Call remap |
|---|---|---|
| `todo_write` | `todowrite` | strip `id`/`priority`/`merge`; omit `cancelled` |
| `ask_user_question` | `question` | synthesize missing `id`; `multiple` ↔ `multi_select`; JSON `{answers}` → OpenCode `"<prompt>"="<answer>"` prose |

The canonical `question` tool is the visible, host-native way to collect a
choice, confirmation, or missing detail during a turn. A request that needs a
new user turn stays a standalone final reply, which DSH displays outside its
collapsed activity.

Cursor's optional OCP integration supplies `plan_enter` through the public
DSH `/plan` command, which reaches the calling agent's plan service even when
the service is isolated inside an agent preset. The host commits that selection at
its next step boundary. Cursor sees native `exit_plan_mode` as
`cursor_plan_stage`: the complete markdown `content` becomes DSH's `{plan}`,
starting with `#`. DSH executes its original tool, displays the native review,
and owns approval, feedback, cancellation, and exit. The transcript retains
the submitted plan; no extra filesystem plan artifact is required.
When Cursor ends in titled markdown plan prose without a tool call, OCP
submits that plan through the same native review while the calling agent's
logged plan state is active. The host transcript records a
`host_plan_stage_` call id for this fallback.
Other providers retain the native name/schema. The catalog stays stable
across mode changes. OCP rewrites the tool reference in system guidance but
does not append mode events or inject execution follow-ups. `/plan` remains
available to the user. See the upstream
[plan-mode README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/plan/plan-mode/README.md).

For Cursor-generated images, the bridge advertises `cursor_image_save` only to
Cursor. The tool accepts a single-use staged image ID and commits the provider's
bytes at the requested path. DSH's current sandbox policy decides whether an
approval prompt is needed; a save outside a workspace-write sandbox asks for
approval before writing. Other providers do not see this tool.

If DSH wakes Cursor again solely for a late subagent notice after a text-only
reply, the bridge repeats that reply in the new final step without another
model call. DSH keeps it visible outside collapsed activity. The display copy
is excluded from later model prompts. This applies to any reply text, including
requests for user input.

When Cursor spills a large discovered-tool catalog to its `agent-tools/`
metadata directory under the host cache, OCP supplies DSH's normal file-write
escalation fields. The native write asks for approval because this cache is
outside the workspace. OCP does not widen other file writes.

## Path bridge

On load, `dsh-bridge` installs `Symbol.for("opencode.host.path-bridge")`:

- `globalDataDir` — `$DSH_HOME` or `~/.dsh`
- `globalCacheDir` — `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`
- `projectConfigDirs` — `<workspace>/.dsh` and `<workspace>/.opencode`
