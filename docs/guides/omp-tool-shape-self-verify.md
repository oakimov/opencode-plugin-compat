# omp tool-shape self-verify prompt

Paste-ready agent prompt that checks the **omp-specific** OpenCode → host
folds recently fixed in `@opencode-compat/pi-bridge`:

| Area | What broke before | Bridge fix |
|------|-------------------|------------|
| **Read paging** | Cursor `{offset,limit}` rejected / ignored; omp only accepts `path` | `inputShape: "opencode-read"` → `path:raw:N-M` (raw disables host context padding) |
| **Replace edit** | Under default hashline mode, OpenCode `{oldString,newString}` could not run as live `{input}` | replace overlay + advertised flat `edit` |
| **Hashline** | Parallel same-tag hunks burned snapshot history; eviction looked like fabrication | separate `hashline` tool, coalesce, overlap/eviction restatement — **H2 requires two concurrent same-tag calls** |
| **Todos** | Cursor `{todos:[…]}` → `op must be operation to apply (was missing)` | `inputShape: "opencode-todo"` → `init` / `rm` / `view` |

This is **not** the full Cursor+OCP acceptance suite. For warm-cache /
plan / subagent / provider-log scoring, use
[`cursor-ocp-self-verify.md`](./cursor-ocp-self-verify.md).

Operator setup is not part of the paste. Do it first.

## Operator setup

1. Wire **omp** from this repo:

   ```bash
   ./scripts/ocp-dev.sh run omp
   ```

   Confirm the slot with `.claude/skills/ocp-dev/SKILL.md`, then **restart**
   omp so it loads the new bridge.

2. Start stock **omp** in a TUI on a throwaway workspace (not this repo, not
   the provider checkout). Prefer a cheap Cursor model for the smoke.

   Optional debug log (useful if a case fails):

   ```bash
   export CURSOR_PROVIDER_DEBUG=1
   export CURSOR_PROVIDER_DEBUG_FILE=/tmp/omp-tool-shape-self-verify.log
   ```

3. Stay in **one** omp session for the whole prompt. Do not change
   `edit.mode` / `PI_EDIT_VARIANT` unless a case asks you to — default
   hashline-mode sessions are the point of the replace-overlay check.

4. After the agent finishes, keep the scratch dir and any debug log until
   you accept the report.

---

## Agent prompt

Copy everything below this line into the omp session.

---

You are verifying that **omp + OCP pi-bridge** correctly folds OpenCode /
Cursor tool shapes for **read paging**, **replace edit**, **hashline**, and
**todos**. Do real tool work under a scratch directory, then score each
case from **transcript + side effect**. Unit tests and memory are not
evidence.

### Constraints

- Do not edit omp source, installed omp binaries, the OCP repo, or the
  provider checkout.
- Work only under a scratch directory you create, e.g.
  `/tmp/omp-tool-shape-$USER/`. Delete it at the end if every write you made
  is inside it.
- Prefer the **OpenCode / Cursor** argument shapes when a tool advertises
  them (`filePath`, `offset`/`limit`, `oldString`/`newString`,
  `todowrite` + `{todos:[…]}`). Do not “help” the host by inventing omp-native
  shapes unless a case explicitly asks for `hashline`.
- If a required tool is missing from the catalog, mark that case `blocked`
  with the advertised names — do not invent a substitute.
- Do not print secrets. Do not dump any debug log into the conversation.

### Setup

1. Create the scratch dir.
2. Record host (`omp`), model id, and session id if shown.
3. Confirm you see provider-facing tools roughly like: `read`, `write`,
   `edit`, `hashline`, `todowrite`, `todoread` (plus shell/search as usual).
   Fail early if `edit` is missing or only a raw omp `{input}` hashline schema
   is advertised with no flat `oldString`/`newString` fields and no separate
   `hashline` tool.

### Cases (do in order, same session)

#### R1 — Full read (alias)

- `write` `alpha.txt` with **exactly 30 lines**: `LINE_0001` … `LINE_0030`
  (zero-padded).
- `read` it with OpenCode-style args if available (`filePath` or `path`).
- **Pass:** full contents come back; no schema rejection on `filePath`.

#### R2 — Paged read (`offset` / `limit` → `path:raw:N-M`)

- Call `read` on `alpha.txt` with **`offset: 10` and `limit: 5`** (1-based
  OpenCode paging: expect lines `LINE_0010` … `LINE_0014`).
- Use separate `offset` / `limit` fields — do **not** manually build a
  `path:10-14` / `path:raw:10-14` selector.
- **Pass:** returned text includes `LINE_0010` and `LINE_0014`, does **not**
  include `LINE_0009` or `LINE_0015` (omp's default ranged-read context
  padding must not leak), and the call did not fail with an
  unrecognized-argument / invalid-`path` style error.
- **Fail:** host error about unknown `offset`/`limit`, a silent full-file
  dump, or context padding (`LINE_0009` / `LINE_0015`…`LINE_0017`).

#### E1 — Replace edit under default hashline mode

- Using the **`edit`** tool (not `hashline`), change one unique line in
  `alpha.txt` with OpenCode flat args, e.g.
  `{ filePath, oldString: "LINE_0020", newString: "LINE_0020_EDITED" }`
  (or `path` / `old_string` / `new_string` if that is what the catalog shows).
