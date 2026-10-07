# Current tool vocabulary

One current reference. Replace changed entries in place; retain no old schemas, aliases, or fallback calls. A tool is callable only when its exact name and schema are advertised for the current turn. Validate calls against the current source, advertised catalog, and loaded bridge.

`?` means optional; unmarked fields are required. Use the current schema's types, bounds, defaults, and operation-specific constraints, including those enforced in execution. JSON below is tool input, not a string containing JSON. OCP callers use the provider-facing catalog; native-host callers use the native catalog. Never mix their parameter names. Unlisted built-in, custom, and MCP tools use their complete current advertised schema and identity; do not infer their parameters from a similar tool. Sources are the linked local checkouts, not proof that an installed binary loads them.

## Files and commands

In this table `F` is the native file key. `read(F, offset?, limit?)`, `write(F, content)`, and `edit(F, oldString, newString, replaceAll?)` describe the OpenCode-shaped calls; differences are explicit below. Reads start at line 1. Empty write content or replacement text is valid.

| Host | Native file calls | Native command call | Declaration sources |
|---|---|---|---|
| OpenCode 1 | `F=filePath`; OpenCode-shaped read/write/edit | `bash(command, workdir?, timeout?)`; milliseconds; no description | `O1/read.ts:28`, `O1/write.ts:20`, `O1/edit.ts:47`, `O1/shell/prompt.ts:15` |
| OpenCode 2 | `F=path`; OpenCode-shaped read/write/edit | `shell(command, workdir?, timeout?, background?)`; milliseconds; zero disables timeout; no description | `O2/read.ts:17`, `O2/write.ts:23`, `O2/edit.ts:24`, `O2/shell.ts:47` |
| Kilo | `F=filePath`; OpenCode-shaped read/write/edit | `bash(command, workdir?, timeout?, description?)`; milliseconds | `K/read.ts:39`, `K/write.ts:24`, `K/edit.ts:74`, `K/shell/prompt.ts:23`; name: `K/shell/id.ts:16` |
| MiMo | `F=file_path`; read/write as above; `edit(file_path, old_string, new_string, replace_all?)` | `bash(command, description, workdir?, timeout?, max_output_tokens?, interactive?)`; milliseconds; description required | `M/read.ts:84`, `M/write.ts:30`, `M/edit.ts:49`, `M/bash.ts:143` |
| Pi | `read(path, offset?, limit?)`; `write(path, content)`; `edit(path, edits:[{oldText,newText}])`; nonempty array and oldText, with unique, nonoverlapping edits matched against the original file | `bash(command, timeout?)`; positive finite seconds, omitted means no timeout; no workdir or description. `powershell` uses the same input schema when advertised | `P/read.ts:14`, `P/write.ts:11`, `P/edit.ts:21`, `P/edit.ts:136`, `Pi:packages/coding-agent/src/core/tools/edit-diff.ts:311`, `P/bash.ts:27`, `P/bash.ts:40`, `P/powershell.ts:29` |
| OMP | `read(path)`; ranges are in `path`, e.g. `src/a.ts:raw:1-20`; `write(path, content?)`, with content required unless the target's URI handler explicitly permits omission; edit depends on active mode below | `bash(command, cwd?, timeout?, pty?)`; seconds. When enabled: `async?`, `name?`, `ready?:{log?,port?,host?,timeout?}`; readiness timeout also seconds. Service `name` excludes command `timeout` and `async:true`; no description | `O/read.ts:681`, `O/write.ts:194`, `O/write.ts:766`, `O/bash.ts:332`, `O/bash.ts:624`, `O/bash.ts:981`; `OMP:packages/coding-agent/src/launch/services.ts:238` |
| DSH | `F=file_path`; read/write as above; `edit(file_path, old_string, new_string, replace_all?)`; write/edit may also advertise sandbox fields | `bash(command, description, workdir?, timeoutMs?)`; milliseconds; description required. `run_in_background?`, `sandbox_permissions?`, `justification?` depend on the active catalog; escalation requires justification | `D/fs/tool-fs/src/read.ts:80`, `D/fs/tool-fs/src/write.ts:75`, `D/fs/tool-fs/src/edit.ts:87`, `D/shell/tool-bash/src/index.ts:377` |

