# Changelog

All notable user-facing changes to the `@opencode-compat/*` release train are documented here.

The monorepo ships **one shared train version** across all eleven packages, so unlike per-package changelogs this file is the single source of release notes. See `AGENTS.md` § Changelog for the agent contract.

## [Unreleased]

### Added

- One current tool vocabulary records native and provider-facing calls, parameters, and declaration sources; host upgrades and tool changes require updating it in place.

- Kilo and MiMo: the host path bridge now tells providers the host's own plan file for a session (`planFile`), so a Cursor plan is written where the host's plan review reads it and approved through that review.

### Changed

- Cursor self-verify skips unavailable optional question/helper capabilities without failing T7, includes ordinary AskQuestion rejections in its saved extract, scopes evidence to the current session, and retains unexpected scoring-command failures.
- Cursor self-verify keeps argument/schema failures after successful retries and separately scores attempted execution in tool-less helper requests.
- Cursor self-verify final reports require rendered Markdown with a metadata list and score table, without enclosing code fences or plain-text output.
- Clone-host provider shims add one event-only `__ocpUsageEvents` plugin export and keep the provider's own exports unchanged, so the provider plugin loads once; rerun `ocp setup` to refresh existing shims.
- Self-verify plan and scoring steps are host-neutral: create a plan and let the session review it; do not name per-host tools or routes.
- Self-verify image step no longer names a destination folder; the host workflow chooses the path, and H3 still scores the advertised project folder save.
- Self-verify guides create the scratch directory with `mktemp -d`, so a run never picks up files an earlier run left behind.
- Self-verify task-list steps tell the model to add fields its todo schema requires (such as `id`) instead of copying the minimal examples verbatim.
- Self-verify scoring shortens long lines with `cut` so projections work on macOS and Linux.
- Self-verify counts every host tool error result (such as an unexpanded `~` path) and no longer fails T7 when a Cursor-native call executed as the host's advertised tool.

### Fixed

- Self-verify requires a complete failure inventory before a pass, including rejected native discovery and premature plan attempts, even when every host call later succeeds.
- Self-verify distinguishes dynamic invocation identity from inner arguments, waits for deferred plan-agent handoffs, and counts parallel and scoring rejections separately, including shell failures masked by a later successful command.
- OMP delegated tasks include required solution context in single/batch mode, foreground calls collect the child result, and child completion submits the current yield schema without overriding structured/work-pool output.
- Pi/OMP reject empty edit matches before execution and preserve grep file filters; OMP preserves enabled shell service parameters.
- MiMo patch calls validate with canonical keys, and continuing a child sends to that child before waiting instead of passing an invalid id to a new run.
- DSH retains advertised child routes and blocking/timed question behavior.

- MiMo file catalogs and replay use canonical OpenCode keys before provider validation, then execution returns to the native schema. Its generated checkpoint reminder uses `todoread` for task state instead of sending native work-item operations to the canonical delegation tool.
- OMP plan staging advertises its active-plan prerequisite. Dismissing review cancels the native turn without approving execution, preventing settle enforcement from reopening review.
- Cursor self-verify retains server-side dynamic invocation failures and silently ignored shell arguments, uses compact shell projections for scoring, and correlates usage/helper evidence to the owning Run.
- Pi and OMP file calls advertise the same canonical fields used for execution and history, preventing valid writes from being refused for native path or intent fields; OMP grep also omits its injected intent requirement.
- MiMo restores the previously active todo to pending when a full-list update moves activity to another item; reconstructed history retains that transition too.
- OMP todo status updates (start, complete, cancel, remove) apply as single host ops instead of re-initialising the list, so they no longer trigger replan session retitling or reorder rows.
- Kilo session titles are generated again: OCP sends Kilo's isolated `title-<session>` request without session affinity, so it no longer waits for a tool catalog that never arrives.
- DSH `plan_enter` keeps the model planning in the same turn and submitting with `cursor_plan_stage`, instead of ending the turn idle in plan mode.
- DSH delivers its skill catalog to bridged providers in the system prompt, matching OpenCode and Pi, so the first turn no longer starts with a premature `skill` lookup.
- DSH requests that offer file tools state the home directory, since DSH file tools do not expand `~`.
- DSH rejects a bridged model's `read`/`read_image`/`edit`/`glob`/`grep`/`bash` call whose path does not exist before it runs, naming the call to make instead (absolute path for `~/…`, the real home directory, or a `glob` lookup).
- DSH keeps provider cache data (project folders, generated images, persisted Cursor conversations) under `$DSH_HOME/cache/opencode-providers` instead of sharing OpenCode's `~/.cache/opencode`; existing DSH Cursor conversations start cold once.