- `read` the file (full or a small page covering that line).
- **Pass:** file contains `LINE_0020_EDITED`; call succeeded without asking
  you to supply a hashline `[path#tag]` patch on `edit`.
- **Fail:** schema error expecting `input`, or “hashline patch” required on
  the `edit` tool.

#### H1 — Hashline apply

- `read` `alpha.txt` again (or whatever host step mints a hashline snapshot /
  tag in the tool result). Note a `[path#TAG]` (or equivalent) from the
  tool output if present.
- Using the **`hashline`** tool, apply a small patch that changes
  `LINE_0025` → `LINE_0025_HASH` with a valid tagged patch for this session.
- `read` back the line.
- **Pass:** `LINE_0025_HASH` is on disk; `hashline` (not `edit`) performed the
  apply.
- **Fail:** `hashline` missing; patch rejected as “not from this session”
  on a tag the host just minted without a clearer eviction restatement; or
  you had to misuse `edit` to send a hashline document.

#### H2 — Concurrent same-tag hashline (required)

This case exists to catch the pre-coalesce failure: two parallel / same-turn
`hashline` applies that share one `[path#TAG]` burned omp’s short snapshot
history and the second hunk died with “tag not from this session”.

**You must exercise two separate `hashline` tool calls.** Do not pass this
item with a single multi-section patch.

1. `read` `alpha.txt` so the host mints a fresh snapshot / tag. Record the
   exact `[path#TAG]` from that result (or from H1’s successful apply output
   if it still names a live tag — prefer a **fresh** read right before these
   two calls).
2. In **one assistant turn**, emit **exactly two** `hashline` tool calls
   (parallel if the host allows; otherwise back-to-back in the same turn
   before you see either result if the harness batches them):
   - Call A: only `LINE_0003` → `LINE_0003_H2`, using that **same** tag.
   - Call B: only `LINE_0008` → `LINE_0008_H2`, using that **same** tag.
3. Each call’s patch body must be a **single-hunk** document. Do **not**
   pre-merge both hunks into one `hashline` `input`. Do **not** use `edit`
   for either line.
4. After both results return, `read` the file (or the two lines) and confirm
   both suffixes are on disk.

- **Pass:** transcript shows **two** `hashline` calls with the same tag;
  both succeed (or coalesce into one successful host apply); disk has
  `LINE_0003_H2` and `LINE_0008_H2`; no fatal “tag not from this session”
  that leaves one line unchanged.
- **Fail:** only one `hashline` call; you merged both hunks yourself to
  avoid concurrency; second call rejected and one line missing; or you used
  `edit` instead.
- **blocked:** `hashline` not advertised. Do **not** mark `skipped` because
  a single merged patch was easier.

#### T1 — Todo snapshot write (`todowrite`)

- Call **`todowrite`** with an OpenCode snapshot body — **no** `op` field:

  ```json
  {
    "todos": [
      { "content": "omp-shape-a", "status": "in_progress" },
      { "content": "omp-shape-b", "status": "pending" }
    ]
  }
  ```

- **Pass:** tool succeeds. Transcript must **not** contain
  `op must be operation to apply (was missing)` (or equivalent).
- **Fail:** that error, or you “fixed” it by switching to omp-native
  `{op:"init",…}` yourself.

#### T2 — Todo read + clear

- Call **`todoread`** (empty args). Confirm both items are visible in some
  form (exact formatting may be host-native).
- Call **`todowrite`** again with only completed/cancelled items, or an
  empty `todos: []`, still **without** sending `op` yourself — e.g.

  ```json
  {
    "todos": [
      { "content": "omp-shape-a", "status": "completed" },
      { "content": "omp-shape-b", "status": "cancelled" }
    ]
  }
  ```

- `todoread` again.
- **Pass:** read/clear path works; still no missing-`op` errors; plugin-facing
  names stay `todowrite` / `todoread` (not a raw fork tracker name).

### Scoring

For every item: `passed` / `failed` / `skipped` / `blocked`. Cite transcript
or file evidence. No cite → not passed.

| Id | What must be true |
|---|---|
| R1 | Full read of 30-line file works; camelCase `filePath` ok if used |
| R2 | `offset:10` + `limit:5` returns only `LINE_0010`…`LINE_0014` |
| E1 | Flat OpenCode `edit` replaced a line under default hashline mode |
| H1 | `hashline` tool applied a tagged patch successfully |
| H2 | Two same-tag `hashline` calls in one turn; both lines updated (coalesce path) |
| T1 | `todowrite` snapshot without `op` succeeded |
| T2 | `todoread` + clear/terminal snapshot worked; canonical todo names |
| H3 | Scratch dir is the only tree you changed |

### Report format

```
host: omp
model:
session:
scratch:

| id | result | evidence |
|----|--------|----------|
| R1 |        |          |
| R2 |        |          |
| E1 |        |          |
| H1 |        |          |
| H2 |        |          |
| T1 |        |          |
| T2 |        |          |
| H3 |        |          |

verdict: pass | fail
notes:
```

`verdict` is `pass` only if R1, R2, E1, H1, **H2**, T1, T2, and H3 all
`passed`. H2 is **not** skippable via a single merged patch. End with that
table.

---