OCP exposes `filePath` and targeted-edit `oldString`/`newString`; `replaceAll` is valid only when advertised (Pi omits it). Clone catalogs and replay are normalized before provider validation; native inputs are restored afterward. DSH's canonical shell description is optional and supplied at native execution; MiMo's remains required. Pi keeps native seconds and no working-directory field; OMP advertises `workdir` and milliseconds, then converts to native `cwd` and seconds. Sources: `packages/adapter/src/language-model.ts:348`, `packages/pi-bridge/src/translate/context.ts:83`, `packages/pi-bridge/src/translate/subagent.ts:767`, `packages/dsh-bridge/src/host/profile.ts:58`.

### OMP edit modes

These are current configured modes, not alternative retry formats. Read the active `edit` schema first.

| Active mode | Native input |
|---|---|
| replace | `{path, old_string, new_string, replace_all?}` |
| patch | `{path, edits:[{op?, rename?, diff?}]}`; `op` is `create`, `delete`, or `update` |
| apply_patch | `{input}` containing an apply-patch document |
| hashline | `{input}` containing the patch with current read-derived `[PATH#TAG]` snapshot headers |
| sloppy | `{input}` in that mode's advertised edit grammar |

Sources: `OMP:packages/coding-agent/src/edit/schemas.ts:3`, `OMP:packages/coding-agent/src/edit/index.ts:352`, `OMP:packages/coding-agent/src/edit/hashline-compact.md:1`. Custom-format catalogs use the advertised wire name/grammar (apply_patch mode exposes `apply_patch`); the table describes JSON inputs. Source: `OMP:packages/coding-agent/src/edit/index.ts:373`. OCP's canonical replacement overlay uses the active host writer in every native edit mode and requires nonempty `oldString`; native `{input}` patches delegate to the native executor. Do not pass flat replacements to hashline. Sources: `packages/pi-bridge/src/extension.ts:132`, `packages/pi-bridge/src/edit-replace-tool.ts:69`, `:123`.

## Search

| Host | Native calls | Declaration sources |
|---|---|---|
| OpenCode 1 / MiMo | `glob(pattern, path?)`; `grep(pattern, path?, include?)` | `O1/glob.ts:10`, `O1/grep.ts:10`; `M/glob.ts:21`, `M/grep.ts:21` |
| Kilo | `glob(pattern, path?)`; `grep(pattern, path?, include?, context?, limit?, literal?, ignoreCase?)`; context is a nonnegative integer, limit a positive integer | `K/glob.ts:28`, `K/grep.ts:11`; `Kilo:packages/opencode/src/kilocode/tool/grep-signal-controls.ts:6` |
| OpenCode 2 | `glob(pattern, path?, hidden?, limit?)`; `grep(pattern, path?, include?, literal?, caseSensitive?, limit?)` | `O2/glob.ts:17`, `O2/grep.ts:17`; `OpenCode 2:packages/core/src/filesystem.ts:72` |
| Pi | `find(pattern, path?, limit?)`; `ls(path?, limit?)`; `grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)` | `P/find.ts:26`, `P/ls.ts:11`, `P/grep.ts:21` |
| OMP | `glob(path?, hidden?, gitignore?, limit?)`, where path includes the glob; `grep(pattern, path?, case?, gitignore?, skip?)`; `skip` is a nonnegative number or null | `O/glob.ts:34`, `O/grep.ts:60` |
| DSH | `glob(pattern, path?)`; `grep(pattern, path?, include?)` | `D/fs/tool-fs-search/src/glob.ts:311`, `D/fs/tool-fs-search/src/grep.ts:288` |

OCP advertises Pi `find` as `glob`; OMP's provider-facing `glob(pattern,path?)` joins the root and pattern into native `path`. Pi’s provider-facing grep uses `include`, translated to native `glob`. OMP’s `include` joins the search root into native `path`; `caseSensitive` becomes native `case`. Search-root `path` is never a file-key alias. Sources: `packages/pi-bridge/src/host/profile.ts:197`, `packages/pi-bridge/src/translate/subagent.ts:731`, `packages/dsh-bridge/src/host/profile.ts:55`.

## Questions, delegation, task lists, and plans

`Q={question,header,options:[{label,description}],multiple?}` is the OpenCode question input. `T={content,status,priority}` is its task-list item; follow the current status/priority constraints. Optional host tools and extension tools below must actually be advertised.

