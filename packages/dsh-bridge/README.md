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
      - package: devin-opencode-provider
        apiKey: DEVIN_API_KEY
```

Only `package` is required. Optional fields match the Pi-family spec shape
(`providerName`, `apiKey`, `createOptions`, `disableOAuth`,
`preferAuthMethod`, `splitDimensions`, `directory`).

| Discovered | From the plugin's own… |
|---|---|
| provider id | `auth.provider` (else the package name; de-collided against reserved DSH ids such as `cursor` → `cursor-opencode`) |
| model catalog | `config` hook — `config.provider[id].models` |
| API key | `apiKey` CredentialRef env name via `ctx.credentials.resolve`, then the plugin `auth.loader`, before the catalog read and each factory call |
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
node /path/to/deepseek-harness/apps/cli/lib/bin.js web
```

`dsh plugin add file:` copies the package into `$DSH_HOME/profiles/web/node_modules`.
A later `tsc` that emits *new* dist files does not update that copy — live DSH
keeps loading the profile tree, not the checkout `dist`. `ocp-dev.sh run dsh`
rebuilds and syncs that profile copy.

Do not run `ocp setup` against DSH.

## Tool names

The live DSH catalog is restated as OpenCode names before the plugin sees it, and
provider calls are mapped back on `block-end`:

| Host | Advertised | Notes |
|---|---|---|
| `todo_write` | `todowrite` | Strip `id`/`priority`/`merge`; omit `cancelled` |
| `ask_user_question` | `question` | Canonical schema; missing `id` is filled; `multiple` ↔ `multi_select`; JSON answers rewritten to OpenCode prose |

File tools still advertise `filePath` and map `path`/`filePath` → `file_path`.
Bash still drops required `description` and fills it from `command`.
`exit_plan_mode` stays host-named and advertised in both active and inactive
plan state, matching DSH's native contract. DSH's configured `plan:policy`
guidance tells the active model when to call it; the tool owns review,
approval/refinement, and the transition back to default mode. OCP neither
infers plan intent from question text nor writes `plan/mode` or injects an
execution follow-up. Outside plan mode the native tool fails as designed.
Keeping the catalog stable also avoids extra cache churn across mode changes.
See the upstream [plan-mode contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/plan/plan-mode/README.md).

Continuable children also `send_message` their result (`agent-message` relay) and
DSH then posts a `subagent-settled` notice. Each wakes a generate when the
parent is idle. For Cursor only, after a text-only stop (the continuation ask),
the adapter finishes those child-notice generates with no text so the wait
banner is not shown again. Helper results claimed in the same turn as a spawn
`tool-call` still generate. Plan results and later child notices remain ordinary
DSH history; OCP does not reinterpret or remove them.

## Path bridge

On apply, installs `Symbol.for("opencode.host.path-bridge")`:

- `globalDataDir` — `$DSH_HOME` or `~/.dsh`
- `globalCacheDir` — `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`
- `projectConfigDirs` — `<workspace>/.dsh` and `<workspace>/.opencode`

## License

MPL-2.0
