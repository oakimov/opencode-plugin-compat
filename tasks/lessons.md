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
