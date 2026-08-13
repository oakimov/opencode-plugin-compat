# Lessons learned

Corrections and durable takeaways for this repo. Per `~/.claude/CLAUDE.md`: capture lessons here after corrections. Hard rules that must auto-load still live in global memory `Rules`; this file keeps the correction story **and** the rule text for local reference.

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

## 2026-08-13 — Dynamic catalog refresh must drive the plugin auth loader

- **A host invoking post-login model refresh does not make that refresh authenticated unless the bridge consumes the supplied credential.** Both Pi-family hosts automatically refresh after successful login, but `pi-bridge` previously accepted the resolved key and then discarded it when re-running the plugin `config` hook. A fresh install therefore had neither a model cache nor OpenCode's auth file and could remain empty after login. Seed the plugin stub with the complete login credential, and on later host-driven refreshes run `auth.loader` with the resolved credential before harvesting `config.provider[id].models`.
- **Pi's cache-only model refresh is replacement semantics, not a no-op.** During startup Pi calls an extension's `refreshModels` with `allowNetwork: false`, then replaces its live catalog with the returned array. Returning `[]` discards the model that session restoration is trying to resolve, producing a fallback warning even though the background network refresh later makes the model selectable. Return `context.stored.models` (or the registration baseline) offline, and persist successful network refreshes with `context.publish({ persist })`.
- **A translated tool name still needs a live host executor.** Pi keeps optional built-ins `find`/`grep`/`ls` registered but inactive by default. Advertising OpenCode's `glob` without activating Pi's `find` makes the model call a tool that Pi rejects; enable the available built-ins on `session_start`, while respecting any explicit host allowlist, then translate `find` ↔ `glob` at the provider boundary. Do not implicitly activate arbitrary extension or MCP tools.
