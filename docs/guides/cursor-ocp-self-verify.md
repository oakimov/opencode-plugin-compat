# Cursor + OCP self-verify prompt

Live check that Cursor models work on a stock host (native OpenCode, or
another harness through OCP). The usual
user message is along the lines of `execute tests in
docs/guides/cursor-ocp-self-verify.md`. The agent should follow only the
**Agent prompt** checklist below (ignore Operator setup while executing).

Same capability-based exercises on OpenCode 1.x / 2.0, MiMo, Kilo, Pi, OMP,
and DSH. Harness-specific rows apply only when their stated capability is
present. Unit tests are not evidence.

## Operator setup

Do this before the agent runs. Not part of the agent checklist.

1. Wire non-OpenCode hosts from this repo:

   ```bash
   ./scripts/ocp-dev.sh run <host>          # local OCP + local provider
   ```

   Hosts: `mimo`, `kilo`, `pi`, `omp`, `dsh`. Confirm the slot with
   `.claude/skills/ocp-dev/SKILL.md` and
   `.claude/skills/ocp-dev/references/hosts.md` before starting the session.
   OpenCode 1.x / 2.0 loads the provider natively: configure the appropriate
   provider entrypoint from its install guide. Do not run OpenCode through
   `ocp-dev`.

2. Start the **stock** host with debug logging. Use a throwaway workspace, not
   this repo and not the provider checkout. Export the env on the **same
   process** that loads the Cursor provider:

   ```bash
   export CURSOR_PROVIDER_DEBUG=1
   export CURSOR_PROVIDER_DEBUG_FILE=/tmp/cursor-ocp-self-verify.log
   ```

   Then launch, for example:

   | Host | Typical launch |
   |---|---|
   | `opencode` / `mimo` / `kilo` | stock CLI in a TTY |
   | `pi` / `omp` | stock CLI in a TTY |
   | `dsh` | `node <deepseek-harness>/apps/cli/lib/bin.js web` (browser UI; env must be on that server process). Do not use checkout `pnpm dsh web` (`tsx` source launcher) — it dual-loads `dsh-tools` and every tool dies on `prepare`. |

   The provider prints `[cursor-provider] CURSOR_PROVIDER_DEBUG logging to …`
   on first use. If the file path differs, tell the agent that path in the
   first user message.

3. Select a Cursor model. Stay in one session for the whole run.

   Before the agent starts, truncate the debug file once:

   ```bash
   : > /tmp/cursor-ocp-self-verify.log
   ```

   Do **not** rebuild/relink the provider, restart the host, or clear the log while
   the agent is mid-run. Provider re-init appends (`reinit=append`); a mid-run
   restart still breaks warm-cache checks (L3). The log size-caps at 10 MiB
   (`size-cap truncate`).

4. After the agent finishes, keep `/tmp/cursor-ocp-self-verify.log` (or the
   announced path). Do not restart the host until the report is written.

Interactive items that need a human (plan approve / refine / dismiss, mode
switch confirmation, question answers) stay with the operator. The checklist
tells the agent to pause and wait rather than invent a click.

