# Cursor + OCP self-verify prompt

Live check that Cursor models work on a stock host (native OpenCode, or
another harness through OCP). The usual
user message is along the lines of `execute tests in
docs/guides/cursor-ocp-self-verify.md`. The agent should follow only the
**Agent prompt** checklist below (ignore Operator setup while executing).

Same capability-based exercises on every stock host. Unit tests are not
evidence.

## Operator setup

Do this before the agent runs. Not part of the agent checklist.

1. Wire non-OpenCode hosts from this repo:

   ```bash
   bun run build                         # refresh compiled packages and the bundled adapter runtime
   ./scripts/ocp-dev.sh run <host>          # local OCP + local provider
   ```

   After local OCP changes, build before wiring. Typechecking alone does not
   rebuild the adapter bundle copied into clone-provider wrappers. Start a
   fresh host process after refreshing the wrapper.

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

   On a long-lived host process this removes the process banner; later lines
   still append. The agent prompt treats live provider events as enough. Do **not** rebuild/relink the provider, restart the host, or clear
   the log while the agent is mid-run. Provider re-init appends (`reinit=append`); a mid-run
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
session**. Use whatever this session actually offers for files, search, listing,
questions, todos, helpers, and planning. Prefer a dedicated capability over a
shell substitute. Copy argument names from the chosen tool's own schema. Do not
invent a name because a guide or another host used it.
Supply every required argument before calling. In particular, a shell call
needs `command` even when the goal is only counting or inspecting a file;
`filePath` alone is a read argument, not a shell command.
For Cursor's `CallDynamicTool`, keep `namespace` and `toolName` at the outer
level beside `arguments` on **every** call, including each parallel call.
Copy that identity from discovery; never send only the inner arguments.
Build each call with its discovered outer identity first, then add `arguments`.
The discovered `inputSchema` describes `arguments`, not the complete invocation.
For example, after discovering namespace `opencode` and tool `bash`, a complete
call is `CallDynamicTool({"namespace":"opencode","toolName":"bash","arguments":{"command":"pwd"}})`.
Use this only when discovery returns that exact identity; add any fields its
current schema requires. Check the outer identity before submitting long scripts.
Send commands/scripts only to the advertised shell tool. A file/list tool
that ignores `command` has not executed it, even if its result says success.
For shell headings, use `printf '%s\n' 'heading'`; never use a heading beginning
with `-` as the format argument. Avoid decorative headings when unnecessary.

**Optional capabilities must not abort the run.** If this session cannot ask,
maintain a full task list, spawn a helper, or plan, mark the matching score
row `skipped` and continue immediately. Steps 7 and 10 are always required.
If the session can do the capability, you must exercise it.
Determine availability from the advertised host catalog and its schemas,
not Cursor's native function definitions. Native AskQuestion and Task need
an advertised host question or helper executor. When absent, skip immediately;
do not try native calls, guess host tool names, or probe environment variables
to discover an executor. Record each absence once and keep that skip through
scoring. If a native request was already refused as unavailable, that is skip
evidence, not a schema failure or a T7 failure; do not retry it.

Stay under a new, empty scratch directory you create with
`mktemp -d /tmp/ocp-cursor-self-verify-XXXXXX`. Never pick the suffix yourself
or reuse an existing directory: files left by an earlier run would read as this
run's.
Do not edit this repo, the host source, or the provider checkout. When the UI
needs a human choice, stop and wait — then resume the **next unfinished**
step. Score the capability exercised, not one spelling of its name.

Do not print tokens, credentials, cookies, real session ids, user names, home
directories, or private checkout/workspace paths. When citing a transcript or
debug line, cite its line number/event and replace local roots with generic
labels such as `<home>`, `<workspace>`, and `<provider-checkout>`.

### Debug log (one policy)

Default path: `/tmp/cursor-ocp-self-verify.log` (or whatever the operator named).