| Host / role | Native call and meaning | Declaration sources |
|---|---|---|
| OpenCode 1 / Kilo / MiMo question | `question({questions:[Q]})` | `OpenCode 1:packages/schema/src/question.ts:22`; `K/question.ts:7`; `M/question.ts:7` and `MiMo:packages/cli/src/question/index.ts:26` |
| OpenCode 2 question | `question({questions:[Q]})`; nonempty questions | `O2/question.ts:23` |
| OMP question | `ask({questions:[{id,question,options:[{label,description?,preview?}],header?,multi?,recommended?}]})`; nonempty questions; recommended is a zero-based index; reserved runtime option labels are forbidden | `O/ask.ts:60`, `:66`, `:81` |
| DSH question | `ask_user_question({questions:[{id,question,header?,options?:[{label,description?}],multi_select?}],timeout?})`; `timeout` exists only in timed mode, is integer seconds, and `-1` waits indefinitely | `D/interaction/tool-ask-user/src/index.ts:33`, `:41`, `D/interaction/tool-ask-user/src/timed.ts:107`, `:145`; `D/interaction/user-questions/src/projection.ts:36` |
| Pi question | No built-in question tool; only the exact tool supplied by an active extension | `P/index.ts:95` |
| OpenCode 1 / Kilo delegation | `task({description,prompt,subagent_type,task_id?,command?,background?})`; current agent names only; task_id resumes a child session. Kilo adds `model?,provider?,variant?` (string or null); provider requires model; background is advertised only when enabled | `O1/task.ts:43`; `K/task.ts:54`, `:533`; `Kilo:packages/opencode/src/kilocode/tool/task.ts:38` |
| OpenCode 2 delegation | `subagent({agent,description,prompt,model?,sessionID?,background?})` | `O2/subagent.ts:29` |
| MiMo delegation | `actor({operation:{action:"run",description,prompt,subagent_type,model?,timeout_ms?,command?,task_id?,output_schema?}})` waits; `spawn` has the same fields except no timeout_ms. `status/wait/cancel` require `actor_id`; only wait also accepts `timeout_ms?`. `send` requires `to_actor_id,content`, accepts `to_session_id?,type?`; `models` accepts `vision?,limit?`. `task_id` binds a work item; `actor_id` identifies an actor | `M/actor.ts:100`, `:131`, `:161`, `:177`, `:201` |
| Pi delegation extension | Exactly one mode: single `{agent,task,cwd?}`, parallel `{tasks:[{agent,task,cwd?}]}`, or sequential `{chain:[{agent,task,cwd?}]}`; all allow `agentScope?` (user/project/both, default user), `confirmProjectAgents?` (default true). Arrays must be nonempty to select a mode | `Pi:packages/coding-agent/examples/extensions/subagent/index.ts:442`, `:459`, `:493` |
| OMP delegation | Active single input includes `task,solutionSpace,agent?`; batch includes nonempty `context,tasks:[{task,solutionSpace,agent?,...}]` and forbids top-level model. Current dynamic schema controls optional name/model/outputSchema/schemaMode/tools/isolated/effort and the default agent | `OMP:packages/coding-agent/src/task/types.ts:48`, `:125`, `:206`; `OMP:packages/coding-agent/src/task/index.ts:683`, `:277` |
| OMP child result | Ordinary `yield({type?,data?,error?})`: type is a terminal string or incremental nonempty string array; success data matches the full output or named section schema; data/error exclude each other; successful omission of data requires type. Work-pool mode instead requires `yield({key,data?,error?})`, with an advertised 1-based key and exactly one of data/error | `O/yield.ts:122`, `:227`, `:253`, `:323`, `:453` |
| DSH delegation | `subagent({description,prompt,run_in_background?})`; route fields appear only when advertised; native background defaults true in continuable mode, false otherwise. OCP's canonical `background` defaults false and becomes native `run_in_background:false`; no native agent/resume-id field | `D/subagent/tool-subagent/src/index.ts:389`; `packages/dsh-bridge/src/host/profile.ts:130` |
| OpenCode 1 / Kilo task list | `todowrite({todos:[T]})` replaces the list | `O1/todo.ts:6`, `K/todo.ts:9`; `OpenCode 1:packages/schema/src/session-todo.ts:7` |
| MiMo task list | `task({operation:{action:"create",summary,parent_id?,session_id?}})`; `list` accepts `status?,include_terminal?,include_archived?,session_id?`; status is open/in_progress/blocked/done/abandoned. `get/start/block/unblock/done/abandon` require `id`; lifecycle actions additionally accept `event_summary?`; `rename` requires `id,summary`; all accept `session_id?`. `task` never delegates | `M/task.ts:10`, `:12`, `:27`, `:33`, `:68` |
| OMP task list | `todo({op:"init",items:["Read source"]})` or phased `list:[{phase,items}]`; items must be nonempty and task contents unique. `start` requires verbatim task content; `block/unblock` require task or phase; `done/drop/rm` target task, phase, or the whole list when both omitted. `append` requires phase and nonempty items; `view` reads; `reason?` is a blocker note | `O/todo.ts:60`, `:294`, `:308`, `:345`, `:380`, `:399` |
| DSH task list | `todo_write({todos:[{content,status}]})`; status is `pending`, `in_progress`, or `completed`; replaces the list | `D/todo/tool-todo/src/index.ts:138` |
| OpenCode 1 / MiMo plan review | `plan_exit({})` submits the session plan for execution approval | `O1/plan.ts:13`, `O1/plan.ts:31`, `M/plan.ts:29` |
| Kilo planning completion | `plan_exit({path?})`; optional workspace-local finalized plan path; requires a locatable plan file. Completes the planning turn; its success is not execution approval | `K/plan.ts:1`; `Kilo:packages/opencode/src/kilocode/tool/plan.ts:8`, `:32`, `:51`; review: `Kilo:packages/opencode/src/session/prompt.ts:1594`, `Kilo:packages/opencode/src/kilocode/plan-followup.ts:513` |
| OpenCode 2 plan mode | Native plan/build agent selection; built-in registration supplies no `plan_enter`/`plan_exit` tools | `OpenCode 2:packages/core/src/plugin/internal.ts:213`; `OpenCode 2:packages/core/src/plugin/plan.ts:33` |
| OMP bridged plan review | When plan support is enabled: `plan_enter({})`, then `cursor_plan_stage({plan_uri,content,title})`; stage requires active planning. `plan_exit({})` leaves without submitting review | `packages/pi-bridge/src/cursor-host-tools.ts:364`, `:389`, `:401` |
| Pi bridged plan review | `plan_enter({})`, `cursor_plan_stage({plan_uri,content,title})`, `plan_exit({})`; execution requires the installed plan-mode extension. Stage writes/displays the plan and invokes its review tool; plan_exit leaves without review | `packages/pi-bridge/src/cursor-host-tools.ts:456`, `:545`; `packages/pi-bridge/src/pi-plan-mode.ts:534` |
| DSH plan review | Native `exit_plan_mode({plan})`, with complete Markdown starting with `#`; requires active planning and a user-questions channel. OCP normalizes the provider-facing stage call | `D/plan/plan-mode/src/index.ts:280`, `:295`; `packages/dsh-bridge/src/cursor-plan-tools.ts:72` |

