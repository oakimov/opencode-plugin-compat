# @opencode-compat/dsh-bridge

Runs **unmodified** OpenCode `aisdk`-type plugins as LLM adapters on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh` /
`dsh web`).

DSH is not an OpenCode fork and has no `@opencode-ai/plugin`-shaped package, so
the facade / `ocp setup` path does not apply. This package is a Cordis plugin
that loads the OpenCode plugin dynamically and registers it with
`ctx.llm.registerAdapter(...)`, translating AI-SDK `doStream` to DSH
`StreamChunk`.

User install and verify: [`docs/hosts/dsh-family.md`](../../docs/hosts/dsh-family.md).
This file is the package contract.

## Adding a provider

Cordis patch (`$DSH_HOME/profiles/web/cordis.patch.yml`), not a JSON file:

```yaml
- id: ocp-dsh-bridge
  config:
    providers:
      - package: cursor-opencode-provider
        apiKey: CURSOR_API_KEY
```

Only `package` is required. Optional fields match the Pi-family spec shape
(`providerName`, `apiKey`, `createOptions`, `disableOAuth`,
`preferAuthMethod`, `splitDimensions`, `directory`).

| Discovered | From the plugin's own… |
|---|---|
| provider id | `auth.provider` (else the package name; de-collided against reserved DSH ids such as `cursor` → `cursor-opencode`) |
| model catalog | `config` hook — `config.provider[id].models` |
| API key | `apiKey` CredentialRef env name via `ctx.credentials.resolve` (native names, not `DSH_`-prefixed) |
| streaming | `createXxx()` AI-SDK V3 factory (`doStream`) |
| session affinity | DSH `GenerateOptions.sessionId` → V3 `headers["x-opencode-session"]` |
| effort variants | plugin `variants` / `effort` → `LlmResolvedModelInfo.reasoning` |

The Models list is the `dsh-bridge` settings section (same shape as
`llm-pi-ai.providers.<id>`). The bridge seeds `dsh-bridge.providers.<route>`
from the patch so a registered adapter shows as a configured row.

## Install

```bash
dsh plugin --profile web add @opencode-compat/dsh-bridge
# then set config.providers[] as above; restart dsh web
```

Local checkout:

```bash
./scripts/ocp-dev.sh run dsh
pnpm --prefix /path/to/deepseek-harness dsh web
```

Do not run `ocp setup` against DSH.

## Path bridge

On apply, installs `Symbol.for("opencode.host.path-bridge")`:

- `globalDataDir` — `$DSH_HOME` or `~/.dsh`
- `globalCacheDir` — `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`
- `projectConfigDirs` — `<workspace>/.dsh` and `<workspace>/.opencode`

## License

MPL-2.0
