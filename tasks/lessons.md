# Lessons learned

Corrections and durable takeaways for this repo. Per `~/.claude/CLAUDE.md`: capture lessons here after corrections. Hard rules that must auto-load still live in global memory `Rules`; this file keeps the correction story **and** the rule text for local reference.

## 2026-09-21 — omp plan review must block inside `cursor_plan_stage`

- Returning from `cursor_plan_stage` with "write the slug to `xd://propose`" let the model call `plan_exit` instead. That tool answered `Plan mode disabled.` The model then continued the self-test. The plan was visible and nobody was asked to approve or reject it (`/tmp/cursor-ocp-self-verify.log` 19:58:09 stage answer in 31ms, 19:58:37 `plan_exit`).
- The stage tool has to wait on omp's plan-review overlay before it returns. Approve succeeds and queues execution. Refine or dismiss is an error and stays in plan mode. `plan_exit` leaves plan mode; it is not the review.

## 2026-09-21 — A refresh-less credential must be presented long-lived to Pi-family hosts

- **Symptom:** Devin (and any provider whose OpenCode `auth` gives a durable key with no refresh token) showed logged-off every omp/pi restart.
- **Cause:** Pi-family hosts persist `{access, refresh, expires}` and treat `expires` as a hard logout gate — once it passes and there is no refresh token, they drop to a login prompt (omp CHANGELOG: "access-token-only OAuth credentials attempting token refresh with an empty refresh token after expiry"). `toPiCredentials` was stamping a short expiry on refresh-less credentials: `tokenExpiryMs` returns `now+1h` for a non-JWT key (`sk-ws-01-…`, `cog_…`) and the embedded JWT's own short `exp` otherwise. Devin correctly renews a short per-call token *inside* `auth.loader`, so its stored key is long-lived and carries no refresh token.
- **Fix (pi-bridge + mirrored dsh-bridge `opencode/auth.ts`):** a credential with **no refresh token** is presented as long-lived (`NO_REFRESH_CREDENTIAL_TTL_MS`, ~10y); credentials that carry a refresh token keep their real expiry so genuine rotation still fires. This reproduces OpenCode semantics, where the loader (not an expiry clock) governs validity and true invalidity surfaces as a request-time 401 → re-login.
- **Boundary:** fixed entirely in OCP; `cursor-opencode-provider` and `devin-opencode-provider` untouched. Cursor's OAuth method carries a real refresh token (unchanged); its API-key method is refresh-less and is now covered by the same generic rule.
- **Per-host reality:** clones (Kilo/MiMo) persist via OpenCode-native `auth.json` (loader-driven, no expiry gate) — never had the bug. DSH authenticates via native `ctx.credentials` refs and does **not** wire `opencode/auth.ts` at all (that file is currently unused in DSH — a stale mirror of pi-bridge; fixed for parity so a future DSH OAuth wiring does not inherit the trap).
- **Still owed:** interactive acceptance — rebuild pi-bridge `dist`, start stock omp in a TTY, confirm Devin + Cursor stay logged in across a restart (unit tests cannot prove the host's persistence/expiry gate).

## 2026-09-21 — Task Devin self-verify as GetChatMessage Plan mode, not Cursor enter/exit

- Native GetChatMessage has no `CreatePlan` / `SwitchMode` / `plan_enter`. Plan is a **prompted mode**; submit is `exit_plan_mode` (DSH `{plan}`) or, on omp, the plan-review overlay that `cursor_plan_stage` waits on. Cortex/DSH `exit_plan_mode` means **submit**; omp `plan_exit` means **leave**. Using `plan_exit` as submit skips the review UI.
- Waits go through `question` / `ask` / `ask_user_question`, not chat “type continue”. After the helper, end the turn on that ask; do not start the plan submit in the same tool loop.
- omp `plan_enter` is only a host gate so `cursor_plan_stage` can run (`omp plan mode is not active` otherwise). It is not the submit. P2 fails if `plan_enter` ran and `cursor_plan_stage` did not.

**Where:** `docs/guides/devin-ocp-self-verify.md`. Native catalog/prompt: `cursor-mock-server/devin/DEVIN_SYSTEM_PROMPTS.txt` Modes + captured tools; Cortex `CortexStepExitPlanMode`.

## 2026-09-21 — Devin self-verify must name Devin/DSH tools, not Cursor ones

- **`/tmp/devin-ocp-self-verify.log` (DSH `swe-1-6`) failed T2/T4e–f/T7/P1** with a working provider: `grep` and `exit_plan_mode` were advertised and never emitted, `todowrite` ran four times instead of five, helper used `job_output`/`list_agents`/`send_message`.
- **Devin has no `CreatePlan` / `SwitchMode`.** DSH plan review is `exit_plan_mode {plan}` (`packages/dsh-bridge/src/plan-mode.ts`). A prompt that says “plan or mode-switch tools” lets the model skip an “exit” tool.
- **Search is `grep`, not `glob` and not shell `rg`.** Devin guidance already prefers grep/glob over shell (`src/language-model.ts` search bullet); the checklist must require a `grep` emit when that name is listed.
- **Todo 5a/5c/5d/5e/5f are five calls.** 5b is a check. Merging 5e into 5f fails T4.
- **Helper is `subagent`/`task` only** unless the spawn is stuck.

**Where:** `docs/guides/devin-ocp-self-verify.md`.

## 2026-08-22 — DSH is a third host family; do not depend on pi2dsh for OpenCode providers

**Context:** Research for running OpenCode provider plugins on DeepSeek Harness (`dsh`). DSH is Cordis + `ctx.llm.registerAdapter`, not Pi `ExtensionAPI`. Community [pi2dsh](https://github.com/weijiafu14/pi2dsh) (~12k LOC bridge + ~18k vendored Pi) can compose with `@opencode-compat/pi-bridge` for max reach, but abandonment would orphan DSH support if OCP hard-requires it.

**Rule:**

- **DSH OpenCode provider support belongs in an owned `@opencode-compat/dsh-bridge`** (Cordis `LlmAdapter` + shared OpenCode loader patterns). Treat pi2dsh as an optional spike only — never port it (~30k+ LOC) and never put it on the publish train as a required peer.
- **YYTbit `dsh-plugin-*-bridge` packages import skills/config into prompts** — they do not load `@opencode-ai/plugin` providers.
- **Invert [ai-sdk-provider-dsh](https://github.com/krislavten/ai-sdk-provider-dsh) chunk mapping** for V3 → DSH `StreamChunk`; that package drives DSH *as* a model, not providers *into* DSH.

**Where:** `docs/plans/dsh-opencode-provider-bridge-plan.md`, `tasks/dsh-bridge.md`.

## 2026-07-26 — Stale MiMo checkpoint keep-alive filled context

**Correction:** After commit+push `58fdbe4` was already done, the agent kept re-verifying on MiMo checkpoint reinjections (`mid-loop` / `Resume directly…`), which re-armed keep-alives until context forced interrupt/compact.

**Cause:** MiMo host checkpoint-writer lag + continue-loop prompts + agent over-compliance. **Not** OCP. **Not** cursor-opencode-provider.

**Rule (also in global `MEMORY.md` → `Rules` → Checkpoint / keep-alive resumes):**

- Checkpoint reinjections, `mid-loop in an autonomous task`, and `Resume directly… Pick up the last task` are **MiMo host** behavior — not OCP and not cursor-opencode-provider.
- If a resume restates a task that **live state** already completed (e.g. git clean / already pushed), reply at most once that it is done and **stop**. Do not re-run verification tools, re-commit, or re-push from a keep-alive alone.
- Prefer live facts (`git status`, real file state) over lagged checkpoint §5/§9.
- Before idling after a fulfilled request, write a short completion note to session `notes.md` so the next checkpoint is less likely to reopen the task.

**Where:**
| Place | What |
|--------|------|
| `~/.local/share/mimocode/memory/global/MEMORY.md` → `Rules` | Same stop-on-done rule (auto-loaded cross-project) |
| This file (`tasks/lessons.md`) | Correction narrative + rule text (here) |
| Session `notes.md` | Short completion line before idle |
| Project `MEMORY.md` / OCP or provider code | Nothing — wrong layer |

## 2026-08-10 — Pi-family bridge: false-positive resolution test, and adapters for already-standard conventions

**Context:** Built `@opencode-compat/pi-bridge` so unmodified OpenCode plugins run on the Pi family (`pi`, `oh-my-pi`). Several corrections landed during it; each rule below cost a wrong answer first.

**Corrections and rules:**

- **A resolution test whose fixture shares an ancestor with its target proves nothing.** An early test "proved" that installing packages as siblings under a host's plugin dir made bare imports resolve. It didn't — Node/Bun resolve a bare specifier from the importing file's **real** path, not the symlink it was reached through. The fixture happened to sit where the target was reachable anyway. Rebuilt with unique names in genuinely isolated trees and it failed immediately. Isolate the fixture from the mechanism under test, and prefer a test that *can* fail.

- **Before writing an adapter, check whether the ecosystem already standardizes the capability.** Separate `cursor-oauth-adapter` and hand-written model-list glue were built, then deleted: OpenCode plugins already expose OAuth and API-key auth via the standard `auth` hook (`AuthHook.methods[]`) and their catalog via the `config` hook. Reading the plugin's own hooks removed both adapters and made the config one line. A "provider-specific" problem is often a convention nobody read.

- **Don't put provider-specific logic in a compat layer.** A first pass hardcoded Cursor env vars, model fetching, and pricing inside OCP. That inverts the layer's purpose: host/plugin specifics are *data*, the layer is mechanism. Corrected to generic detection + user-supplied config.

- **A fork's API is not its parent's API.** `oh-my-pi` forked `pi`, yet they differ in ways that break code silently: `Context.systemPrompt` is `string[]` vs `string`, dynamic models are `fetchDynamicModels(apiKey)` vs transactional `refreshModels(ctx)`, thinking levels are `thinking.efforts` vs `thinkingLevelMap`, and `oauth.refreshToken`/`getApiKey` are optional vs required. Encode each verified delta as host-profile data; never assume shared ancestry means shared shape.

- **A parameter name is not consistent even within one provider.** Cursor names the reasoning dimension `effort` for Grok but `reasoning` for GPT. Matching only `effort` left every GPT model exploding into up to 12 catalog entries instead of one with an effort picker (180 models where 60 were right). Treat dimension names as a small alias set, and check the actual data distribution before trusting one.

- **A constant value must never enter a generated identifier.** `context` is fixed within each catalog entry (tiers already arrive as separate entries), so folding it into ids produced `-context-272k` noise. Only dimensions that actually vary across an entry's variants carry information.

- **Registering under an id the host already ships silently shadows it.** `registerProvider` has no collision guard, and the Cursor plugin declares provider id `cursor` — which both hosts also ship natively. Derived ids are now de-collided with a logged reason; explicit ids are honored as-is.

- **Renaming an id for the host does not rename it for the plugin.** The plugin reads its options under the id *it* declares (`providerOptions.cursor`), not the de-collided host-facing name. Key pass-through data by the declaring side's id.

- **An optional peer imported at module top level breaks every consumer that lacks it.** The host's `pi-ai` package only exists inside a real host; a top-level import broke tests and the generic loader. Resolve optional peers through a lazy dynamic import at first use.

- **`tsc -b` reuses `.tsbuildinfo`, so a "clean" build can be stale.** A passing typecheck was actually cached output; wiping `dist/` + `.tsbuildinfo` surfaced real errors. Verify a green build from a genuinely clean state before believing it.

- **`*/` inside a block comment ends the comment.** A doc comment containing a path glob silently truncated a module and produced dozens of unrelated syntax errors.

## 2026-08-11 — Provider shims must be backup-free and tested with the host's real tool catalog

- **The instrumented entry is the only active provider file; do not capture or restore a backup.** Setup must deterministically overwrite the generated instrumentation every time while preserving the stock module body. Reverting means rebuilding a local checkout or reinstalling a package from its original source, which restores genuinely out-of-box content instead of an arbitrarily old backup.
- **Use a model that advertises the tools being tested.** MiMo intentionally gives GPT-family models its exception toolset, so a native `read`/`write`/`edit` compatibility smoke test must use `cursor/default`. A missing tool in the model-specific host catalog is not evidence that the provider shim failed.

## 2026-08-11 — Empty arrays under macOS Bash 3.2 and `set -u`

- **Do not expand a possibly empty local array in nounset scripts that must run on macOS Bash 3.2.** `local -a values=()` followed by `"${values[@]}"` can still fail as an unbound variable when the array has no elements. For filesystem globs, enable `nullglob` and iterate the glob directly; always test both populated and zero-match paths under `set -u`.

## 2026-08-11 — Clean reinstall workflows must not restore captured config

- **A clean `@latest` reinstall must rewrite the current plugin fields before invoking the host installer.** Restoring an old config backup can reintroduce pinned versions or local `file://` paths, and the host may immediately rematerialize those stale installs. Preserve unrelated fields in the current canonical config, replace only the selected plugin/provider registration, delete its validated cache targets, and force-install the explicit latest spec.

## 2026-08-11 — OMP subagent completion is a host lifecycle contract

- **A callable `hub` does not prove a bridged subagent can settle.** OMP's `hub` is a built-in tool, not an MCP server. In the failing session it successfully returned job state, but the OpenCode-style provider ended with ordinary assistant text instead of calling OMP's mandatory hidden `yield` tool. OMP then issued three reminders and kept the child alive until its request budget was exhausted. Verify terminal child state and transcript, not a model's claim that a coordination tool is unavailable.
- **Translate lifecycle semantics as well as task argument names.** When a live host requires a terminal result tool, a compatibility bridge must adapt a provider's normal final stop into that tool call. Gate the behavior on host-profile data plus the live catalog, and never synthesize success for empty, errored, truncated, or real tool-call turns.
- **Canonical unstructured results must override specialist schemas.** OMP's bundled `scout` and other specialists may impose structured output, but OpenCode's canonical `task` result is plain text. Passing OMP's unconstrained `outputSchema` override prevents a correctly delivered text result from being reclassified as `schema_violation`.
- **Preserve the initiator of asynchronous custom messages across role-limited protocols, but match the semantic envelope too.** OMP converts custom messages to the Pi `developer` role but retains `attribution: "agent"`. Treating every developer message as system context buried a delivered subagent result while leaving the original request as the provider's newest user turn, so the parent repeated the workflow and spawned duplicate scouts. Conversely, promoting every agent-attributed developer message can demote genuine developer guidance. Promote only OMP's background-job completion envelope; keep every other developer instruction as system context.
- **A translated prompt is not enough for a stateful provider; preserve session affinity too.** Both Pi hosts pass a stable provider `sessionId` in `SimpleStreamOptions`. Dropping it made each asynchronous parent wake look like a fresh provider conversation, whose lossy seed-history reconstruction could re-emit already completed tool calls. Forward the host identity through the namespaced `x-opencode-session` header unless the caller supplied an explicit affinity header; a generic `x-session-id` can have unrelated provider semantics.
- **Strict host schemas need profile-driven spelling aliases at the last boundary.** OMP's hub requires `op`, while an OpenCode-oriented model emitted `action`. Translate declared aliases such as `action` → `op` immediately before host execution, let an explicit native field win, and never weaken the host schema.
- **An opaque provider protocol cannot be repaired after `doStream`.** Cursor's dedicated `list_mcp_resources_exec_args` / `read_mcp_resource_exec_args` requests carry their arguments and correlated result channel inside the consumer provider. If that provider advertises but does not parse them, `pi-bridge` receives only a thrown error—not a tool call or URI. The generic bridge must not guess or vendor provider-specific wire parsing; implement the request/result pair in the provider that owns it.
- **Argument aliases are not enough when host schemas change shape.** Pi's `edit` requires `path` plus `edits: [{ oldText, newText }]`, while OpenCode-oriented models may emit flat `filePath`/`oldString`/`newString`. Keep the host schema strict and convert the complete structure at the final host boundary; renaming only `filePath` leaves Pi's required `edits` field missing.
- **Tool-name aliases must cover the entire round trip.** Pi's optional `find` tool is OpenCode's `glob`; advertising only the translated catalog name is insufficient. Translate the catalog, provider tool calls, tool choices, and stored assistant/tool-result history consistently, and only enable the alias when Pi actually has `find` active.

## 2026-08-13 — Host tool vocabulary: reference table and schema contracts

**Read this before diagnosing any "tool arguments rejected" report.** Every finding below cost a wrong first answer, each from guessing at a host contract instead of reading it. All host sources are public; read them rather than infer.

### Where to verify (upstream host sources)

| Host | Repository | Files that answer tool-schema questions |
|---|---|---|
| OpenCode (reference) | `anomalyco/opencode` | `packages/opencode/src/tool/{edit,read,write,glob}.ts` |
| Kilo | `Kilo-Org/kilocode` | `packages/opencode/src/tool/…` (same layout) |
| MiMo | `XiaomiMiMo/MiMo-Code` | `packages/opencode/src/tool/…` (same layout) |
| oh-my-pi (omp) 17.2.12 | `can1357/oh-my-pi` | `coding-agent/src/edit/{index,hashline/params,modes/replace}.ts`, `coding-agent/src/utils/edit-mode.ts`, `ai/src/utils/schema/wire.ts` (`toolWireSchema`) |
| pi (earendil-works) 0.84.1 | `earendil-works/pi` | `coding-agent/src/core/tools/{edit,find,bash,read,write}.ts`, `ai/src/utils/validation.ts` (the `Validation failed for tool "x"` string), `agent/src/agent-loop.ts` (`prepareArguments` runs **before** validation) |

The consumer plugin under test is `oakimov/cursor-opencode-provider`; it defines no tool schemas and normalizes no arguments, so tool vocabulary always comes from the host, never the plugin.

### Verified vocabulary — the four supported hosts disagree

| Host | edit: path | edit: replacement | bash cwd | Normalization path |
|---|---|---|---|---|
| OpenCode (ref) | `filePath` | `oldString` / `newString` / `replaceAll?` | — | — |
| Kilo | `filePath` | `oldString` / `newString` / `replaceAll?` | — | adapter `canonicalToolKey` |
| MiMo | `file_path` | `old_string` / `new_string` / `replace_all?` | none | adapter `canonicalToolKey` |
| omp | `path` | **mode-dependent** — hashline `{input}` (default) / replace snake_case | `cwd` | `pi-bridge` profile aliases |
| pi | `path` | `edits: [{oldText, newText}]` | none (session-level) | `pi-bridge` profile aliases |

Consequences worth remembering:

- **Kilo is OpenCode-identical; MiMo is not.** MiMo forked the whole essential toolset to snake_case. Any claim that "no host uses snake_case" is false.
- **The clone path already handles case/separator drift generically**: `canonicalToolKey` (`packages/adapter/src/language-model.ts`) strips non-alphanumerics and lowercases, so `filePath` and `file_path` both become `filepath` and align to whatever the host advertised. `pi-bridge` has **no** such normalizer — its aliases are hand-maintained, and only they cover true renames (`filePath`→`path`, `workdir`→`cwd`) that canonicalization cannot express.
- **A model may carry any sibling host's vocabulary into any other host.** Treat that as ordinary drift, not a malformed call.

### Corrections

- **Verify a host quirk in host source before encoding it as profile data.** A provider echoing an `i` key alongside OMP hashline edit input looks like a schema violation, but omp 17.2.12 `edit/hashline/params.ts` is deliberately permissive (extra keys allowed, only `input` required) and its executor destructures `input` alone — and `edit` has no argument-repair path (only `todo` repairs a missing `op`). Stripping `i` is defensible hygiene, not a fix for a validation error; do not document it as the latter.
- **Check the whole supported matrix before calling a vocabulary hypothetical.** Snake_case reaching a Pi session was dismissed as speculative — "no host emits it" — and the reasoning was wrong: per the table above, two of the four do. The dismissal nearly shipped a live gap, because `pi-bridge`'s edit conversion accepted `oldText`/`oldString` but not `old_string`, so a model carrying MiMo or OMP-replace vocabulary hit the very `edits: must have required properties edits` failure the conversion exists to prevent. A conversion that already accepts two spellings of a field is evidence the field drifts; enumerate every supported host's spelling rather than arguing from one convention.
- **Overriding an advertised schema creates a return trip.** `pi-edit` tools are advertised to the provider as OpenCode's flat contract while executing pi's nested `{path, edits}`. The forward path was translated but stored history was replayed verbatim, so the model saw prior calls in a shape its own `additionalProperties: false` catalog did not declare. Wherever the bridge advertises something other than the host's own schema, translate the replay too — and where the advertised contract cannot express the host value (multi-edit), keep host shape rather than dropping data.
- **A host tool name is not a host tool schema.** OMP's `edit` resolves one of four modes per session *and per model* (`utils/edit-mode.ts`), each advertising its own parameters; the profile's replacement aliases describe `replace` only, while the default is `hashline`. Gating an alias set on the tool being *live* is not enough when the live tool is polymorphic — gate it on the advertised schema, via the same `toolWireSchema` the model is shown. Fail open only when *no resolver is supplied at all* (tested); once a resolver is given, an unreadable or property-less result must fail **closed** — treating "can't confirm" as "confirmed" reapplies a mode-specific alias set under a mode that was never verified, reproducing the exact bug the gate exists to prevent. Note which rules are mode-independent (`dropInputKeys`) and keep those unconditional regardless of either fail direction.
- **Do not advertise a provider-facing field the host cannot execute.** The pi `edit` contract offered `replaceAll`, but pi 0.84.1 `edit-diff.ts` throws a duplicate-match error whenever `oldText` occurs more than once — there is no replace-all path to map onto, and the bridge was silently dropping the flag. Under `additionalProperties: false` the advertised schema *is* the contract; keep it to what the host can honor and state the host's real constraint (`oldString` must match exactly once) in the description.
- **A vocabulary that restates a profile type will drift from it.** `buildPiToolInputVocabulary` copied `PiToolInputProfile` field-by-field into a duplicated inline type, so every new profile field needed three coordinated edits and the coordination-tool merge silently dropped the ones it did not name. Carry the profile entry verbatim and merge with a spread.

## 2026-08-13 — A truthy `[]` and a discarded `[]` are two different bugs, from the same line

- **`if (x)` is not `if (x is meaningful)`.** pi 0.84.1's `provider-composer.ts:492` applies a refreshed catalog with `if (refreshed)` — a plain truthiness check, and `[]` is truthy in JS. A technically-successful fetch that resolves to zero models (cold config map, an unauthenticated call that resolves instead of throwing) was therefore replacing an already-populated catalog, and `pi-bridge` was also *persisting* that empty result, corrupting the next cold-start restore too. The existing `allowNetwork === false` cache-only guard didn't cover this — it's a different branch, reachable only when the network call itself "succeeds." Fixed by refusing to replace or persist an empty result over a non-empty stored catalog; an empty result with no prior cache still passes through (nothing to protect).
- **A side effect's failure is not the primary result's failure.** `context.publish()` (persisting to disk for the next process) and returning the freshly-fetched list (this session's in-memory catalog) are two separate outcomes sharing one function. An unguarded `await context.publish(...)` meant a persistence error discarded a *successful* network fetch, because `provider-composer.ts` only assigns `refreshed` after that await resolves — the whole `refreshModels()` promise rejects, and the caller's `errors` map records a failure for a call that actually got the model list right. Wrap only the side effect; let the primary result stand on its own success.
- **Pi's `edit` schema will store what its own validation lets through, not what the tool's executor reads.** pi's `editSchema` doesn't set `additionalProperties: false`, so a model attaching an extra field (`explanation`, anything) validates, executes (the executor only reads `path`/`edits`), and lands verbatim in stored call history. `translateHostToolCallInput` spread `...rest` from that stored input when replaying it in the *advertised* flat contract — which **is** `additionalProperties: false` — so the extra key silently violated the schema the model was just shown. When rehydrating a call into a contract stricter than the one that produced it, enumerate the declared output keys explicitly; never carry forward "whatever was left."
- **An extension API surface can make a "confirmed bug" unfixable without a rewrite of scope.** `activateOpenCodeSearchTools` treats `getAllTools()` (all *registered* tools) as if it were the permitted set, so it can re-activate `find`/`grep`/`ls` even when a user's `--tools` explicitly excluded them — confirmed by reading pi's own `sdk.ts`/`agent-session.ts`. But pi's `ExtensionAPI` (`core/extensions/types.ts:1337-1343`) exposes only `getActiveTools()`/`getAllTools()`/`setActiveTools()` — nothing that distinguishes "off by explicit `--tools` restriction" from "off because these three are registered-but-inactive by pi's own default," which is the *normal*, far more common case this function exists to fix. Left unfixed rather than guess at a heuristic (e.g. sniffing `process.argv`) that risks regressing the documented default-activation behavior for a rare case with no reliable signal to detect it. A confirmed gap is not always a safely-fixable one — check whether the host API can even express the distinction before writing the fix.

## 2026-09-19 — OMP todo completions need fan-out, not open-only init

- **omp `todo` is one op per call; `init` always creates pending rows.** OpenCode
  / Cursor `todowrite` is a full `{todos:[{content,status}]}` snapshot. Folding
  every snapshot into `init` of remaining open items (dropping `completed` /
  `cancelled`) made creates work and left completions stuck as pending — the
  host never saw a `done`. Snapshots with terminal statuses must fan out
  `init` (full content list) → `done`/`drop` per terminal row → `start` for the
  active row, under `#0`/`#1`/… call ids, and history must fold those back into
  one canonical `todowrite` for the provider on the next turn.
- **Do not patch omp for this.** Compatibility translations belong in
  `pi-bridge`; host checkouts are read-only evidence only.
- **cursor-opencode-provider merge expansion is necessary but not sufficient on
  omp.** The provider already expands Cursor `merge: true` patches into a
  replace-all `todowrite`; without the pi-bridge fan-out above, that full
  snapshot still cannot express `completed` on omp.

## 2026-09-20 — Devin self-verify needs Cursor-shaped debug markers

- Shared scoring prefixes (`outbound Run:`, `extractTools:`, `EMITTED
  tool-call`, `turn usage validation:`, `cache diagnosis:` /
  `perModelCallCache=unavailable`) live in `devin-opencode-provider` debug
  traces. Field values must be Devin wire facts (`prefixHash`, not a fake
  RequestContext). Guide:
  `docs/guides/devin-ocp-self-verify.md` (`DEVIN_PROVIDER_DEBUG_FILE`).

## 2026-09-20 — Self-verify: missing EMITTED ≠ tool fail after log reinit

- Live run `01a0bec1-1189…`: host transcript had `ask`/`todo` fan-out/`task`
  under `cursor_1b9e4883-…_25`–`_37`, but `/tmp/cursor-ocp-self-verify.log`
  restarted at `12:19:28` (same pid, second `--- cursor-provider debug` header)
  so only hub `_39` survived. Model scored T3–T5 failed for “never EMITTED”.
- Real fail on that run under the old rule: MCP shopping (T2/T7). Shell
  `workdir`/`pwd` OK. **Updated rule:** MCP/dynamic **browse** alone is not a
  fail when exercise work still used the advertised catalog; fail only on
  **substitute** (different API/tool set for the step).
- Guide: host post-OCP names (`ask`/`todo`) count equal to advertised
  (`question`/`todowrite`); multi-header / `reinit=append` → prefer transcript
  for T3–T5. Provider: debug re-init appends, does not truncate existing file.

## 2026-09-20 — Self-verify: MCP browse ≠ fail when tools unchanged

- User correction: opening `get_mcp_tools` / dynamic catalogs is fine if the
  session tool set for exercises does not change. T2/T7 fail only when the
  model **substitutes** an MCP/dynamic tool for an advertised catalog tool
  (`question`, `todowrite`, `bash`, …).

## 2026-09-20 — Self-verify mid-stop after step 7 + hub wait interrupt

- Live `01a0bee1-ac9f…` (entry `execute tests in …md`): steps 1–6 mostly OK;
  after human `continue`, model sent step-7 ack with `stopReason=stop` and
  never started 8–10 (“Next I’ll run plan…”) — over-read “no tool calls” as
  end-of-turn. Earlier: `task` spawn said auto-deliver, model still `hub wait`
  → provider `continuation: interrupted trailing tool result` /
  `conversation reset: interrupted-run` + re-read guide mid-run.
- Guide: step 7 = short no-tool ack then **immediately continue 8–10 same
  turn**; step 6 = no `hub` wait unless stuck; execute-this-file entry uses
  Agent prompt only; do not re-open guide mid-run.

## 2026-09-20 — Self-verify: wrong Cursor names / MCP loops / lifecycle replay = fail

- Live run `01a0beb5-ce49…`: model hunted Cursor `AskQuestion` while
  `extractTools` listed `question`; planned T3 skip; still called `ask` later;
  ran ocp-sv T4 lifecycle twice after `conversation reset: interrupted-run`;
  opened `get_mcp_tools` ~18×; self-scored `verdict: pass`.
- Guide: session catalog names win over IDE names; MCP **substitute** (not
  mere browse) is fail; `skipped` only if capability absent from `extractTools`
  for the scored session; T4 once; T7 bans confused self-pass.
- OCP: `question` description names the tool and forbids AskQuestion/MCP
  substitutes; `translateTools` omits host `yield` (terminal-result shim) so
  catalogs do not look like subagent surfaces.

## 2026-09-20 — Bash must advertise OpenCode `workdir`, not host `cwd` prose

- Host bash.md buries "Set `cwd` instead of `cd`" among mkdir/`&&`/NEVER-ls
  rules. Live self-verify (`01a0bea8-d2cb…`): model sent only
  `mkdir DIR && pwd` / bare `pwd` (provider `inputLen` matched those payloads,
  not a directory field). It then claimed "cwd ignored".
- cursor-opencode-provider `mapCursorArgsToOpencode` bash case forwards only
  `workdir`/`working_directory` — host-schema `cwd` would be dropped before
  OCP even if the model followed omp's field name.
- Fix: `inputShape: "opencode-bash"` advertises `workdir` + a lead-in
  description that forbids path-only-in-command; aliases still map to host
  `cwd`; history reverses `cwd`→`workdir`.

## 2026-09-20 — `mkdir … && pwd` is not a cwd test

- Models report “shell ignores cwd” after `mkdir /tmp/… && pwd`, which
  correctly prints the session project dir because mkdir does not change
  process cwd. The false-alarm transcript showed every bash call used
  `{command}` only — no `cwd`/`workdir` key.
- The same host had previously honored
  `{command:"pwd; ls -la", cwd:"/tmp/ocp-self-verify"}` and returned
  `/tmp/ocp-self-verify`.
  OCP `workdir`→`cwd` alias is covered by unit tests; do not “fix” host bash.
- Self-verify shell step must require the schema’s working-directory field
  plus bare `pwd`, and fail if stdout is still the project dir.

## 2026-09-20 — Self-verify prose must not teach vocabulary archaeology

- **Tell the model what to do, not what the bridge is called.** Phrases like
  “OpenCode snapshot”, “ops-based”, “canonical”, “OCP remapped”, or “exercise
  the MCP path” make the model compare description vs schema and shop for
  alternate tool catalogs. Say: use the tools already in this session; copy
  each tool’s schema keys; for todos send the full `{todos:[{content,status}]}`
  body given in the step.
- **When the bridge rewrites a tool schema, rewrite its description too.**
  omp `todo` prose still describes `op: init|done|…` while the catalog shows
  OpenCode `todos[]` — models stall on the mismatch. `translateTools` must
  ship matching OpenCode write/read descriptions with `opencode-todo`.

## 2026-09-20 — Shared self-verify must key off advertised tools, not OpenCode-only names

- **Equal scoring ≠ identical tool spellings.** dsh advertises `todo_write` /
  `ask_user_question` / `subagent` / `file_path` and has no `cancelled` status;
  pi-bridge remaps omp to `todowrite`/`todoread`. A prompt that requires
  OpenCode names only forces T4\* skips on dsh and fails the “same exercises on
  every host” claim. Prefer remapped OpenCode names when present; otherwise use
  the host snapshot/spawn tool; cancel via `cancelled` or omit-from-replace;
  launch `dsh web` with debug env on the server process.

## 2026-09-20 — Write/read vocabulary drift causes reject→retry loops

- **`contents` / Cursor `file_text` are not omp's `content`.** Without inbound
  aliases a write arrives as `{path}` only; ArkType rejects and the model
  retries with the right key. Alias sibling spellings in the host write profile.
- **Semicolon-joined absolute paths are one missing file to the host (and to
  Cursor's pre-exec reject).** Fan absolute `;`-joined reads into one host call
  per segment under `#N` ids. Do not collapse non-todo `#N` fan-outs in history
  the way todo ops collapse — that would erase paths into an empty todowrite.
- **Schema copy is cheap prevention.** Advertise read `filePath` as exactly one
  path and forbid joining with separators so the model is less likely to emit
  the joined form that never reaches the bridge when the provider rejects first.

## 2026-09-20 — DSH CreatePlan ack: advertise `question`, not only `ask_user_question`

- Live `/tmp/cursor-ocp-self-verify.log` (`2026-09-20T17:53:26Z`): SwitchMode
  `plan` was provider-owned fallback (`no host plan tool`); CreatePlan
  `outcome=acknowledged`. Advertised tools were `ask_user_question` /
  `todo_write` / `exit_plan_mode`. The provider’s CreatePlan approve path
  requires `names.has("question")`; display todos prefer `todowrite`.
- **Do not rename `exit_plan_mode` to `plan_exit`.** Host schema is
  `{plan: markdown}` and the tool fails outside DSH `/plan`. Empty OpenCode
  `plan_enter`/`plan_exit` would miss `plan` and never open the native review.
- **dsh-bridge `providerName`:** `ask_user_question` → `question` (canonical
  schema, fill `id`, `multiple` → `multi_select`); `todo_write` → `todowrite`.
  After restart, CreatePlan in provider-owned plan mode emits the host question
  tool so a review UI actually appears.

- **Cursor `todowrite` always carries `id`/`priority`.** DSH `todo_write` items
  are `{content,status}` with `additionalProperties: false`
  (`packages/todo/tool-todo/src/index.ts:154`). Name remap alone still rejects
  `todos[0].id`. Strip extras on ingress; omit `cancelled` (DSH has no such
  status — cancel is drop-from-snapshot).
- **`exit_plan_mode` is advertised while inactive** and throws until a
  `plan/mode` event is logged. Same-turn `planMode.set()` only queues. Append
  `plan/mode {active:true}` in `tools/execute` before dispatch so step-8
  “submit a plan” opens the native review instead of
  `Error: exit_plan_mode is only available in plan mode`.
- **Register that wrapper on the plugin `ctx.on`, not `inject(["planMode"])`.**
  The llm-adapter fiber never sees `planMode`, so the inject callback never
  ran and the live 18:32 UTC run still got the 52-byte throw
  (`/tmp/cursor-ocp-self-verify.log`). Unscoped `ctx.on` listeners receive
  agent-scoped `tools/execute` (`packages/core/scope/src/index.ts:176`).
- **DSH `ask_user_question` results are JSON**, not OpenCode
  `"<prompt>"="<answer>"` prose
  (`packages/interaction/tool-ask-user/src/index.ts:93`). Cursor
  `createPlanApproved` / `switchModeResultFromQuestionOutput` treated a
  user **Yes** as unanswered → rejected, so the model assumed plan rejection
  and asked again. Rewrite the result in dsh-bridge history and parse JSON
  in the provider (match by id, then index — DSH fills `q1` while the
  provider item is `create_plan_approval`).
- **CreatePlan Yes still needs a host kickoff.** After approval the provider
  calls `client.session.promptAsync` (`plugin.ts:90`). The DSH stub used to
  throw the copied Pi-family "does not emulate" error
  (`/tmp/cursor-ocp-self-verify.log` 18:49:47Z), so the turn ended idle.
  Map that call to `agent.followup` (next-turn + wakeup). Do not await
  `whenIdle` — kickoff runs inside the current generate.
- **DSH generic questions never show the plan.** `ask_user_question`
  execute() forwards only `id`/`question`/`header`/`options`/`multi_select`
  (`packages/interaction/tool-ask-user/src/index.ts:82-88`). `detail` and
  `intent: plan-review` are dropped, so the UI is Yes/No plus
  `_Plan saved to …`. Native review is `exit_plan_mode` with `{plan}`
  (`packages/plan/plan-mode/src/index.ts:302-316`). Rewrite CreatePlan
  approval (`Plan at … start implementing`) to that tool; keep SwitchMode's
  `Planning is complete…` as `question`. Do not put the plan in OpenCode
  `question` text (TUI dock is `flexShrink={0}`).
- **A helper `send_message` plus DSH `subagent-settled` is two generates.**
  Session `session-e0874de6` turn 2: seq 140 `agent-message` relay → “Please
  send `continue`”; seq 146 `subagent-settled` next-step → “Helper result is
  already recorded…”. Same child, same closing text, two banners. DSH keeps
  both kinds in history on purpose (`continuation-messages.ts`). After the
  model has already replied to that child's relay, dsh-bridge finishes the
  settled generate with no text instead of calling Cursor.
- **A later child's `send_message` still starts a wait banner.** Session
  `session-e3886734` turn 1 already asked for `continue` (seq 154, after the
  first helper's relay+settled were claimed behind a spawn tool-call). Turn 2
  seq 161 is a *second* helper `agent-message` → “Still waiting on your short
  follow-up…”. Settled skip did not apply (different child, last user was
  relay not settled). Skip every child notice after a **text-only** stop;
  keep generating when the last assistant still has a tool-call.
- **Step-8 plan review asked twice.** Session `session-e000bd48` turn 2: seq
  141 `exit_plan_mode` (scratch-hello-append) → user approved; seq 150–151
  helper `agent-message` + `subagent-settled` claimed on the next step →
  seq 153 a *second* `exit_plan_mode` (ocp-scratch-append). Cursor
  continuation only matches a prompt that *ends* on tool results
  (`extractTrailingToolResults`). Trailing child user notices made it a
  fresh Run, so the first pending CreatePlan never got
  `continuation: wrote create_plan answer` and the model submitted again.
  Omit those notices after a plan-approval tool so the prompt still ends
  on the tool result. Also drop `renderPlanReviewMessage` text once the
  call is rewritten to `exit_plan_mode` — the native panel already shows
  `{plan}`.

## 2026-08-25 — Pricing gate before every release

- **A host invoking post-login model refresh does not make that refresh authenticated unless the bridge consumes the supplied credential.** Both Pi-family hosts automatically refresh after successful login, but `pi-bridge` previously accepted the resolved key and then discarded it when re-running the plugin `config` hook. A fresh install therefore had neither a model cache nor OpenCode's auth file and could remain empty after login. Seed the plugin stub with the complete login credential, and on later host-driven refreshes run `auth.loader` with the resolved credential before harvesting `config.provider[id].models`.
- **Pi's cache-only model refresh is replacement semantics, not a no-op.** During startup Pi calls an extension's `refreshModels` with `allowNetwork: false`, then replaces its live catalog with the returned array. Returning `[]` discards the model that session restoration is trying to resolve, producing a fallback warning even though the background network refresh later makes the model selectable. Return `context.stored.models` (or the registration baseline) offline, and persist successful network refreshes with `context.publish({ persist })`.
- **A translated tool name still needs a live host executor.** Pi keeps optional built-ins `find`/`grep`/`ls` registered but inactive by default. Advertising OpenCode's `glob` without activating Pi's `find` makes the model call a tool that Pi rejects; enable the available built-ins on `session_start`, while respecting any explicit host allowlist, then translate `find` ↔ `glob` at the provider boundary. Do not implicitly activate arbitrary extension or MCP tools.

## 2026-08-15 — `omp plugin list --json` can hang; uninstall is enough

- **Do not probe presence with `omp plugin list --json` before uninstall.** `ocp-dev.sh unshim` appeared to hang on pi because the hosts loop reaches omp and `pi_family_dev_omp_remove_if_present` blocked forever on `plugin list --json` (lock contention / hung CLI). `omp plugin uninstall <pkg>` is idempotent for missing packages (exit 0), so remove helpers should uninstall directly and treat not-installed wording as success — same shape as `pi_family_dev_pi_remove_if_present`.

## 2026-09-21 — Catalog sort matches the provider wire

- **UTF-16 code-unit order, not `localeCompare(..., "en")`.** English
  collation and code-unit order diverge on mixed case (`apple` vs `Zebra`).
  Cursor hashes whatever the provider emits (code-unit). Overlay translation
  must use the same comparator or the two layers disagree on catalog bytes.

## 2026-08-16 — Extension self-reference beats source-module imports

- **Do not import omp internals from the plugin checkout to find live state.** The bundled `omp` process loads its own `@oh-my-pi/pi-coding-agent` graph from `dist/cli.js`; an extension loaded from `pi-bridge` can resolve a source `agent-registry.ts` that looks identical but has a different module graph/singleton in the running process. The failure appears as an empty registry and misleading “no live AgentSession” errors.
- **Use omp’s injected `ExtensionAPI.pi` namespace.** It is the loader’s runtime self-reference (`import * as PiCodingAgent from "../../index"`), so `pi.AgentRegistry.global()` is the exact singleton used by `createAgentSession`. Pass that namespace through the bridge’s host-tool binder; retain the CLI-path import only as a fallback for older hosts.

## 2026-08-16 — Do not steer omp while a Cursor SwitchMode continuation is held

- **A native host-mode context steer can supersede the provider's held Run.** Cursor SwitchMode is an interaction query: the provider emits `plan_enter` and holds the Run until the host tool returns `approved{}`. Calling omp `sendPlanModeContext({ deliverAs: "steer" })` from that tool starts a new provider turn while the old Run still has the pending interaction. The provider then closes the old session as `superseded-by-new-run`; the new Run replays the same SwitchMode request, producing an apparent `plan_enter` loop and repeated `Already in plan mode.` results.
- **For this bridge, mutate native plan state only.** The provider injects its Cursor mode reminder after it delivers the approved continuation, so the omp custom plan-mode message is redundant and unsafe in this path. Keep `sendPlanModeContext` available for other integrations, but do not call it from `enterOmpPlanMode`.

## 2026-08-16 — Internal provider interactions must still satisfy host lifecycle tools

- **A provider-internal tool is invisible to host settle enforcement.** Cursor CreatePlan wrote a valid detached markdown file and acknowledged its InteractionQuery, but the AI SDK stream exposed no host tool call. omp therefore saw a tool-less plan-mode turn, injected its mandatory `ask`/`write xd://propose` reminder, and Cursor repeated CreatePlan. When a host mode defines a terminal decision tool, bridge the provider interaction into that real tool lifecycle rather than merely reproducing its filesystem side effect.
- **Plan storage and plan submission are separate contracts.** omp requires a session-local `local://<slug>-plan.md` artifact *and* an ordinary `write xd://propose` call whose result metadata drives the review UI. Writing `<worktree>/.omp/plans/*.md`, or mirroring CreatePlan into `todo`, satisfies neither native approval nor the host's convergence detector.

## 2026-08-16 — Session state and UI state must converge before native review

- **Entering omp plan mode through `AgentSession` is insufficient when the review UI gates on `InteractiveMode`'s private flag.** The plan guard, context, and proposal handler all accepted the bridge-entered session state, but `handlePlanApproval()` rejected it as inactive. That prevented the existing silent abort/review overlay from owning the post-proposal turn, so Cursor's empty continuation triggered generic retry recovery and repeated CreatePlan.
- **Cross-boundary mode state must carry its restoration data.** pi-bridge removes `plan_enter` from the active catalog while planning, but omp's native approval normally restores tools from a private snapshot the bridge cannot populate. Store the pre-plan catalog in `PlanModeState`, let the native lifecycle fall back to it, and keep refinement in the same plan state. The provider must likewise clear its plan reminder only after observing the bridge-specific `plan_enter` absence/restoration transition.
- **Adjacent MCP startup failures are not automatically causal.** The Brave MCP connection timed out in the same live run, but no MCP tool participated in the loop and every plan tool result succeeded. Correlate errors to the failing lifecycle before expanding the fix.
- **The only valid completion proof for an interactive lifecycle is the interactive lifecycle.** After moving review into pi-bridge's extension UI, the first live run proved approval stopped the CreatePlan loop but exposed a second defect: a synthetic developer follow-up made the model ask for approval again. A second live run with a user-attributed execution follow-up performed `plan_exit`, wrote the requested file byte-for-byte, and ended with no empty-stop retry. Unit tests did not reveal either behavior.

## 2026-09-21 — DSH ocp-dev wires Cursor and Devin together

- **`cordis.patch.yml` `providers[]` is a list.** Cursor-only ocp-dev
  overwrote that list on every `run dsh`, so a hand-added Devin row
  would not survive. Local mode now appends the sibling
  `devin-opencode-provider` (or `$OCP_DEV_DEVIN_PROVIDER_PATH`) with
  `DEVIN_API_KEY`.
- **DSH reserves `devin`.** The OCP plugin registers as `devin-opencode`.
  Export `DEVIN_API_KEY` on the DSH process; path-bridge `globalDataDir`
  is `~/.dsh`, not OpenCode `auth.json`.

## 2026-08-15 — omp SwitchMode needs the *host* `AgentRegistry` singleton

- **`plan_enter` advertised ≠ plan mode bound.** `/tmp/omp-plan-test.log` showed SwitchMode bridged to `plan_enter`, but the tool returned `isError` *"no live AgentSession is registered yet"*. Advertisement was fine; `bindOmpPlanModeHost` never saw the live Main session.
- **Bare `import("@oh-my-pi/pi-coding-agent")` from pi-bridge fails.** Coding-agent is not a pi-bridge dependency, so the dynamic import returns nothing / throws and the binder returns `undefined` — which surfaces as that exact error string.
- **`createRequire(cli).resolve(packageName)` also fails** — the CLI cannot self-resolve its own package name. Walk from `process.argv[1]` (omp → `…/pi-coding-agent/dist/cli.js`) to the package root whose `package.json` `name` matches, then `import(pathToFileURL(…/src/registry/agent-registry.ts))`. Relative, absolute file-URL, and package-main imports of that module share one `AgentRegistry.global()`.
- **Rebuild `packages/pi-bridge/dist` before live omp retests** — omp loads `./dist/extension-omp.js` via the checkout symlink under `~/.omp/plugins/node_modules/@opencode-compat/pi-bridge`. Source-only fixes do not take effect until `bun run build`.
