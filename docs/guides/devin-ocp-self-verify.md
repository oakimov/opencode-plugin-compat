# Devin + OCP self-verify prompt

Live check that Devin models work on a stock host through OCP. The usual
user message is along the lines of `execute tests in
docs/guides/devin-ocp-self-verify.md`. The agent should follow only the
**Agent prompt** checklist below (ignore Operator setup while executing).

Same exercises and scoring on every host (`opencode`, `mimo`, `kilo`, `pi`,
`omp`, `dsh`).

This file is **Devin-only**. Do not use Cursor models, `CURSOR_PROVIDER_*`
env, or the Cursor self-verify guide for this run.

## Operator setup

1. Wire the host so it loads **local** OCP + **local** `devin-opencode-provider`
   (not Cursor). Examples:

   - **dsh:** `./scripts/ocp-dev.sh run dsh` writes Cursor **and** Devin
     rows into `$DSH_HOME/profiles/web/cordis.patch.yml`. The picker
     shows `devin-opencode/*` (`devin` is reserved). Export a
     **single-quoted** `devin-session-token$…` (or `sk-ws-01-` / `cog_`)
     as `DEVIN_API_KEY` on the same process as
     `node <harness>/apps/cli/lib/bin.js web`. Unquoted `$` is eaten by
     the shell. Do not use a Sessions REST `apk_user` key.
   - **omp / pi:** `providers[].package` points at
     `<devin-provider-checkout>/dist/index.js` in
     `~/.omp/agent/pi-bridge.json` (or `~/.pi/agent/pi-bridge.json`). Rebuild
     with `bun run build` in that checkout when needed.
   - **opencode / mimo / kilo:** add the Devin plugin the way that host loads
     OpenCode providers (local `file://…/dist/index.js` or npm). Confirm the
     model picker lists a **devin/** model.

2. Start the **stock** host with Devin debug logging. Use a throwaway
   workspace, not this OCP repo and not the provider checkout. Export the env
   on the **same process** that loads the Devin provider:

   ```bash
   export DEVIN_PROVIDER_DEBUG=1
   export DEVIN_PROVIDER_DEBUG_FILE=/tmp/devin-ocp-self-verify.log
   ```

   Then launch, for example:

   | Host | Typical launch |
   |---|---|
   | `opencode` / `mimo` / `kilo` | stock CLI in a TTY |
   | `pi` / `omp` | stock CLI in a TTY |
   | `dsh` | `node <deepseek-harness>/apps/cli/lib/bin.js web` (env on that server process). Do not use checkout `pnpm dsh web`. |

   The provider prints `[devin-provider] DEVIN_PROVIDER_DEBUG logging to …`
   on first use. If the file path differs, tell the agent that path in the
   first user message.

3. Select a **Devin** model (e.g. `devin/swe-1-6`, or `devin-opencode/swe-1-6`
   on DSH). Stay in one session for the whole prompt. Use a throwaway
   workspace, not this OCP repo.

   Before pasting the agent prompt, truncate the debug file once:

   ```bash
   : > /tmp/devin-ocp-self-verify.log
   ```

   Do **not** rebuild/relink the provider, restart the host, or clear the log
   while the agent is mid-run. Re-init appends (`reinit=append`); a mid-run
   restart still breaks warm-cache checks (L3). The log size-caps at 10 MiB
   (`size-cap truncate`).

4. After the agent finishes, keep `/tmp/devin-ocp-self-verify.log` (or the
   announced path). Do not restart the host until the report is written.

Interactive items that need a human (for example an ask-tool answer) stay with
the operator. The prompt tells the agent to pause and wait rather than invent a
click.

Log field meanings (Devin):
`devin-opencode-provider/docs/cache-log-runbook.md`.

---

## Agent prompt

When asked to run / execute this guide, do **only** the checklist below. Skip
Operator setup. Read this file at most once at the start; do not re-open it
mid-run to “find where you left off.”

---

Please run a quick end-to-end check that this session’s tools and the Devin
provider debug log are working. Do the steps in order in **this same
session**. Operate as a Devin GetChatMessage agent. Choose tools by the
capabilities and schemas actually advertised in this session, not by guessing
what this host usually calls them. Prefer a dedicated
file/search/list/question/todo/helper tool over a shell substitute; use the
shell for the explicit shell check or only when no dedicated capability
exists. Copy argument names from the chosen tool's own schema. Never call a
tool name merely because this guide, Cursor, or another harness mentions it.

Stay under an identity-free scratch directory you create (for example
`/tmp/ocp-devin-self-verify/`, with a random non-identifying suffix if needed).
Do not edit this repo, the host source,
or the provider checkout. When an interactive tool needs a human choice, call
it and stop — then resume the **next unfinished** step without restarting prior
work. Host aliases are expected: score the capability exercised, not one
spelling of its name.

Do not print tokens, credentials, cookies, real session ids, user names, home
directories, or private checkout/workspace paths. When citing a transcript or
debug line, cite its line number/event and replace local roots with generic
labels such as `<home>`, `<workspace>`, and `<provider-checkout>`.

Devin receives ordinary named tool definitions in GetChatMessage. It does not
use Cursor's native InteractionQuery plan/image/mode protocol. Do not invent or
call Cursor-private bridge tools. In particular, `cursor_plan_stage`,
`cursor_image_save`, and OCP-added Pi/OMP Cursor plan tools are not Devin
capabilities. DSH's native `exit_plan_mode` is different: it is a stable host
tool for every active model and may be advertised to Devin even while plan mode
is inactive. Follow DSH's current plan-policy guidance and its schema; do not
call it merely because it exists.

### Debug log (one policy)

Default path: `/tmp/devin-ocp-self-verify.log` (or whatever the operator named).

1. **Once at the start:** confirm the log exists with a tiny check only, e.g.
   `test -s "$LOG" && rg -n '^--- devin-provider debug' "$LOG" | head`.
   If there is no header, stop and report `blocked: no debug log`.
2. **During steps 1–9:** do not open, read, or search the debug log. Work from
   tool results and the on-screen transcript only.
3. **Only in step 10:** run the filter below **once**, cite matching lines in
   the score table, and do not paste the whole log into chat.

Filtered extract (step 10 only):

```
rg -n 'outbound Run:|hash prefix|turn usage validation:|cache diagnosis:|extractTools:|EMITTED tool-call|debug: enabled file=|reinit=append|size-cap truncate|devin doStream|GetChatMessage protoBytes' "$LOG"
```

If that output is long, keep only lines needed for the table. Running that
filter in step 10 is required and allowed — it is not a rule violation.

### Steps

1. **Scratch** — Create the scratch dir. Write `hello.txt` with one line. Read
   it back. Privately note host / model / session id if shown; never copy the
   real session id into the report.

2. **Files** — Write a second file. Edit the first using the best dedicated
   edit/patch capability available. Read both. Search file contents for a
   unique string and list the scratch dir. Use separate dedicated search and
   listing capabilities when both are advertised; do not replace either with
   shell commands. If one capability is absent, use the best available
   fallback and record that in the score. Pass when files match and the
   available operations succeed.

3. **Shell** — If the available shell capability has a working-directory
   field (`cwd`, `workdir`, `working_directory`, …), set **that field** to
   the scratch dir and run exactly `pwd` as the command (no `cd`, no
   `mkdir … && pwd`). Pass when stdout is the scratch dir, or when the
   schema has no such field and a plain `pwd`/`ls` still ran.

4. **Ask the user** — If the session advertises an interactive question
   capability, call it once with one question and two options, following its
   advertised schema exactly, and wait for the result. Skip only when no such
   capability exists. Do not use chat text as a substitute and do not skip
   because its host-visible name differs.

5. **Task list** — If you have a tool that updates a full task list shaped
   like `{ "todos": [ { "content", "status" } ] }` (often `todowrite` /
   `todo_write`), run 5a→5f **once** with that same tool. Labels: `ocp-dv-a`,
   `ocp-dv-b`, `ocp-dv-c`. Use only status values the schema allows. Always
   send the **entire** list. **5b is a private check, not a tool call.**
   **5a, 5c, 5d, 5e, 5f are five separate tool calls** — do not merge 5e
   into 5d or 5f into 5e. If you already finished 5f earlier in this
   session (including before an interrupt), do not restart — continue later
   steps. If no full-list tool exists, skip every T4* row.

   **5a create**
   ```json
   {
     "todos": [
       { "content": "ocp-dv-a", "status": "in_progress" },
       { "content": "ocp-dv-b", "status": "pending" },
       { "content": "ocp-dv-c", "status": "pending" }
     ]
   }
   ```

   **5b check** — all three present; `a` active; `b`/`c` open.

   **5c progress** (nothing finished yet)
   ```json
   {
     "todos": [
       { "content": "ocp-dv-a", "status": "pending" },
       { "content": "ocp-dv-b", "status": "in_progress" },
       { "content": "ocp-dv-c", "status": "pending" }
     ]
   }
   ```

   **5d complete one**
   ```json
   {
     "todos": [
       { "content": "ocp-dv-a", "status": "completed" },
       { "content": "ocp-dv-b", "status": "in_progress" },
       { "content": "ocp-dv-c", "status": "pending" }
     ]
   }
   ```
   Pass: `a` completed (not still open); `b` active; `c` open.

   **5e drop `c`** — **own tool call.** If `cancelled` is allowed, set `c` to
   `cancelled`; else omit `c` from this full list. Pass: `c` not open work;
   `a`/`b` kept.

   **5f finish** — **own tool call.** Complete what remains, or
   `{ "todos": [] }`. Pass: nothing left open; same list tool for every
   update.

6. **Helper agent** — If the session advertises a helper/subagent capability,
   have one helper read `hello.txt` and return the text. Prefer the spawn result
   or auto-delivered output. Use a status/wait capability only if the helper is
   clearly stuck with no result. Skip if no helper capability exists.

7. **Short follow-up** — After step 6, do not start step 8 in the same tool
   loop. If an interactive question capability is advertised, use it for one
   single-choice question with two short options, one of them `continue`, then
   end the turn with no further tools. If none exists, ask in chat for a short
   `continue` message and stop. When `continue` arrives, send one short
   acknowledgment with **no tools in that first reply**, then **immediately
   continue steps 8–10 in the same turn** (tools are allowed after the
   acknowledgment). Do not restart completed steps or end the turn after the
   acknowledgment.

8. **Provider isolation** — Do not manufacture a plan or mode transition for
   this test. Confirm from the session catalog that no Cursor-private bridge
   capability is available to this Devin call. If one is present, do not call
   it; mark P1 failed and record its exact advertised name. A host-native tool
   is not a failure merely because another harness uses a similar word. On DSH,
   `exit_plan_mode` is explicitly host-native and is not a Cursor leak.

9. **Optional Devin capability** — If this Devin model and session advertise a
   genuine provider/host-native image or other model-specific capability that
   is appropriate for a tiny scratch artifact, exercise it using its own
   schema. Never substitute a Cursor save bridge or invent an opaque id.
   Otherwise skip.

10. **Score** — Now run the step-10 log filter once. Fill the table. Do not
    re-run the filter. Delete the scratch dir only if every write you made is
    inside it.

### Scoring

`passed` / `failed` / `skipped` / `blocked`. Every non-skipped row needs a
short cite (log line and/or transcript). No cite → not passed.

Name mapping: the debug log and host transcript may use different names for
the same question, todo, helper, search, or listing capability — either cite is
fine. Search and listing remain separate jobs. If the log has multiple headers /
`reinit=append` / `size-cap truncate`, prefer the transcript for tool rows
when early `EMITTED` lines are missing.

| Id | Pass when |
|---|---|
| L0 | Log has a process header and `debug: enabled file=`. Note `log reinit` if multiple headers / append / size-cap |
| L1 | At least one `outbound Run:` and one `cache diagnosis:` |
| L2 | First completed turn: `turn usage validation: status=ok` |
| L3 | After the step-7 ask-tool return (or continue user line if no ask tool): `continuity=warm` **or** the same `prefixHash` as the previous real Run. If step 7 was skipped, this row is **failed** |
| L4 | `perModelCallCache=unavailable` |
| T1 | Scratch file / search / shell work succeeded |
| T2 | No schema rejection on the args you copied; if a working-directory field exists, step 3’s `pwd` used it and printed the scratch dir; dedicated search/list capabilities were used when advertised; exercise work used this session’s best available tools |
| T3 | Ask-user step completed via the listed ask tool (not chat text), or honestly skipped only when no ask tool existed |
| T4a–T4f | Matching 5a–5f outcomes (all required when a full-list tool exists); **five** list-tool calls for 5a/5c/5d/5e/5f; lifecycle once |
| T5 | Helper agent ran, or honestly skipped |
| T6 | Nothing required the provider to import `@opencode-compat/*` |
| T7 | You did not mark pass/skip while the opposite is true (an advertised capability was skipped, todo lifecycle replayed, step 8 started in the same tool loop as step 6, an unadvertised name was guessed, or a lower-quality substitute was used while the dedicated tool was available) |
| P1 | No Cursor-private bridge capability was advertised to Devin: no `cursor_*` on any host and no OCP-added `plan_enter` / `plan_exit` on Pi/OMP. DSH-native `exit_plan_mode` is allowed |
| P2 | No Cursor InteractionQuery plan/image/mode behavior or Cursor-only bridge call was emitted by Devin; cite the step-10 extract or transcript |
| H1 | Provider checkout not written |
| H2 | No `.opencode/` under scratch from plan tools |
| H3 | Only the scratch tree changed |

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