- Local clone-host provider refreshes restore plugin/SDK facade links, preventing plugin tool schemas from breaking after an additional wrapper is rebuilt.
- DSH processes newly returned tool results when helper notices arrive in the same continuation, while retaining silent notices after a completed text reply.
- JSONC plugin discovery rejects unfinished block comments and preserves token boundaries instead of silently accepting altered values.
- OMP: after plan approval that queues execution, the model is told to end the turn instead of implementing the plan twice.
- Pi with `@pify/plan-mode`: staging a Cursor plan no longer turns pify's reopen reminder into a second user turn, so approval executes the plan once.
- Pi with `@pify/plan-mode` allows `cursor_plan_stage` (and the other OpenCode plan tools) while planning, without a "not known to be read-only" confirm.
- DSH shows a completed reply once, as the Chat message: helper notices after that reply do not start another step, so the text is not copied and is not folded into thinking. This also holds when Cursor is picked per session rather than as the profile default.
- `ocp-dev.sh run dsh` updates only the bridge row of the DSH profile patch and keeps the saved default model and other settings.
- DSH runs a Cursor helper task in the foreground and returns its result, as Cursor and OpenCode expect, instead of starting it in the background so Cursor launched the same helper twice.
- DSH host notes after a tool result (time, plan-mode, helper notices) reach the running Cursor turn instead of cancelling it and opening a new one with the note as the user's message.
- DSH starts implementing a Cursor plan once it is approved in the plan review, instead of ending the turn with nothing done.
- DSH `grep` results reach Cursor with their matching lines instead of only the file names.
- DSH `ask_user_question` answers reach Cursor as the chosen option instead of an empty AskQuestion success.
- `ocp setup` reads host configs with JSONC trailing commas (Kilo `kilo.jsonc`), so absolute-path plugins listed there are wired to the OCP facades instead of being skipped.
- MiMo no longer restarts the Cursor conversation in a loop after a todo update on Claude models: fanned-out host `task` calls keep ids that survive the host's tool-call id scrubbing and fold back into one result.
- MiMo marks finished todos `done` instead of abandoning them.
- OMP 18.6+ advertises its live subagent list on `task`, so models pick a real agent (no more `Unknown agent "generalPurpose"` retry).
- Pi passes hidden extension context (for example `@pify/plan-mode` reminders) to providers as host notes, so entering plan mode mid-turn no longer drops the conversation's tool results and context.
- Pi with `@pify/plan-mode`: after an approval that queues the implementation, the model ends its turn instead of implementing the plan twice.
- Pi, OMP, and DSH run each provider plugin's OpenCode `chat.params` hook with the host's plan mode as the agent, so plan mode entered through the host's own `/plan` reaches the provider (Cursor plans straight to the host plan review instead of searching for tools).
- Pi with `@pify/plan-mode` writes Cursor plans to the host plans directory (`<pi agent dir>/plans`, e.g. `~/.pi/agent/plans`) instead of `<workdir>/.pi/plans`, and shows the plan in the transcript before asking for approval. Each plan file is named `<created>-<name>.md`, so two plans with the same title no longer overwrite each other.
- Pi with `@pify/plan-mode`: entering plan mode and pify's plan reminders now name `cursor_plan_stage` instead of pify tools the model cannot see (`write_plan`, `exit_plan_mode`).
- Pi and OMP report a reply you abort as aborted instead of the error "Provider stream ended without a finish event".
- OMP: staging a plan before entering plan mode now tells the model to call `plan_enter` first.
- Pi and OMP keep context occupancy and billed usage accurate without inflating held-run totals.
- Generic provider token reporting preserves input aggregates, cache writes, reasoning subsets, and unknown totals across host bridges.
- DSH uses explicit provider context snapshots for metering (including sessions with offloaded images) and preserves model context and output limits.
- Devin cached-context snapshots no longer inflate billed token buckets on Pi, OMP, DSH, Kilo, or MiMo.
- DSH lists bridged providers (Cursor, Devin, …) in Settings → Models again on DSH 0.1.7+, which keeps live settings in each plugin's Cordis Config; `apiKeyEnv` names the credential (`apiKey` remains an alias).
- DSH passes a provider credential from `apiKeyEnv` to the plugin's API-key login instead of treating it as an OAuth session, so Cursor `crsr_` keys work again (`preferAuthMethod: oauth` restores the old behavior).
- Kilo and MiMo normalize generation-result usage and reconcile accounting for providers without their own event bridge, once per host event; separate installed runtimes share reconciliation state.

