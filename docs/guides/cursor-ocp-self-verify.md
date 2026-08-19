# Cursor + OCP self-verify prompt

Paste the **Agent prompt** below into a stock host session that is already
wired to this OCP checkout and `cursor-opencode-provider`. The agent performs
real work, then reads the Cursor provider debug log it just produced and scores
each item from that log plus the host transcript. Unit tests are not evidence.

For an **omp-only** smoke of the recent read / replace-edit / hashline / todo
folds, use [`omp-tool-shape-self-verify.md`](./omp-tool-shape-self-verify.md)
instead of this full suite.

Operator setup is not part of the paste. Do it first.

## Operator setup

1. Wire the host from this repo:

   ```bash
   ./scripts/ocp-dev.sh run <host>          # local OCP + local provider
   ```

   Hosts: `opencode`, `mimo`, `kilo`, `pi`, `omp`. Confirm the slot with
   `.claude/skills/ocp-dev/SKILL.md` before starting the TTY.

2. Start the **stock** host in a TTY with debug logging. Use a throwaway
   workspace, not this repo and not the provider checkout.

   ```bash
   export CURSOR_PROVIDER_DEBUG=1
   export CURSOR_PROVIDER_DEBUG_FILE=/tmp/cursor-ocp-self-verify.log
   # then launch the stock host in this environment, e.g.:
   #   mimo | kilo | opencode | pi | omp
   ```

   The provider prints `[cursor-provider] CURSOR_PROVIDER_DEBUG logging to …`
   on first use. If the file path differs, tell the agent that path in the
   first user message.

3. Select a Cursor model. Stay in one session for the whole prompt.

4. After the agent finishes, keep `/tmp/cursor-ocp-self-verify.log` (or the
   announced path). Do not restart the host until the report is written —
   restart truncates the default per-pid log.

Interactive items that need a human (plan approve / refine / dismiss, mode
switch confirmation) stay with the operator. The prompt tells the agent to
pause and wait rather than invent a click.

