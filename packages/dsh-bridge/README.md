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
| session affinity | DSH `GenerateOptions.sessionId` → V3 `headers["x-opencode-session-id"]` |
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

`@opencode-compat/opencode-loader` in this package's `package.json` must stay an
**exact train pin** (never `workspace:*`). DSH profile pnpm installs via `file:`
and cannot see the OCP Bun workspace — `workspace:*` fails with
`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` (0.4.1). `bump-version.ts` rewrites the pin.

`peerDependencies` on `@deepseek-ai/dsh-*` are checked against the **dsh product
runtime version** (today `0.1.x` / `0.2.x`), not the published major of that
package. Use a product-compatible range (e.g. `>=0.1.0`); `>=1.0.0` or a
`^0.1`-only pin makes `dsh plugin add` reject newer `0.2.x` runtimes.

Do not run `ocp setup` against DSH.

## Tool names

The live DSH catalog is restated as OpenCode names before the plugin sees it, and
provider calls are mapped back on `block-end`:

| Host | Advertised | Notes |
|---|---|---|
| `todo_write` | `todowrite` | Strip `id`/`priority`/`merge`; omit `cancelled` |
| `ask_user_question` | `question` | Canonical schema; missing `id` is filled; `multiple` ↔ `multi_select`; JSON answers rewritten to OpenCode prose |

System text and system-role messages name those tools by their OpenCode names
too: a code span that is exactly `` `todo_write` `` or `` `ask_user_question` ``
becomes `` `todowrite` `` / `` `question` ``, for every provider. Prose is left
alone.

File tools still advertise `filePath` and map `path`/`filePath` → `file_path`.
Bash still drops required `description` and fills it from `command`.
For Cursor packages, the optional plan integration registers `plan_enter`
and invokes the calling agent's native `/plan` command at execution. This
uses DSH's own plan service even when it is isolated inside an agent preset.
Cursor's native
SwitchMode therefore selects the actual host state before the next step.
The native `exit_plan_mode` catalog entry is advertised to Cursor as
`cursor_plan_stage`; its `content` becomes the native `{plan}` argument.
Calls still execute as `exit_plan_mode` through DSH's normal tool pipeline,
including its review UI, approval/refinement, cancellation, and next-step exit.
If Cursor ends a plan-mode turn with a titled markdown plan in prose instead
of calling the advertised tool, OCP submits that completed text to the same
native review before the turn can finish. This fallback checks the calling
agent's logged plan projection; it never runs outside plan mode or after an
ordinary tool call. The host-owned call id starts with `host_plan_stage_`.
DSH retains the full plan in its session transcript. OCP does not write mode
events, parse approval-question wording, or queue an execution follow-up.
DSH tool-role result messages stay tool results in the AI SDK prompt, so
Cursor's held Run receives their answers instead of starting a new turn.
System guidance uses the translated tool name; review errors remain errors
on replay. Both tools stay advertised across mode changes. Other providers
keep the native `exit_plan_mode` name/schema and do not see OCP's synthetic
`plan_enter`. Cursor also receives `cursor_image_save` for generated binary
images. It accepts only the provider's single-use staged image ID and uses
DSH's current sandbox policy and approval service before the provider commits
the file. Other providers do not see this tool. If the calling agent lacks the
native plan service, plan entry fails closed.
See the upstream [plan-mode contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/plan/plan-mode/README.md).

Continuable children also `send_message` their result (`agent-message` relay) and
DSH then posts a `subagent-settled` notice. Each wakes a generate when the
parent is idle. For Cursor only, after a text-only stop, the adapter finishes
those child-notice generates without opening the model and repeats the prior
text as the final visible reply. This prevents DSH's completed-Turn folding
from hiding a request for user input. The display copy is omitted from later
model prompts. Helper results claimed in the same turn as a spawn
`tool-call` still generate. Plan results and later child notices remain ordinary
DSH history; OCP does not reinterpret or remove them.

Cursor's large discovered-tool catalogs may spill through a normal `write`
call to `<host-cache>/projects/<slug>/agent-tools/<uuid>.txt`. For this exact
metadata path, the bridge adds DSH's advertised `danger-full-access` escalation
fields so the native write tool asks for approval before saving outside the
workspace. Other write paths and providers retain their original arguments.

DSH delivers AGENTS.md and scoped instruction files as user-role messages
(`source.kind: "agent-instructions"`). For Cursor only, the bridge moves them
into `system`, in request order: cursor-opencode-provider reaches the model
with host system context only through an always-apply rule built from the
system prompt, and sends just the latest user message as a turn's live text, so
an instruction message elsewhere in the request would be lost, and one after
tool results would read as a new user turn. Devin and generic providers keep
DSH's native user-role messages.

## Path bridge

On apply, installs `Symbol.for("opencode.host.path-bridge")`:

- `globalDataDir` — `$DSH_HOME` or `~/.dsh`
- `globalCacheDir` — `$XDG_CACHE_HOME/opencode` or `~/.cache/opencode`
- `projectConfigDirs` — `<workspace>/.dsh` and `<workspace>/.opencode`

## License

MPL-2.0