## [0.4.3] - 2026-10-04

### Added

- Pi-family hosts can drive OpenCode plan mode through `@pify/plan-mode`, including plan review flows on oh-my-pi / omp.
- DSH workspace instructions are folded into the system prompt for Cursor so host workspace context reaches the provider.

### Fixed

- Canonical prompt references are normalized, and todo tool results are isolated so sibling tools do not see stale todo state.
- Cursor session affinity and `auth.loader` options stay aligned across Pi and DSH bridges.
- MiMo `in_progress` session starts create correctly; DSH/Pi package resolution is stricter about the installed entry that actually loads.
- Hardened Cursor compatibility across DSH and Pi hosts (catalog, call, and history translation edges).

## [0.4.2] - 2026-09-24

### Fixed

- `pi-bridge` and `dsh-bridge` keep exact train pins for `@opencode-compat/*` dependencies so foreign `file:` installs (pnpm / host plugin add) no longer fail with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

## [0.4.1] - 2026-09-24

### Changed

- OpenCode plugin loading is shared through `@opencode-compat/opencode-loader` for both Pi and DSH bridges.
- Provider-specific usage translation stays inside OCP; Kilo uses host-based generic usage reconciliation.

### Fixed

- Pi-bridge preserves Cursor occupancy and rebases local compactions so resume/history replay stays coherent.
- omp plan review stays open until the user answers instead of closing early.
- OpenCode `glob` `pattern`+`path` arguments fold into omp's expected `path` shape.

## [0.4.0] - 2026-09-01

### Added

- DeepSeek Harness support via `@opencode-compat/dsh-bridge` (Cordis `LlmAdapter`, AI-SDK `doStream` ↔ DSH `StreamChunk`).
- Shared `@opencode-compat/opencode-loader` package for host-neutral OpenCode plugin loading.

## [0.3.2] - 2026-09-01

### Changed

- Patch train release; packaging and docs aligned with the 0.3.1 runtime fixes.

## [0.3.1] - 2026-08-19

### Fixed

- omp OpenCode `read` / `edit` / hashline / todo bridges hardened for live host schemas.
- Pi-bridge read selectors use raw host forms; CodeQL ReDoS patterns cleared.

## [0.3.0] - 2026-08-17

### Fixed

- Pi-bridge model refresh and edit-history replay hardened after 0.2.4 review findings.
- Optional Cursor image-save import is no longer typechecked when the provider package is absent.

## [0.2.4] - 2026-08-13

### Fixed

- Pi-bridge edit aliases are gated on the live host schema; sibling-host vocabulary is accepted and history is replayed in the advertised shape.

## [0.2.3] - 2026-08-13

### Added

- Standalone cleanup for leftover local OCP test state.

### Fixed

- Pi-bridge tool and catalog compatibility with host-advertised shapes.

## [0.2.2] - 2026-08-12

### Fixed

- OpenCode tool arguments map to per-host Pi schemas before execution.

## [0.2.1] - 2026-08-11

### Changed

- Patch train after the 0.2.0 Pi-bridge introduction.

## [0.2.0] - 2026-08-11

### Added

- Pi-family support via `@opencode-compat/pi-bridge`: load an unmodified OpenCode `aisdk` plugin and register it on pi / oh-my-pi through `pi.registerProvider(...)`.

## [0.1.5] - 2026-08-08

### Fixed

- CodeQL incomplete-sanitization and polynomial-ReDoS findings cleared in bridge paths.

## [0.1.4] - 2026-07-25

### Added

- Native host config path bridging so unchanged plugins resolve cache/data/config/project paths through the host.

### Fixed

- Provider shim writes `ocp-shim-meta.json` beside the package entry for install-tree diagnosis.

## [0.1.2] - 2026-07-20

### Added

- Schema-driven LanguageModel argument-key adoption for provider shims (camelCase / snake_case from advertised tool schemas).
- User-facing install guide and version bump / publish runbook.

### Fixed

- Releases gated on `bun.lock` and packed train dependency pins so workspace protocol cannot leak to npm.

## [0.1.1] - 2026-07-20

### Added

- Public npm publish tooling and Option B LanguageModel adoption for OpenCode-clone hosts.
