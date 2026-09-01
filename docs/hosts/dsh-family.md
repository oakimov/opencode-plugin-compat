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
| API key | `CredentialRef` env name (`CURSOR_API_KEY`, `DEVIN_API_KEY` — native, not `DSH_`-prefixed) via `ctx.credentials.resolve` |
| streaming | `createXxx()` AI-SDK V3 factory (`doStream`) → `StreamChunk` |
| session affinity | `GenerateOptions.sessionId` (DSH-native) → V3 `headers["x-opencode-session"]` |

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

`local` builds the local `opencode-loader` + `dsh-bridge` and provider, adds the bridge via `dsh plugin add`, and points the patch entry at the provider's absolute `dist/index.js`. `npm` switches back to bare npm names. Mirrors `docs/hosts/pi-family.md:87` for `pi/omp`.

## Verify

1. `dsh web` starts, model picker shows `cursor/*` (or `cursor-opencode/*` if de-collided).
2. One full turn: user → model stream → `StreamChunk` `tool-call` → DSH executes → follow-up turn.
3. New provider = yml row only.

Programmatic smoke (no yml):

```ts
import { registerDshPlugin } from "@opencode-compat/dsh-bridge/src/register.js"
await registerDshPlugin(ctx, { package: "cursor-opencode-provider" })
```

## Path bridge

On load, `dsh-bridge` installs `Symbol.for("opencode.host.path-bridge")`:

- `globalDataDir` — `$DSH_HOME` or `~/.dsh`
- `globalCacheDir` — `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`
- `projectConfigDirs` — `<workspace>/.dsh` and `<workspace>/.opencode`
