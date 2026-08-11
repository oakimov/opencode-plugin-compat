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