OCP exposes delegation as `task` on clone/Pi paths, while MiMo's work-item tracker becomes `todowrite`/`todoread`. OMP `todo` is advertised as `todowrite`/`todoread`: a snapshot whose rows match the latest `todo` result's `details.phases` in order becomes only `start`/`done`/`drop`/`rm` (or `view`), otherwise `init` followed by `done`/`drop`/`start` (`packages/pi-bridge/src/translate/subagent.ts:720`, `:610`). DSH advertises `subagent`. OMP `ask` and DSH `ask_user_question` become `question`; Pi does not gain a question capability merely because Cursor has one. MiMo canonical `task_id` resumes through native `send`, then `wait` after successful delivery; it never appears in `run`/`spawn`. OMP supplies required `solutionSpace` and wraps one canonical task in `context`/`tasks` when the active schema is batch; context carries its description or prompt and must be nonempty. OCP foreground delegation collects owner-scoped async results before continuing the provider and persists them through the public session API. Its text completion submits `yield({type:"result"})` only for unconstrained ordinary output; structured/work-pool calls use the advertised native schema. Kilo retains `plan_exit` and its native post-turn approval flow; completing the tool alone never approves execution. DSH keeps enabled route fields and timed-question `timeout`; a canonical question without a duration blocks with `timeout:-1` in timed mode. Sources: `packages/adapter/src/vocabulary.ts:461`, `packages/adapter/src/language-model.ts:746`, `packages/pi-bridge/src/translate/subagent.ts:356`, `:278`, `packages/dsh-bridge/src/translate/tools.ts:17`, `:179`, `packages/profile/src/drafts.ts:129`, `packages/pi-bridge/src/omp-task-results.ts:35`, `packages/pi-bridge/src/translate/question.ts:30`, `packages/pi-bridge/src/translate/subagent.ts:308`, `packages/dsh-bridge/src/host/profile.ts:112`.


## Other calls