Provider-maintained interactive checklist:
[cursor-opencode-provider/docs/host-compat-acceptance.md](https://github.com/oakimov/cursor-opencode-provider/blob/main/docs/host-compat-acceptance.md).
Log field meanings:
[cursor-opencode-provider/docs/cache-log-runbook.md](https://github.com/oakimov/cursor-opencode-provider/blob/main/docs/cache-log-runbook.md).

---

## Agent prompt

Copy everything below this line into the host session.

---

You are verifying that **unmodified** `cursor-opencode-provider` is working
through **OCP** on this stock host. You will do real tool work in this session,
then read the Cursor provider debug log from the same process and score each
check from **transcript + side effect + log**. Do not treat memory, guesses, or
unit tests as proof.

### Constraints

- Do not edit host source, installed host binaries, this OCP repo, or the
  provider checkout.
- Work only under a scratch directory you create, e.g. `/tmp/ocp-self-verify-$USER/`.
  Delete it at the end if every write you made is inside it.
- Do not print secrets, tokens, or cookie values. The debug log is allowed to
  contain paths, tool names, model ids, and session ids.
- If a tool is not advertised, mark that item `skipped` with the advertised
  catalog — do not invent a replacement tool.
- When the host shows an approval UI, **stop and wait** for the human. Do not
  retry the same call in a loop.
- **Never ingest the debug log as conversation text.** Do not `read`, `cat`,
  or `head` the whole file. A full dump is tens of thousands of uncached
  suffix tokens and wrecks the warm-turn cache ratio this test is measuring.

### Find the log

1. Prefer `CURSOR_PROVIDER_DEBUG_FILE` if the operator named it (default
   `/tmp/cursor-ocp-self-verify.log`).
2. Else look in the transcript for
   `[cursor-provider] CURSOR_PROVIDER_DEBUG logging to …`.
3. Else `$TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log`.
4. Confirm the file exists with a tiny check only, e.g.
   `test -s "$LOG" && rg -n '^--- cursor-provider debug' "$LOG"`.
   If that header is missing, stop. Report `blocked: no debug log`.

Extract **only** matching lines, once, after all exercises (step 10). Use
this exact filter — no other content:

```
rg -n 'conversation persistence:|conversation reset:|outbound Run:|hash (systemPrompt|requestContext|checkpoint)|turn_ended raw wire fields:|finish: reason=stop|turn usage validation:|cache diagnosis:|extractTools:' "$LOG"
```

If that is still long, keep only `outbound Run:`, `hash requestContext`,
`turn usage validation:`, and `cache diagnosis:` lines. Cite those lines
in the score table. Do not paste the extract back into another tool call.

### Exercises

Do these in order in **this same session**. After each group, note timestamps
so you can find the matching log slice.

1. **Scratch + identity**
   - Create the scratch dir. Write `hello.txt` with one line. Read it back.
   - In your private notes, record host name, model id, session id if shown,
     and whether `plugin` / provider paths look like an OCP wrapper
     (`~/.cache/ocp-dev/<host>/provider`) or a stock checkout.

2. **Filesystem tools**
   - `write` a second file. `edit` the first file. `read` both.
   - Search the scratch dir (`grep` / `rg` / host equivalent).
   - List or glob the scratch dir.

3. **Shell**
   - Run a harmless command in the scratch dir (`pwd` or `ls`). Confirm
     `workdir` / `cwd` mapping did not fail schema validation.

4. **Question**
   - If `question` (or the host's advertised prompt tool) exists, ask one
     single-choice question with two options. Wait for the human if the host
     prompts. If the tool is absent, `skipped`.

5. **Todos**
   - If `todowrite` / `todoread` (or the host role that OCP remaps to them)
     exist, write two todos, mark one in progress, then completed. Read them
     back. You must see **canonical** `todowrite`/`todoread` in your tool
     names, never a raw fork tracker name as the plugin-facing tool. If those
     tools are absent, `skipped`.

6. **Subagent**
   - If `task` exists, spawn a short read-only subagent (`explore` or
     `general`) whose prompt is only to read `hello.txt` and return its
     contents. The plugin-facing call and result must stay canonical `task`
     / `task_id`. Fail if `actor` / `actor_id` / `<actor_result>` appear there.
     If `task` is not advertised, `skipped`.

7. **Second user turn (warm cache)**
   - Stop and tell the human: “send one short follow-up, e.g. `continue`”.
     After that message arrives, answer in one or two sentences. Do **not**
     read the debug log on this turn. This turn exists so the log can show
     `continuity=warm` and a reused RequestContext hash.

8. **Plan / mode (human-gated)**
   - If `plan_enter` / CreatePlan / SwitchMode is advertised, enter plan mode
     and write a **tiny** plan (one file change in the scratch dir).
   - Then **propose** it so the host review UI actually opens: call
     `cursor_plan_stage` if it exists, otherwise write the plan to the host
     propose path (`xd://propose` on omp). Do **not** call `plan_exit` yourself.
   - Tell the human which UI choice to make for this run:
     - OpenCode/MiMo/Kilo: approve once if they want the execute path.
     - omp: one of Approve and execute / Refine plan / dismiss — they pick.
     - plain pi: SwitchMode should be refused; record that.
   - Wait. Do not implement a plan the human declined.
   - After the choice, continue only as the tool result indicates.

9. **Image save**
   - If `cursor_image_save` is advertised and no `image_id` exists, call it
     with a fake id and expect a missing-id error, not a write. If the tool
     is absent, `skipped`.

10. **Score from a filtered extract**
    - Run the `rg` filter above once. Do not read the log any other way.
    - Fill the table from that extract plus the transcript. Drop the extract
      from later context; do not re-run the filter.

### Scoring

For every item: `passed` / `failed` / `skipped` / `blocked`. Cite the log
line or transcript sentence that proves it. No cite → not passed.

| Id | What must be true |
|---|---|
| L0 | Debug log exists, has the process header, and `debug: enabled file=` |
| L1 | At least one `outbound Run:` and one `cache diagnosis:` for this session |
| L2 | First completed turn has `turn usage validation: status=ok` (not `mismatch`) |
| L3 | Follow-up turn (exercise 7) shows `continuity=warm` or an equal `requestContextHash` vs the prior real Run. A lifecycle/empty-tools sibling may have `incomingTools=0` but must share session / RequestContext identity with the full-catalog call |
| L4 | `perModelCallCache=unavailable` remains unavailable |
| T1 | write/read/edit/search/shell all succeeded; scratch files match |
| T2 | No tool-schema rejection on camelCase args (`filePath`, `oldString`, `workdir`) if you used them |
| T3 | Question tool either completed or is honestly `skipped` |
| T4 | Todo tools used canonical names; snapshot round-tripped. `skipped` if no todo tools are advertised |
| T5 | If `task` is advertised: plugin-facing call is `task`; result/history use `task_id` / `<task` if a resume id is present; fail on `actor` / `actor_id` / `<actor_result>`. If `task` is not advertised: `skipped` |
| T6 | Log/transcript never require the provider to have imported `@opencode-compat/*` |
| P1 | Plan/mode: host-appropriate outcome (approved ⇒ one execute path, no retry storm; refine/dismiss ⇒ no execute; pi refuse ⇒ no plan tools). Cite the tool result text |
| P2 | omp refine/dismiss must be an **error** result, not success |
| H1 | Stock provider checkout was not written (no new `generated by ocp setup` in that tree if you can see the path; do not modify it to check) |
| H2 | No `.opencode/` created in the scratch project by CreatePlan; plan file, if any, is under the host data/plans root |
| H3 | Scratch dir is the only tree you changed |

### Report format

```
host:
model:
session:
log:
scratch:

| id | result | evidence |
|----|--------|----------|
| L0 |        |          |

verdict: pass | fail
notes:
```

`verdict` is `pass` only if every non-skipped item passed and L0–L3, T1, H3
passed. T5 is required only when `task` is advertised. End with that table.
Do not claim interactive parity for items the human did not operate.

---
