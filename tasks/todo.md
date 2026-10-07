# TODO

- [ ] **Normalize plan mode across all hosts.** Entering plan mode, recording
  the plan in the host's own location, reviewing it, and executing it must
  behave the same way on OpenCode 1.x/2.0, Kilo, MiMo, OMP, pi, and DSH.
  Today OMP, pi, and DSH submit plans through the extra `cursor_plan_stage`
  tool (and redefine `plan_exit` as "leave without approval"), while OpenCode
  and the clones use the host `plan` agent plus `plan_exit` review. The
  provider should see one OpenCode-shaped plan contract everywhere, with every
  host-specific difference absorbed by OCP.
  Exception: omp plan review (`tasks/lessons.md`).