| Host / tool | Current input | Declaration sources |
|---|---|---|
| OpenCode 1 / Kilo / MiMo `skill` | `{name}` | `O1/skill.ts:8`, `K/skill.ts:16`, `M/skill.ts:11` |
| OpenCode 2 `skill` | `{id}` | `O2/skill.ts:12` |
| OpenCode 1 / Kilo `apply_patch`; OpenCode 2 `patch` | `{patchText}` containing the patch document | `O1/apply_patch.ts:18`, `K/apply_patch.ts:22`, `O2/patch.ts:21` |
| MiMo `apply_patch` | `{patch_text}` containing the nonempty patch document | `M/apply_patch.ts:20`, `:33` |
| OpenCode 1 / Kilo / MiMo / OpenCode 2 `webfetch` | `{url,format?,timeout?}`; format is `text`, `markdown`, or `html`, default markdown; timeout is seconds | `O1/webfetch.ts:13`, `K/webfetch.ts:14`, `M/webfetch.ts:14`, `O2/webfetch.ts:23` |
| OpenCode 1 / Kilo `websearch` | `{query,numResults?,livecrawl?,type?,contextMaxCharacters?}`; current enums come from the declaration/catalog | `O1/websearch.ts:10`, `K/websearch.ts:15` |
| MiMo `websearch` | Same search fields plus `timeout?` in seconds | `M/websearch/index.ts:15` |
| OpenCode 2 `websearch` | `{query}` | `O2/websearch.ts:24` |
| OpenCode 2 `execute` | `{code}` containing Code Mode JavaScript; await calls using exact paths from its own Code Mode catalog | `OpenCode 2:packages/codemode/src/codemode.ts:65`; `OpenCode 2:packages/core/src/codemode/tool.ts:62`, `:71` |
| Advertised `cursor_image_save` | `{image_id}` with a pending single-use opaque handle, never a path or content | `cursor-opencode-provider:src/opencode2/image-save-tool.ts:8`; `packages/pi-bridge/src/cursor-host-tools.ts:72`; `packages/dsh-bridge/src/cursor-image-tool.ts:34` |

## Skills

A skill catalog names the skills a model may load. `C1` is OpenCode 1's verbose entry `<skill><name/><description/><location/></skill>` inside `<available_skills>`; `C2` is OpenCode 2's `<skill><id/><name/><description/></skill>`. The location is the host's own address for a skill; OCP adds none. Native `skill` tool inputs are in Other calls.

| Host | Catalog placement and shape | Native location | Native loader | Declaration sources |
|---|---|---|---|---|
| OpenCode 1 | System prompt, `C1`; skills denied to the agent are omitted, `ask` ones stay | Absolute path; built-ins `<built-in>` | `skill({name})` asks `skill` permission; returns `<skill_content>` with base directory and `<skill_files>` | `OpenCode 1:packages/opencode/src/skill/index.ts:281`, `:313`, `:321`; `OpenCode 1:packages/opencode/src/session/system.ts:106`; `O1/skill.ts:27`, `:47` |
| OpenCode 2 | System prompt, `C2`; changes arrive as an update listing added/removed ids or a superseding list | No catalog location; `Skill.Info.path` via plugin `skill.list()`; built-ins `/builtin/*.md` | `skill({id})` asserts permission; returns `<skill_content>` with base directory | `OpenCode 2:packages/core/src/skill/instructions.ts:16`, `:25`, `:35`; `OpenCode 2:packages/schema/src/skill.ts:27`; `OpenCode 2:packages/core/src/plugin/host.ts:444`; `OpenCode 2:packages/core/src/plugin/skill.ts:33`; `O2/skill.ts:13`, `:51`; `OpenCode 2:packages/core/src/skill.ts:39` |
| Kilo | System prompt, `C1` | Absolute path; built-ins `builtin` | `skill({name})` | `Kilo:packages/opencode/src/skill/index.ts:30`, `:401`, `:408`; `Kilo:packages/opencode/src/session/system.ts:163`; `K/skill.ts:20` |
| MiMo | System prompt tail after "Skills available in this session:", `C1` | `file:` URL; built-ins are extracted to disk | `skill({name})` | `MiMo:packages/cli/src/skill/index.ts:196`, `:382`, `:389`; `MiMo:packages/cli/src/session/system.ts:183`; `M/skill.ts:12` |
| Pi | System prompt, `C1`-shaped (`<name>`, `<description>`, `<location>`, XML-escaped); hidden skills omitted | File path | `read` of the location; no skill tool | `Pi:packages/coding-agent/src/core/skills.ts:358`, `:381`; `Pi:packages/coding-agent/src/core/system-prompt.ts:180` |
| OMP | System prompt, `<skills>` with `- name: description`; listed only when a tool can read `skill://` | `skill://<name>` | `read` of `skill://<name>`; no skill tool | `OMP:packages/coding-agent/src/prompts/system/system-prompt.md:42`; `OMP:packages/coding-agent/src/system-prompt.ts:416`, `:934` |
| DSH | User-role `<system-reminder>` with `` - `name`: description `` lines; a later catalog replaces every earlier one | Public `skills.list()` `SkillSummary.path`; absent for virtual skills | `skill({name})`; loaded body appears as `<skill_content>` | `D/skill/tool-skill/src/index.ts:85`, `:254`, `:279`; `D/skill/skill/src/index.ts:57` |