Provider-maintained interactive checklist:
[cursor-opencode-provider/docs/host-compat-acceptance.md](https://github.com/oakimov/cursor-opencode-provider/blob/main/docs/host-compat-acceptance.md).
Log field meanings:
[cursor-opencode-provider/docs/cache-log-runbook.md](https://github.com/oakimov/cursor-opencode-provider/blob/main/docs/cache-log-runbook.md).

---

## Agent prompt

When asked to run / execute this guide, do **only** the checklist below. Skip
Operator setup. Read the complete Agent prompt at the start. If a read is
truncated, finish the missing ranges or use its full-output artifact before
starting. Completing a truncated read is allowed. Keep the checklist and
scoring rules in context; do not re-read completed sections mid-run.

---

Please run a quick end-to-end check that this session’s tools and the Cursor
provider debug log are working. Do the steps in order in **this same
session**. Choose tools by the capabilities and schemas actually advertised in
this session, not by guessing what this host usually calls them. Prefer a
dedicated file/search/list/question/todo/helper tool over a shell substitute;
use the shell for the explicit shell check or only when no dedicated capability
exists. Copy argument names from the chosen tool's own schema. Never call a
tool name merely because this guide or another harness mentions it.

**Optional capabilities must not abort the run.** Ask, full-list todo, helper
agent, and plan/mode are optional per host. If the **host tool catalog** does
not list that capability, or a Cursor-native call for it is refused because no
host executor is advertised, mark the matching score row `skipped` and
**continue the next step immediately**. Do not stop early, do not fail the
whole checklist, and do not retry the refused name. Steps 7 and 10 are always
required when earlier optional steps were skipped.
**When the host catalog does list the capability, you must exercise it** — do
not skip an advertised ask / todowrite / task / plan tool.
**Plan/mode exception:** Cursor-native SwitchMode/CreatePlan without a host
plan tool or host review UI is not a completable capability — skip P1/P2
instead of entering plan and waiting forever.

Stay under an identity-free scratch directory you create (for example
`/tmp/ocp-cursor-self-verify/`, with a random non-identifying suffix if needed).
Do not edit this repo, the host source, or the
provider checkout. When the UI needs a human choice, stop and wait — then
resume the **next unfinished** step (do not restart finished work). Host aliases
are expected: score the capability exercised, not one spelling of its name.
Cursor-native interactions may not appear as ordinary catalog tools; use them
only when the selected Cursor model actually makes them available **and** a
compatible host executor (or bridged interaction named in this guide) exists.
A Cursor-native Task/Ask/todo chrome alone is not enough when the host catalog
has no matching tool — that path will be refused; skip that row instead.

Do not print tokens, credentials, cookies, real session ids, user names, home
directories, or private checkout/workspace paths. When citing a transcript or
debug line, cite its line number/event and replace local roots with generic
labels such as `<home>`, `<workspace>`, and `<provider-checkout>`.

### Debug log (one policy)

Default path: `/tmp/cursor-ocp-self-verify.log` (or whatever the operator named).

1. **Once at the start:** confirm the log exists with a tiny check only, e.g.
   `test -s "$LOG" && rg -n '^--- cursor-provider debug' "$LOG" | head`.
   If there is no header, stop and report `blocked: no debug log`.
2. **During steps 1–9:** do not open, read, or search the debug log. Work from
   tool results and the on-screen transcript only.
3. **Only in step 10:** run the filter below **once**, cite matching lines in
   the score table, and do not paste the whole log into chat.

Filtered extract (step 10 only):

```bash
# LOG is the announced log path; SCRATCH is the directory from step 1.
rg -n \
  -e 'outbound Run:|hash requestContext|turn usage validation:|cache diagnosis:' \
  -e 'extractTools:|EMITTED tool-call|debug: enabled file=|reinit=append' \
  -e 'size-cap truncate|buildEnv:|binary write STAGED|image save: wrote' \
  -e 'BRIDGED create_plan|wrote create_plan answer|continuation: wrote exec result' \
  "$LOG" > "$SCRATCH/step10-log-extract.txt"
```

Save that filter's output to a file under the scratch directory. Inspect the
saved extract as needed, including selecting individual fields from long
lines, without searching the live log again. Running that filter in step 10
is required and allowed — it is not a rule violation.
Do not dump the entire extract into one tool result. Select the relevant
events and fields, or wrap long lines, so the host does not truncate evidence.
The extract records routing; the matching tool result in this session's
transcript records the review outcome. Missing labels from another routing
path are expected; apply the P2 decision procedure below without retrying the
workflow or speculating about asynchronous timing.

### Steps

1. **Scratch** — Create the scratch dir. Write `hello.txt` with one line. Read
   it back. Privately note host / model / session id if shown; never copy the
   real session id into the report.

2. **Files** — Write a second file. Edit the first. Read both. Search file
   contents for a unique string and list the scratch dir. Use separate
   dedicated search and listing capabilities when both are advertised; do not
   replace either with shell commands. If one capability is absent, use the
   best available fallback and record that in the score. Pass when files match
   and the available operations succeed.

3. **Shell** — If the shell tool has a working-directory field (`cwd`,
   `workdir`, `working_directory`, …), set it to the scratch dir and run
   exactly `pwd` (no `cd`, no `mkdir … && pwd`). Pass when stdout is the
   scratch dir, or when the schema has no such field and a plain `pwd`/`ls`
   still ran.

4. **Ask the user** — If the session advertises an interactive question
   capability, ask one single-choice question with two options and wait for its
   result. Skip only when no such capability exists. Do not use chat text as a
   substitute and do not skip because its host-visible name differs.

5. **Task list** — If you have a tool that updates a full task list shaped
   like `{ "todos": [ { "content", "status" } ] }` (often `todowrite` /
   `todo_write`), run 5a→5f **once** with that same tool. Labels: `ocp-sv-a`,
   `ocp-sv-b`, `ocp-sv-c`. Use only status values the schema allows. Always
   send the **entire** list. If you already finished 5f earlier in this
   session (including before an interrupt), do not restart — continue later
   steps. If no full-list tool exists in the **host catalog**, skip every T4*
   row and continue (Cursor-native todo chrome without a host list tool does
   not count).

   **5a create**
   ```json
   {
     "todos": [
       { "content": "ocp-sv-a", "status": "in_progress" },
       { "content": "ocp-sv-b", "status": "pending" },
       { "content": "ocp-sv-c", "status": "pending" }
     ]
   }
   ```

   **5b check** — all three present; `a` active; `b`/`c` open.

   **5c progress** (nothing finished yet)
   ```json
   {
     "todos": [
       { "content": "ocp-sv-a", "status": "pending" },
       { "content": "ocp-sv-b", "status": "in_progress" },
       { "content": "ocp-sv-c", "status": "pending" }
     ]
   }
   ```

   **5d complete one**
   ```json
   {
     "todos": [
       { "content": "ocp-sv-a", "status": "completed" },
       { "content": "ocp-sv-b", "status": "in_progress" },
       { "content": "ocp-sv-c", "status": "pending" }
     ]
   }
   ```
   Pass: `a` completed (not still open); `b` active; `c` open.

   **5e drop `c`** — if `cancelled` is allowed, set `c` to `cancelled`; else
   omit `c` from the next full list. Pass: `c` not open work; `a`/`b` kept.

   **5f finish** — mark every still-open `ocp-sv-*` item `completed` in a snapshot
   that still names it. Do not send `{ "todos": [] }` while any of those
   labels is still `pending` or `in_progress`. A later empty list does not
   replace that snapshot. Pass: the last snapshot that still contains
   `ocp-sv-a` / `ocp-sv-b` / `ocp-sv-c` has none of them `pending` or
   `in_progress` (`cancelled` may be omitted). Same list tool for every update.

6. **Helper agent** — Only when the **host tool catalog** lists a helper
   executor (`task`, `subagent`, or an obvious host alias for the same
   spawn capability). Have one helper read `hello.txt` and return the text.
   Prefer the spawn result or auto-delivered output. Use a status/wait
   capability only if the helper is clearly stuck with no result.
   Cursor-native Task alone does **not** count — without a host executor it is
   refused. If the catalog has no helper tool, or a Task/helper call returns
   unavailable/refused, mark T5 `skipped` immediately and continue to step 7.
   Do not abort the checklist, do not retry Task, and do not fail the run for
   a missing optional helper.

7. **Short follow-up** — End this assistant turn by asking in chat:
   `Reply continue to run steps 8–10.` Stop and wait for a new user message.
   Always reach this prompt after steps 1–6, including when optional steps were
   skipped. Step 4 already exercises the interactive question tool; its answer
   is a tool result and does not create the user-turn boundary needed for this
   cache check. When the new `continue` message arrives, acknowledge it briefly
   and continue steps 8–10. Do not restart completed steps.

8. **Plan / mode** — Only when this session can complete a real human review or
   mode transition on **this host**. That means at least one of:
   - a host-catalog tool such as `plan_enter` / `plan_exit` / `cursor_plan_stage`
     (or an obvious host alias), or
   - a harness-documented review surface that a human can actually answer here
     (OMP stage overlay, DSH `exit_plan_mode` review, OpenCode plan/build agents).

   Cursor-native SwitchMode / CreatePlan alone are **not** enough when the host
   catalog has no plan tool and no stage/review UI — the provider may
   auto-acknowledge them (`provider-owned fallback`) while the human never gets
   a review prompt, and the checklist stalls. In that case mark P1/P2 `skipped`
   and continue to step 9. Do not enter plan mode, do not call CreatePlan, and
   do not wait for an approval that this host cannot surface.

   When a real plan/review/mode capability exists, design a tiny one-file
   scratch change, present it through that workflow, and wait for the human.
   For a mode-only capability, exercise the mode transition and any
   confirmation it requires; do not invent a stage tool or plan URI. Never
   call a hidden bridge target or an unadvertised name directly.

   Record the actual tool/interaction, its call id if exposed (privately),
   the human choice, and the returned outcome/status in the host's own format.
   Use these same facts for P1/P2. Creating a plan or entering plan mode is
   not execution approval. After explicit execution approval, apply and read
   back the tiny change once. Refine/dismiss must leave it unapplied. Record
   the exercised outcome as step 8 complete; do not test every possible choice.
   A later queued approval follow-up must not repeat completed work or
   recreate cleaned-up scratch.

   Harness-specific routing:

   - **OMP stage review:** an advertised `cursor_plan_stage` can be called
     directly using its schema and the URI returned by plan entry, or reached
     through native CreatePlan. It waits on the review overlay. OMP's
     `plan_exit` does not substitute for this stage review. Apply P2 below.
   - **Pi with `@pify/plan-mode` + OCP:** use advertised `plan_enter`, then submit
     with `cursor_plan_stage` (not raw `write_plan` / `exit_plan_mode`). That
     opens the host approval UI. While planning, prefer `grep`/`read` over bash
     regexes that contain `|` — pify’s shell policy splits on `|` even inside
     quotes, so `rg 'a|b'` can prompt
     `Allow this while planning? unrecognized command: 'b'` (that is **not**
     plan review). Plain Pi without `@pify/plan-mode` still skips P1/P2.
   - **Pi without plan tools / stage UI:** skip step 8 / P1 / P2.
     Do not use Cursor SwitchMode→plan or CreatePlan here.
   - **Other harnesses:** use their advertised/native review or mode workflow
     and score P1. A `question` approval, a genuine native `plan_exit` review,
     or a primary-agent switch need not emit stage logs or OMP result fields.
     P2 is skipped when the stage capability is absent.
   - **DSH with Cursor:** use advertised `plan_enter` or the native SwitchMode
     interaction to enter the host's plan state. Submit through advertised
     `cursor_plan_stage` or native CreatePlan. OCP maps that to DSH's
     `exit_plan_mode` review; the host transcript uses that native name and
     retains the complete plan. P2 applies when the canonical stage capability
     is advertised. Follow the schemas visible to you; do not guess an alias.

9. **Image** — If the selected Cursor model and session expose a normal image
   generation workflow, generate one tiny image and let that workflow choose
   the path. Do not name the scratch dir, the git worktree, or the provider
   checkout as the destination, and do not invent a save id or call a hidden
   save bridge. The file belongs under the advertised `project_folder`, in
   `assets/`. Verify the save tool succeeded and the resulting file exists with
   nonzero size before marking this step passed. A staged write or a successful
   tool-call status alone does not prove that an image reached disk. Otherwise
   skip.

10. **Score** — Now run the step-10 log filter once. Fill the table. Do not
    re-run the filter. Delete only the scratch dir. Leave the image where the
    host wrote it.

### Scoring

`passed` / `failed` / `skipped` / `blocked`. Every non-skipped row needs a
short cite (log line and/or transcript). No cite → not passed.

Name mapping: the debug log may say `question` / `todowrite` / `task` while
the host transcript says `ask` / `todo` / `task` for the same calls — either
cite is fine. If the log has multiple headers / `reinit=append` /
`size-cap truncate`, prefer the transcript for tool rows when early
`EMITTED` lines are missing.
For L3, compare only the main session's Runs. A helper has its own session
and conversation; its cold first Run is expected and is not a parent remint.

| Id | Pass when |
|---|---|
| L0 | Log has a process header and `debug: enabled file=`. Note `log reinit` if multiple headers / append / size-cap |
| L1 | At least one `outbound Run:` and one `cache diagnosis:` |
| L2 | First completed turn: `turn usage validation: status=ok` |
| L3 | After the new user message in step 7, the main session's `outbound Run` retains its conversation id with `checkpointLen>0`, `reset=false`, `systemPromptLen=0`, and `requestContextReused=true`. A completed `continuity=warm` diagnostic also confirms reuse, but the current turn's terminal diagnostic is written only after you finish, so do not wait or re-filter for it. Report any earlier interruption/remint separately. An equal `requestContextHash` alone does not prove warm reuse |
| L4 | `perModelCallCache=unavailable` |
| T1 | Scratch file / search / shell work succeeded |
| T2 | No schema rejection on the args you copied; if a working-directory field exists, step 3’s `pwd` used it and printed the scratch dir; dedicated search/list capabilities were used when advertised; exercise work used this session’s best available tools |
| T3 | Ask-user step completed, or honestly skipped only when no ask tool existed |
| T4a–T4f | Matching 5a–5f outcomes (all required when a full-list **host** tool exists); lifecycle once. **Skipped** when the host catalog has no full-list todo tool (Cursor-native todo chrome alone is not enough). **Failed** if the last snapshot that still names `ocp-sv-a` / `ocp-sv-b` / `ocp-sv-c` leaves any of them `pending` or `in_progress`, even when a later call is `{ "todos": [] }` |
| T5 | Helper ran via a host-advertised `task`/`subagent` (or alias), or honestly skipped when none was advertised / Task was refused unavailable. A refused Task without a host executor is skip evidence, not a run failure |
| T6 | Nothing required the provider to import `@opencode-compat/*` |
| T7 | You did not mark pass/skip while the opposite is true (an advertised capability was skipped, todo lifecycle replayed, an unadvertised name was guessed, or a lower-quality substitute was used while the dedicated tool was available). Checking the catalog and skipping — or one refused unavailable Cursor-native Task followed by an immediate T5 skip — is not a T7 failure |
| P1 | The available plan/review/mode workflow matches the human's choice, using that host's result format; no implementation without execution approval. **Skipped** when the host has no plan tool and no review UI (Cursor SwitchMode/CreatePlan alone on Pi is not enough) |
| P2 | Stage-capability review only: apply the procedure below when `cursor_plan_stage` is advertised; otherwise skip. Other plan/mode workflows are covered by P1 |
| P3 | Every emitted tool/interaction belonged to the selected Cursor model's advertised or native capability set; no Devin-specific tool contract was assumed |
| H1 | Provider checkout not written |
| H2 | No `.opencode/` under scratch from plan tools |
| H3 | Scratch exercise files are only in the scratch dir. When step 9 ran, `binary write STAGED` has `requested` and `target` equal and both under the `project_folder` from `buildEnv:` plus `/assets/`; the save tool succeeded; and the target file exists with nonzero size. `image save: wrote` is supporting log evidence when present. Fail if the save tool reports no pending image, the file is missing, the image is in the scratch dir, git worktree, or provider checkout, or `requested` and `target` differ. A host plan file outside scratch is not an H3 failure |

### P2 decision procedure (stage capability only)

This checks the advertised `cursor_plan_stage` contract (supplied by OCP for
Cursor on OMP and DSH). It is not a universal plan-tool schema. A host need
not expose an OMP overlay, `isError`, or `details.action=plan_approved`.
Score the stage review once, using the step-8 evidence; do not exercise every
Cursor transport path.

1. **Applicability:** if `cursor_plan_stage` was not advertised, or step 8
   had no plan capability, mark `skipped`. Workspace paths, cache directory
   names, and an MCP server named `opencode` do not identify the host.
2. **Route:** the following paths can invoke the same review UI:

   | Route | Supporting log evidence |
   |---|---|
   | Native CreatePlan interaction | `BRIDGED create_plan` with `bridge=stage`, then `wrote create_plan answer` |
   | Advertised stage tool called directly | `EMITTED tool-call ... toolName=cursor_plan_stage`, then matching `wrote exec result ... field=mcp_result` |
   | DSH completed-plan fallback | DSH transcript `tool/call` for `exit_plan_mode` with a `host_plan_stage_` call id, then matching `tool/result`; provider `BRIDGED`/`EMITTED` lines are not expected |

   The direct route does **not** emit `BRIDGED create_plan` or
   `wrote create_plan answer`. Their absence is expected, not delayed logging
   or a failure. Match call/exec ids within the same Run when citing logs;
   an unrelated exec result is not evidence. Neither an emitted call nor a
   written response alone proves approval.
3. **Outcome:** use the matching review tool result in the transcript as
   primary evidence. Require a successful result with explicit approval.
   In OMP's structured transcript this is `isError=false` plus
   `details.action=plan_approved` or the tool's `Plan approved ...` result.
   If only rendered tool output is exposed, its explicit approval result and
   successful status suffice; do not require hidden JSON fields.
   DSH logs the same review as `exit_plan_mode`; approval is `{approved:true}`
   with the rendered `Plan approved` result. Match the call id, not tool-name
   spelling. Both native review UIs are valid.
   For refine/dismiss, require an error explicitly reporting
   refinement/not-approved/dismissal, with no implementation afterward.
   An arbitrary tool error is not a successful rejection test. Assistant
   narration alone is insufficient. Elapsed time does not prove a UI choice.
4. **Verdict:** `passed` when the review outcome agrees with the human choice.
   `failed` when it contradicts the choice, demonstrably bypasses review,
   uses `plan_exit` instead of review, or implements after refine/dismiss.
   `blocked` when the applicable review result or choice cannot be established.
   Missing evidence is not proof of a runtime failure. Do not rerun step 8 or
   the live-log filter to turn a blocked row into a pass.

Example: log shows only `EMITTED ... cursor_plan_stage`; transcript shows
`plan_approved`, `isError=false`, following the human's approval. Score
`P2 | passed | direct stage; transcript review approved; log:<line> emitted`.
Do not require native CreatePlan labels or test refine/dismiss afterward.

### Report

```
host:
model:
session: <redacted>
log: <redacted>
scratch: <redacted>
list_tool:
spawn_tool:

| id | result | evidence |
|----|--------|----------|
| L0 |        |          |

verdict: pass | fail
notes:
```

`verdict` is `pass` only if every non-skipped item passed and L0–L3, T1, H3
passed. When a full-list task tool exists, T4a–T4f are all required. End with
that table.

---
