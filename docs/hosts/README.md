# Host enablement notes

OCP is an **external compatibility layer** — hosts are read-only references. It
attaches three different ways depending on the host family, and there is one page
per family. Never unify the mechanisms.

| Family | Host | How OCP attaches | Upstream (read-only) |
|--------|------|------------------|----------------------|
| [**OpenCode clones**](./opencode-clones.md) | **MiMo** (`mimocode`) | Facades + universal adapter, wired by `ocp setup` | [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) |
| | **Kilo** (`kilocode`) | Facades + universal adapter, wired by `ocp setup` | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) |
| | **ZCode** | **Not a load target** — detect / doctor only | [Z.AI ZCode](https://docs.z.ai/) |
| [**Pi family**](./pi-family.md) | **pi** (earendil-works) | `@opencode-compat/pi-bridge` → `pi.registerProvider(...)` | [earendil-works/pi](https://github.com/earendil-works/pi) |
| | **oh-my-pi** / omp (can1357) | `@opencode-compat/pi-bridge` → `pi.registerProvider(...)` | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) |
| [**DSH family**](./dsh-family.md) | **DeepSeek Harness** (`dsh`) | `@opencode-compat/dsh-bridge` → `ctx.llm.registerAdapter(...)` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |

## [opencode-clones.md](./opencode-clones.md) — MiMo, Kilo, ZCode

These hosts ship their own OpenCode-shaped native plugin package
(`@mimo-ai/plugin`, `@kilocode/plugin`). An unmodified plugin's
`@opencode-ai/plugin` / `@opencode-ai/sdk` imports are remapped to OCP *facades*
that delegate to the host's native package via one universal adapter driven by
`HostProfile` data. Wiring is install-tree overrides written by **`ocp setup`** —
a host `plugin` list entry for OCP alone is not enough.

ZCode is covered on the same page: its Agent Mode marketplace ABI
(`.zcode-plugin`) is not the `@opencode-ai/plugin` ABI, so facades do not apply.
`ocp doctor --host zcode` explains the refusal; `ocp migrate-zcode` is a
companion asset packer, not compatibility.

The page contains install (npm and local dev), per-host internals — install
tree, profile capabilities, Option B provider shims, project dirs, the Promise
v2 operator sidecar, telemetry — and troubleshooting.

## [pi-family.md](./pi-family.md) — pi, oh-my-pi

These hosts are not OpenCode forks and have no `@opencode-ai/plugin`-shaped
package, so there is nothing to facade. `@opencode-compat/pi-bridge` instead
loads the unmodified plugin dynamically and registers it through the host's own
`pi.registerProvider(...)` seam, translating AI-SDK `doStream` to and from the
host's event stream. The `ocp` CLI is not involved.

Host differences (package names, dynamic-model hook, OAuth requirements,
thinking-level shape) are data in
[`packages/pi-bridge/src/host/profile.ts`](../../packages/pi-bridge/src/host/profile.ts);
the full config reference and difference table are in the
[pi-bridge README](../../packages/pi-bridge/README.md).

## [dsh-family.md](./dsh-family.md) — DeepSeek Harness

DSH is not an OpenCode fork and not Pi. It has no `@opencode-ai/plugin`-shaped
package, so there is nothing to facade. `@opencode-compat/dsh-bridge` is a
Cordis plugin that loads the unmodified OpenCode plugin and registers it
through `ctx.llm.registerAdapter(...)`, translating AI-SDK `doStream` to DSH
`StreamChunk`. The `ocp` CLI is not involved.

Host variance is data in
[`packages/dsh-bridge/src/host/profile.ts`](../../packages/dsh-bridge/src/host/profile.ts).
The package contract is the
[dsh-bridge README](../../packages/dsh-bridge/README.md).
