# Cursor + OCP self-verify prompt

Live check that Cursor models work on a stock host through OCP. The usual
user message is along the lines of `execute tests in
docs/guides/cursor-ocp-self-verify.md`. The agent should follow only the
**Agent prompt** checklist below (ignore Operator setup while executing).

Same exercises and scoring on every host (`opencode`, `mimo`, `kilo`, `pi`,
`omp`, `dsh`). Unit tests are not evidence.

## Operator setup

Do this before the agent runs. Not part of the agent checklist.

1. Wire the host from this repo:

   ```bash
   ./scripts/ocp-dev.sh run <host>          # local OCP + local provider
   ```

   Hosts: `opencode`, `mimo`, `kilo`, `pi`, `omp`, `dsh`. Confirm the slot with
   `.claude/skills/ocp-dev/SKILL.md` and
   `.claude/skills/ocp-dev/references/hosts.md` before starting the session.

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

   Do **not** rebuild/relink the provider, restart omp, or clear the log while
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
Operator setup. Read this file at most once at the start; do not re-open it
mid-run to “find where you left off.”

---

Please run a quick end-to-end check that this session’s tools and the Cursor
provider debug log are working. Do the steps in order in **this same
session**. Choose tools by the capabilities and schemas actually advertised in
this session, not by guessing what this host usually calls them. Prefer a
dedicated file/search/list/question/todo/helper tool over a shell substitute;
use the shell for the explicit shell check or only when no dedicated capability
exists. Copy argument names from the chosen tool's own schema. Never call a
tool name merely because this guide or another harness mentions it.

Stay under an identity-free scratch directory you create (for example
`/tmp/ocp-cursor-self-verify/`, with a random non-identifying suffix if needed).
Do not edit this repo, the host source, or the
provider checkout. When the UI needs a human choice, stop and wait — then
resume the **next unfinished** step (do not restart finished work). Host aliases
are expected: score the capability exercised, not one spelling of its name.
Cursor-native interactions may not appear as ordinary catalog tools; use them
only when the selected Cursor model actually makes them available, and let OCP
perform the host translation.

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

```
rg -n 'outbound Run:|hash requestContext|turn usage validation:|cache diagnosis:|extractTools:|EMITTED tool-call|debug: enabled file=|reinit=append|size-cap truncate|buildEnv:|binary write STAGED|BRIDGED create_plan|wrote create_plan answer' "$LOG"
```

If that output is long, keep only lines needed for the table. Running that
filter in step 10 is required and allowed — it is not a rule violation.

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
   steps. If no full-list tool exists, skip every T4* row.

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

6. **Helper agent** — If the session advertises a helper/subagent capability,
   have one helper read `hello.txt` and return the text. Prefer the spawn result
   or auto-delivered output. Use a status/wait capability only if the helper is
   clearly stuck with no result. Skip if no helper capability exists.

7. **Short follow-up** — If an interactive question capability is advertised,
   use it for one single-choice question with two short options, one of them
   `continue`, then end the turn with no further tools. If none exists, ask in
   chat for a short `continue` message and stop. When `continue` arrives, send
   one short acknowledgment with **no tools in that first reply**, then
   **immediately continue steps 8–10 in the same turn** (tools are allowed
   after the acknowledgment). Do not restart completed steps or end the turn
   after the acknowledgment.

8. **Plan / mode** — If this Cursor model and session expose a genuine plan,
   review, or mode-switch capability (including a Cursor-native interaction),
   design a tiny one-file scratch change and use the normal Cursor workflow so
   the host review UI appears, then wait for the human. Do not call a hidden
   host bridge target or an unadvertised name directly. Skip if the capability
   is unavailable. On omp, CreatePlan's host stage tool waits on the plan-review
   overlay; approve, refine, or dismiss there before continuing. Do not treat
   `plan_exit` as that review. On DSH,
   follow the active `plan:policy` guidance and the advertised native
   `exit_plan_mode` schema; OCP does not synthesize entry, approval wording,
   or an execution follow-up.

9. **Image** — If the selected Cursor model and session expose a normal image
   generation workflow, generate one tiny image and let that workflow choose
   the path. Do not name the scratch dir, the git worktree, or the provider
   checkout as the destination, and do not invent a save id or call a hidden
   save bridge. The file belongs under the advertised `project_folder`, in
   `assets/`. Otherwise skip.

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

| Id | Pass when |
|---|---|
| L0 | Log has a process header and `debug: enabled file=`. Note `log reinit` if multiple headers / append / size-cap |
| L1 | At least one `outbound Run:` and one `cache diagnosis:` |
| L2 | First completed turn: `turn usage validation: status=ok` |
| L3 | After step 7: `continuity=warm` **or** the same `requestContextHash` as the previous real Run |
| L4 | `perModelCallCache=unavailable` |
| T1 | Scratch file / search / shell work succeeded |
| T2 | No schema rejection on the args you copied; if a working-directory field exists, step 3’s `pwd` used it and printed the scratch dir; dedicated search/list capabilities were used when advertised; exercise work used this session’s best available tools |
| T3 | Ask-user step completed, or honestly skipped only when no ask tool existed |
| T4a–T4f | Matching 5a–5f outcomes (all required when a full-list tool exists); lifecycle once. **Failed** if the last snapshot that still names `ocp-sv-a` / `ocp-sv-b` / `ocp-sv-c` leaves any of them `pending` or `in_progress`, even when a later call is `{ "todos": [] }` |
| T5 | Helper agent ran, or honestly skipped |
| T6 | Nothing required the provider to import `@opencode-compat/*` |
| T7 | You did not mark pass/skip while the opposite is true (an advertised capability was skipped, todo lifecycle replayed, an unadvertised name was guessed, or a lower-quality substitute was used while the dedicated tool was available) |
| P1 | Plan/mode outcome matches what the human did, or skipped if absent |
| P2 | This row applies when the log shows `cursor_plan_stage` and a `bridge=stage` CreatePlan. That is omp even if `cwd` or `workspace_paths` contain `opencode-plugin-compat`, the cache path contains `opencode-providers`, or an MCP line says `requested=[opencode]`. Those strings are the workspace and an MCP server, not the host. The debug log never prints “overlay”, “approve”, “refine”, or “dismiss”. The overlay is that `bridge=stage` CreatePlan staying open, then `continuation: wrote create_plan answer`. **Approved** is **passed** when that answer is success — do not skip this as “not the failure path” or “host is opencode”. **Refine or dismiss** is **passed** only when that answer is an error. **Failed** if the stage tool returned immediately, `plan_exit` was used as the review, or the answer contradicts the human. **Skipped** only when `cursor_plan_stage` was never advertised, or step 8 was skipped because no plan capability existed |
| P3 | Every emitted tool/interaction belonged to the selected Cursor model's advertised or native capability set; no Devin-specific tool contract was assumed |
| H1 | Provider checkout not written |
| H2 | No `.opencode/` under scratch from plan tools |
| H3 | Scratch exercise files are only in the scratch dir. When step 9 ran, `binary write STAGED` has `requested` and `target` equal and both under the `project_folder` from `buildEnv:` plus `/assets/`. That cache path is the correct image location. Fail if the image is in the scratch dir, the git worktree, or the provider checkout, or if `requested` and `target` differ. A host plan file outside scratch is not an H3 failure |

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