OCP passes clone and Pi-family catalogs unchanged apart from catalog tool-name renames. DSH's latest catalog reminder moves into the system prompt for every bridged provider; requests that offer DSH file tools also state the home directory, because DSH does not expand `~`. Sources: `packages/dsh-bridge/src/translate/context.ts:100`, `:114`.

## Calling examples

When Cursor discovers these tools dynamically, its `inputSchema` describes the
inner `arguments`. Keep the exact discovered `namespace` and `toolName` beside
that object on every `CallDynamicTool` invocation. Source:
`cursor-opencode-provider:src/protocol/tools.ts:3647`.

| Call site | Exact example |
|---|---|
| OCP provider-facing read | `read({"filePath":"src/a.ts","offset":1,"limit":20})` |
| MiMo native read | `read({"file_path":"src/a.ts","offset":1,"limit":20})` |
| Pi native replacement | `edit({"path":"src/a.ts","edits":[{"oldText":"before","newText":"after"}]})` |
| OMP native range read | `read({"path":"src/a.ts:raw:1-20"})` |
| OpenCode 2 command | `shell({"command":"pwd","workdir":"src","timeout":1000})` |
| MiMo command | `bash({"command":"pwd","description":"Show working directory","timeout":1000})` |
| OMP command | Provider `bash({"command":"pwd","workdir":"src","timeout":1000})` → native `bash({"command":"pwd","cwd":"src","timeout":1})` |
| MiMo native work-item read | `task({"operation":{"action":"list","include_terminal":true}})` |

Examples follow the declarations above. Replace file paths with real targets; obtain current agent names, ids, and hash tags from the host. An unavailable tool is unavailable: skip an optional test or report the missing required capability, without trying another name or schema.

## Source index and upkeep

Source keys identify read-only host sources; paths after a key are relative to its base. OCP paths are relative to this repository.

| Key | Base | Inventory to check for added/removed tools |
|---|---|---|
| O1 | `OpenCode 1:packages/opencode/src/tool/` | `registry.ts` |
| O2 | `OpenCode 2:packages/core/src/tool/plugin/` | `OpenCode 2:packages/core/src/plugin/internal.ts:213` and `OpenCode 2:packages/core/src/tool.ts:225` (direct vs Code Mode and permission gating) |
| K | `Kilo:packages/opencode/src/tool/` | `registry.ts` and `kilocode/tool/registry.ts` relative to `packages/opencode/src/` |
| M | `MiMo:packages/cli/src/tool/` | `registry.ts` |
| P | `Pi:packages/coding-agent/src/core/tools/` | `index.ts` and registered extensions |
| O | `OMP:packages/coding-agent/src/tools/` | `index.ts`, `task/types.ts`, `edit/schemas.ts` relative to `packages/coding-agent/src/` |
| D | `DSH:packages/` | `D/bundle/base/cordis.patch.yml:267` plus active preset/plugin registrations and the declarations above; timed questions and sandbox/background settings change schemas |

Before changing a tool bridge/validator, reviewing a harness failure, or testing an upgraded host: follow declaration re-exports/spreads, live schema getters, registration gates, and executor checks; compare with the active catalog, then this document. Changes to names, required keys, nesting, enums, defaults, units, mode-specific schemas, availability, or approval meaning require replacing the affected entry and example. Re-read changed anchors; matching names alone do not prove matching behavior.

Validate the caller's input against its advertised schema, the translated input against the native schema, and replay against the provider schema. Check actual results and side effects; a successful retry does not erase an invalid earlier call. Rebuild, refresh wiring, and restart before validating a source change. Update this single document in the same change; do not add dated copies, compatibility alternatives, or a second vocabulary elsewhere.