1. **Once at the start:** confirm the log exists and is this provider's debug
   file with a tiny check only. Match **any** of: the process banner, an enable
   line, or a live provider event (a long-lived process often loses the banner
   when the operator truncates after first use). Example:

   ```bash
   test -s "$LOG" && rg -n \
     -e '^--- cursor-provider debug' \
     -e 'debug: enabled file=' \
     -e 'outbound Run:' \
     -e 'extractTools:' \
     "$LOG" | head -n 5
   ```

   Stop and report `blocked: no debug log` only when the file is missing, empty,
   or that filter prints nothing. A missing `--- cursor-provider debug` line
   alone is not blocked.
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
  -e 'APPROVED switch_mode|BRIDGED switch_mode|host-agent-mode:' \
  -e 'exec: REFUSED|REJECTED AskQuestion' \
  -e 'display tool_call_completed: ERROR' \
  -e 'interaction_query: replied.*variant=create_plan_request_query.*outcome=failed' \
  -e 'display tool_call_completed: deferred create_plan' \
  -e 'interaction_query: replied.*variant=ask_question_interaction_query.*outcome=rejected' \
  "$LOG" > "$SCRATCH/step10-log-extract.txt"
```

Save that filter's output to a file under the scratch directory. Inspect the
saved extract as needed, including selecting individual fields from long
lines, without searching the live log again. Running that filter in step 10
is required and allowed — it is not a rule violation.
Do not dump the entire extract into one tool result. Select the relevant
events and fields, or wrap long lines, so the host does not truncate evidence.
Missing labels from another path are expected; do not retry the workflow.
The file may contain earlier hosts or sessions. Use the transcript's run
boundaries and the log's session/conversation correlation privately to select
this run before scoring. Inspect compact summaries of catalog names, Run/cache
fields, refusals and image/plan outcomes; avoid repeated broad searches that
return most of the extract. Do not run unrelated environment, dependency or
capability probes during scoring.
Step 10's field projection is log analysis: use the advertised shell tool
with `command` to print compact fields from the saved extract. This is an
explicit exception to the dedicated-search preference; avoid broad native
grep results that include context and trigger another result spill. Do not
send that script to `ls`, `read` or another file tool. Keep it portable to
macOS and Linux: shorten lines with `cut -c1-N`, not regex counts such as
`{260}`.

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

4. **Ask the user** — If the session can ask a structured question, ask one
   single-choice question with two options and wait for its result. Skip only
   when no such capability exists. Do not use chat text as a substitute.

5. **Task list** — If the advertised host catalog can update a full task list shaped like
   `{ "todos": [ { "content", "status" } ] }`, run 5a→5f **once** with that
   same tool. Labels: `ocp-sv-a`, `ocp-sv-b`, `ocp-sv-c`. Use only status
   values the schema allows. The examples show only `content` and `status`;
   add every other field the tool's schema requires (for example an `id`).
   Always send the **entire** list. If you already
   finished 5f earlier in this session (including before an interrupt), do not
   restart — continue later steps. If no full-list tool exists, skip every T4*
   row and continue.

   Cursor's internal TodoWrite/TodoRead and their display updates are not host
   task tools. They do not prove a native host task-list update. Without an
   advertised full-list host tool, score T4a–T4f `skipped` even if Cursor can
   maintain its own list. Require host tool results and readback/native task
   state for each pass; repeating the requested snapshot in prose is not proof.

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

   Check the resulting host state before continuing: `a` open/pending, `b`
   active, `c` open/pending. Two active tasks fails 5c even if the update call
   succeeded.

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

6. **Helper agent** — If this session can spawn a helper, have one helper
   read `hello.txt` and return the text. Prefer the spawn result or
   auto-delivered output. If there is no helper, or the call is refused as
   unavailable, mark T5 `skipped` and continue to step 7.

7. **Short follow-up** — End this assistant turn by asking in chat:
   `Reply continue to run steps 8–10.` Stop and wait for a new user message.
   Always reach this prompt after steps 1–6, including when optional steps were
   skipped. Step 4's answer is a tool result and does not create the user-turn
   boundary needed for this cache check. When the new `continue` message
   arrives, acknowledge it briefly and continue steps 8–10. Do not restart
   completed steps.

8. **Plan** — If this session cannot plan, mark P1/P2 `skipped` and continue
   to step 9. Otherwise create a plan for a tiny one-file change under the
   scratch directory, then wait for the human to accept or reject executing
   it. Check the plan tool's preconditions first. If it requires active plan
   mode, enter through the advertised capability and wait for success before
   staging; never stage first and rely on an error to discover the prerequisite.
   If the mode-switch result or instructions say the host changes agents after
   this turn, end the turn without further tool calls. Create the plan only
   after the host starts the next planning turn.
   Cursor-native CreatePlan and SwitchMode already have native function
   definitions. Call them directly; do not discover them through
   GetDynamicTools/GetMcpTools or wrap them in CallDynamicTool. After an approved
   deferred switch, a brief handoff confirmation ends the turn; the instruction
   to continue exercise work does not authorize another tool in that turn.
   Let this session choose how planning and review happen. Do not name
   host tools, agents, or review UIs in the plan text — describe only the
   scratch file change. Entering plan mode or writing a plan is not execution
   approval. After explicit approval, apply and read back that change once.
   A refine or dismiss must leave it unapplied. Record the exercised outcome
   as step 8 complete; do not test every possible choice.
   If dismissal cancels the host turn, wait for the human's next message before
   continuing steps 9–10. Do not reopen review or repeat step 8.

9. **Image** — If this session can generate an image, generate one tiny image
   and let that workflow choose the path. Do not name the scratch dir, the git
   worktree, the provider checkout, or a cache/project folder as the
   destination. Verify the save succeeded and the resulting file exists with
   nonzero size. Otherwise skip.

10. **Score** — Now run the step-10 log filter once. Fill the table. Do not
    re-run the filter. Delete only the scratch dir. Leave the image where the
    host wrote it.
    Review tool errors from the entire session, including this scoring step.
    A corrected retry does not erase an earlier schema/argument rejection.
    Include provider-side missing-required-argument refusals as well as host
    schema errors and unexpected tool/command failures (including malformed
    scoring commands). Wrong-tool arguments still fail when silently ignored;
    host success does not mean the requested operation ran. Retain server-side
    dynamic-call identity errors even when no host execution was emitted.
    Native discovery/interaction results count too. In particular, an error
    saying a native tool is already available directly, or a premature CreatePlan
    deferred because the host plan agent is not active yet, fails T2. Safe
    recovery and later approval do not erase the invalid attempt. An explicit
    user decline/refine/dismiss is an expected review outcome, not this failure.
    Count every rejected invocation separately, including parallel calls and
    scoring calls made after the saved log extract. Use their transcript results
    too; a single representative log cite does not count all failures.
    Every host tool result marked as an error counts, including a path the
    tool could not resolve (for example a `~/…` path the host read tool does
    not expand), even when a later call reads the same file.
    Cursor-native Shell, Read, Grep, or similar calls that execute as the
    host's advertised tool (log `exec: EMITTED tool-call … toolName=<host
    tool>`; the host transcript names that tool) are that tool. They are not a
    substitute for it and do not fail T7.
    Inspect every command's output, including stderr, before the verdict.
    `completed` or exit zero is insufficient: a later command can mask an
    earlier failure in the same shell call. Diagnostics such as `printf:
    invalid option` or `printf: usage:` fail T2 even when later output succeeds.
    An optional capability's unavailable refusal is a skip,
    not such a failure. Keep tool-less helper refusals separate from main-session
    tool errors, and score them in L5.
    Before drafting the score table, build a **failure inventory** from the
    entire transcript and saved extract: tool/interaction, error or ignored
    argument, phase, count, and source cite. Include native discovery results
    even when no host tool or exec refusal exists. If you cannot establish
    whether an observed error was an expected user choice, mark its row blocked.
    Do not infer T2 passed from an empty ERROR/REFUSED search. Check this inventory
    against T2 and T7 before selecting the verdict.

### Scoring

`passed` / `failed` / `skipped` / `blocked`. Every non-skipped row needs a
short cite (log line and/or transcript). No cite → not passed.

Name mapping: the debug log and the host transcript may use different names
for the same calls — either cite is fine. If the log has multiple headers /
`reinit=append` / `size-cap truncate`, prefer the transcript for tool rows
when early `EMITTED` lines are missing.
For all rows, use only this harness run's evidence. For L3, compare only the
main session's Runs. A helper or an earlier host/session has its own conversation;
its cold Run is not a parent remint. This session's first cold Run is normal
startup, including after `reinit=append`; report a remint only if this same
main session changes conversation after starting.

| Id | Pass when |
|---|---|
| L0 | Log is this provider's debug file: a process header and `debug: enabled file=`, or (after a pre-agent truncate on a long-lived process) live `extractTools:` / `outbound Run:` in the same file. Note `log reinit` if multiple headers / append / size-cap; a missing banner after truncate is expected, not failed |
| L1 | At least one `outbound Run:` and one `cache diagnosis:` |
| L2 | First completed main-session turn: `turn usage validation: status=ok`; a title/helper's earlier terminal does not establish this row |
| L3 | After the new user message in step 7, the main session's `outbound Run` retains its conversation id with `checkpointLen>0`, `reset=false`, `systemPromptLen=0`, and `requestContextReused=true`. A completed `continuity=warm` diagnostic also confirms reuse, but the current turn's terminal diagnostic is written only after you finish, so do not wait or re-filter for it. Report any earlier interruption/remint separately. An equal `requestContextHash` alone does not prove warm reuse |
| L4 | `perModelCallCache=unavailable` |
| L5 | Tool-less title/summary/helper requests made no attempted execution (`REFUSED ... allowTools=false` fails this row). Correlate each tool-less Run with its own terminal diagnostic/transcript; ordinary helpers with a nonempty catalog may execute tools and do not belong here. Native protocol context/catalog probes are not execution attempts. **Skipped** only when no tool-less request occurred |
| T1 | Scratch file / search / shell work succeeded |
| T2 | The complete failure inventory has no main-session invalid call or unexpected tool/command failure in steps 1–10, including native discovery errors, premature plan attempts, server-side dynamic-call identity errors, provider-side refusals, malformed scoring commands and wrong-tool arguments silently ignored by the host. Any such failure fails T2 even if a corrected retry succeeds. One unavailable optional question/helper refusal is skip evidence, not a T2 failure; expected user review choices are scored in P1/P2. If a working-directory field exists, step 3’s `pwd` used it and printed the scratch dir; dedicated search/list capabilities were used when advertised in steps 1–9; exercise work used this session’s best available tools |
| T3 | Ask-user step completed, or honestly skipped only when no ask capability existed |
| T4a–T4f | Matching 5a–5f outcomes (all required when a full-list tool exists); lifecycle once. **Skipped** when the session has no full-list todo tool. **Failed** if the last snapshot that still names `ocp-sv-a` / `ocp-sv-b` / `ocp-sv-c` leaves any of them `pending` or `in_progress`, even when a later call is `{ "todos": [] }` |
| T5 | Helper ran, or honestly skipped when none was available / the call was refused unavailable. A refused helper is skip evidence, not a run failure |
| T6 | Nothing required the provider to import `@opencode-compat/*`. Score observed execution only; absence of a string in the filtered log is not a source/dependency audit. Do not run extra probes to establish this row |
| T7 | No false pass/skip, available capability skipped, todo lifecycle replayed, guessed host tool name, or lower-quality substitute for an available dedicated tool. A Cursor-native call that executed as the host's advertised tool is that tool, not a substitute. **Skipped** when the only concern is an absent optional capability, including one unavailable native AskQuestion/Task refusal followed by T3/T5 skip. Such a refusal does not mean an unadvertised host name was guessed. Repeated unavailable attempts or actual guessed host names still fail |
| P1 | A plan was created; the human's accept/reject was honored; nothing was implemented without execution approval. **Skipped** only when this session cannot plan |
| P2 | If step 8 used a distinct execution-review step, that review's transcript outcome matches the human choice. **Skipped** when there was no such review (P1 still applies) |
| P3 | Every emitted host tool belonged to this session's advertised catalog; native interactions followed the supported routes. One unavailable native question/helper refusal followed by a skip does not fail this row: it emitted no host execution. Guessed host tool names and repeated unavailable attempts still fail |
| H1 | Provider checkout not written |
| H2 | No host project-config directory under scratch from plan tools |
| H3 | Scratch exercise files are only in the scratch dir. When step 9 ran, `binary write STAGED` has `requested` and `target` equal and both under the `project_folder` from `buildEnv:` plus `/assets/`; the save succeeded; and the target file exists with nonzero size. `image save: wrote` is supporting log evidence when present. Fail if save reports no pending image, the file is missing, the image is in the scratch dir, git worktree, or provider checkout, or `requested` and `target` differ. A plan file outside scratch is not an H3 failure |

For T7, when T3 or T5 is skipped for absence and there is no actual integrity
violation, carry `skipped` through to T7 rather than inventing a failure or
claiming the absent capability passed. Provider-managed tool-result spills
are internal artifacts, not scratch exercise files; their presence alone is
not an H3 failure. Avoid triggering them with broad scoring output.

For T6, cite the completed provider-backed host calls as execution evidence;
never cite an absent package string as proof of the dependency boundary.

Score P2 from the step-8 transcript once. Require an explicit accept or
reject that matches the human choice. Narration and elapsed time are not
evidence. `failed` if implementation started without approval, or after a
refine/dismiss. `blocked` if the review result or choice cannot be
established. Do not rerun step 8 or the live-log filter to turn a blocked
row into a pass.

### Report

**The final assistant reply must be rendered Markdown.** Write the report
directly in the reply, using a Markdown heading, bold labels, a metadata list,
and a pipe-delimited score table with its header separator row. Do not wrap
the report or its table in a fenced code block, indent it as code, or return
it as plain text, JSON, a quoted string, or a tool/log dump. Use inline code
only for individual identifiers and values. Keep a blank line before the
metadata list and before the table.

Use this Markdown layout, replacing placeholders with the actual results:

#### Self-test result

- **Host:** `<host>`
- **Model:** `<model>`
- **Session:** `<redacted>`
- **Log:** `<redacted>`
- **Scratch:** `<redacted>`
- **List tool:** `<tool or unavailable>`
- **Spawn tool:** `<tool or unavailable>`

**Verdict:** `pass` or `fail`

**Notes:** Brief findings, skips, and interruptions; omit if none.

When the failure inventory is nonempty, include every entry and its count in
Notes before the table. T2 must reflect any invalid attempt; T7 must fail if
the report hides one or calls the affected row passed. A successful final
state, empty debug-error search, or completed host calls alone cannot justify
`pass`. With no failures, explicitly write `Failure inventory: none` in Notes.

| id | result | evidence |
|----|--------|----------|
| L0 | passed / failed / skipped / blocked | Short source cite |

Include every scoring row; expand T4a–T4f into six separate rows. The L0 row
above illustrates the table format, not the complete report. Before sending,
check that the heading, list, bold labels, and table are outside code blocks
and that the table has a header separator. Put verdict and notes before the
table so the reply ends with the complete score table.

`verdict` is `pass` only if every non-skipped item passed and L0–L3, T1, H3
passed. When a full-list task tool exists, T4a–T4f are all required. End with
that table.

---
