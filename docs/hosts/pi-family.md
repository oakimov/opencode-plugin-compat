# Pi family — `pi` and `oh-my-pi` (omp)

The Pi family: [`pi`](https://github.com/earendil-works/pi) (earendil-works)
and [`oh-my-pi`](https://github.com/can1357/oh-my-pi) (**omp**, a fork of pi).
OCP runs **unmodified** OpenCode `aisdk`-type plugins as providers on either
host.

The authoritative reference for this flow is
[`packages/pi-bridge/README.md`](../../packages/pi-bridge/README.md) — read it
for the full config reference and host-difference table. This page is the
family overview plus install/verify.

---

> ## ⚠️ omp: MCP servers need `tools.xdev false`
>
> ```bash
> omp config set tools.xdev false
> ```
>
> Under omp's default `tools.xdev: true`, every non-essential tool — **all MCP
> server tools included** — is mounted behind an `xd://` device URL and left out
> of `Context.tools`. The bridge and the provider can only advertise what the
> host puts in that list, so the model never receives MCP tools as callable and
> will report that it has none.
>
> This reads like a bridge bug and is not one: the servers connect normally,
> list in `/mcp`, and execute on demand. Only their presentation to the model
> changes.

---

## Mechanism: `pi-bridge`, not facades

Pi-family hosts are **not** OpenCode forks (omp is a fork of pi) and have no
`@opencode-ai/plugin`-shaped native package, so the facade→native-plugin
delegation OCP uses for OpenCode clones (MiMo, Kilo) does **not** apply. The
`ocp` CLI / install-tree overrides are not involved.

Instead, [`@opencode-compat/pi-bridge`](../../packages/pi-bridge/README.md)
**dynamically loads** the plugin package and registers it through the host's
own extension seam, `pi.registerProvider(...)`. Every detail except the package
name is discovered from conventions the plugin already implements:

| Discovered | From the plugin's own… |
|---|---|
| provider id | `auth.provider` (else the package name) |
| model catalog | `config` hook — `config.provider[id].models`, models.dev entry shape |
| OAuth login | `auth.methods[]` where `type: "oauth"` — `authorize() → {url, callback()}` |
| API-key login | `auth.methods[]` where `type: "api"` — `prompts[]` driven through the host's `onPrompt` |
| token refresh | `auth.loader` — plugins renew in-place and persist via `client.auth.set`, which the bridge captures |
| streaming | the plugin's `createXxx()` AI-SDK factory |
| model variants | the plugin's `variants` map + entry `options` |

Each host's package manifest selects its explicit bridge entrypoint. Generic or
programmatic loading falls back to probing which `pi-ai` package resolves
(`@oh-my-pi/pi-ai` vs `@earendil-works/pi-ai`), while
`PI_BRIDGE_HOST=omp|pi` remains an explicit override. Provider-id collisions
are handled: a *derived* id that would shadow a host built-in is suffixed
(`cursor` → `cursor-opencode`) with a logged explanation.

---

## Install via npm

Install the published `@opencode-compat/pi-bridge` through the host's own
extension installer, then register providers by config:

```bash
omp plugin install @opencode-compat/pi-bridge   # oh-my-pi
pi install npm:@opencode-compat/pi-bridge       # pi
```

`pi-bridge` ships in the same `0.2.x` train as the rest of `@opencode-compat/*`.
Installed this way its dependencies resolve normally — no linking needed.

The provider package you name in the config is a separate install. Add it the
same way, so it resolves from the bridge's own tree:

```bash
omp plugin install cursor-opencode-provider     # oh-my-pi
pi install npm:cursor-opencode-provider         # pi
```

---

## Development helper scripts

The recommended local/npm switch is automated from this repository root:

```bash
./scripts/ocp-dev.sh run pi
./scripts/ocp-dev.sh run pi --mode npm
./scripts/ocp-dev.sh run omp
./scripts/ocp-dev.sh run omp --mode npm
```

`local` installs locked dependencies, builds the local bridge and provider,
registers the bridge through the host's native package manager, links the
selected host's `pi-ai` runtime into the real bridge checkout, and points the
matching `pi-bridge.json` provider entry at the provider's absolute
`dist/index.js`. `npm` installs both published packages and switches that entry
back to its bare npm package name. Unrelated providers and optional fields on
the selected entry are preserved. Neither mode invokes `ocp setup`.

Defaults and overrides:

| Variable | Meaning |
|---|---|
| `OCP_DEV_PROVIDER_PATH` | Local provider checkout; default is a sibling checkout or `~/Projects/cursor-opencode-provider` |
| `OCP_DEV_PLUGIN` | Provider npm name; default `cursor-opencode-provider` |
| `OCP_DEV_BRIDGE_VERSION` | Published bridge version; default `latest` |
| `OCP_DEV_PLUGIN_VERSION` | Published provider version; default `latest` |
| `PI_BRIDGE_CONFIG` | Explicit bridge config file |
| `PI_CODING_AGENT_DIR` | Agent directory used when the config-file override is absent |

The package manifest supplies different Pi and OMP entry files, so local
checkout detection stays correct even when both hosts' development packages
are resolvable.

---

## Manual local development

Two separate concerns — don't conflate them.

**1. Make the host discover this extension** (from a git checkout of OCP):

```bash
git clone https://github.com/oakimov/opencode-plugin-compat.git
cd opencode-plugin-compat
bun install
bun run build

omp plugin install <path-to>/opencode-plugin-compat/packages/pi-bridge   # oh-my-pi
pi install <path-to>/opencode-plugin-compat/packages/pi-bridge           # pi
```

**2. Point config directly at the provider's built module.** A host install-tree
sibling is not visible from the real bridge checkout, while an absolute module
path has unambiguous ESM resolution:

```bash
# pi-bridge.json
{
  "providers": [
    { "package": "/absolute/path/to/cursor-opencode-provider/dist/index.js" }
  ]
}
```

**3. Link the running host's `pi-ai` package into the real bridge checkout.**
Its location depends on how the host CLI was installed. The helper scripts
resolve the CLI symlink, support nested and hoisted package layouts, and refuse
to overwrite a real package directory, so they are the preferred way to apply
this step.

---

## Configuration

Config lives at `$PI_BRIDGE_CONFIG`, else `$PI_CODING_AGENT_DIR/pi-bridge.json`,
else `pi-bridge.json` in the running host's agent dir (`~/.omp/agent` on omp,
`~/.pi/agent` then `~/.pi` on pi), then the other host. **No providers
register without it.**

Only `package` is required:

```json
{ "providers": [{ "package": "cursor-opencode-provider" }] }
```

`package` may be an npm specifier, a path, or a `file://` URL. Optional fields
include `providerName`, `api`, `apiKey`, `createOptions`, `models`,
`disableOAuth`, `preferAuthMethod`, `factoryExport` / `pluginExport`, and
`splitDimensions` — see the
[pi-bridge README](../../packages/pi-bridge/README.md) config reference for
their exact meanings.

### Model variants

OpenCode model entries may declare `variants` (display label → options object;
Cursor's `grok-4.6` enumerates six — the cross product of `effort` and `fast`).
Neither host has a "variant" concept, so variants are split along two axes:
effort-like dimensions map onto the host's own thinking-level picker, a
splitting dimension (by default only `fast`) becomes a separate model entry,
and everything else collapses to one preferred value. Set `splitDimensions` on
a provider entry to change which dimensions split. Details in the
[pi-bridge README](../../packages/pi-bridge/README.md).

### Subagents

Pi-family subagents use host-native wire contracts, not OpenCode's `task`
schema. `pi-bridge` translates the live catalog, calls, named tool choice, and
history so an unmodified OpenCode provider sees
`task({description, prompt, subagent_type})` while the host executes its own
`{agent, task}` shape.

- omp has a built-in `task` executor; `general` follows its live default spawn
  policy and `explore` maps to `scout`. Its `hub` coordination surface is a
  built-in host tool, not an MCP server: each `task` call starts a new agent,
  while `hub jobs` / `hub wait` / `hub send` handle status and follow-up.
  The bridge also accepts `{action: "jobs"}` from an OpenCode-oriented provider
  and rewrites the strict OMP discriminator to `{op: "jobs"}`.
  Because OMP subagents require a terminal `yield` call but OpenCode providers
  normally return final assistant text, the bridge supplies that terminal call
  when the live `yield` tool is present. It also overrides specialist output
  schemas so canonical `task` results retain OpenCode's unstructured text
  semantics. Auto-delivered results resume the parent as new provider-facing
  turns; otherwise a provider can mistake the original request for the live
  request and launch the same work again. The bridge also forwards the host's
  provider-session identity so stateful plugins retain their checkpoint across
  the asynchronous wake-up.
- pi's subagent support is the host's optional
  `packages/coding-agent/examples/extensions/subagent` extension. Install that
  extension and its agent definitions separately; the bridge activates the
  mapping only when the live `subagent` tool is advertised. Its reference
  aliases are `general` → `worker` and `explore` → `scout`.

Custom agent names pass through unchanged. If the subagent tool is absent or
disabled, all tools remain untouched. If pi advertises both `subagent` and an
independent tool named `task`, the latter remains available to the provider as
`pi_host_task`; canonical `task` still launches the subagent executor.

### Interactive prompts (`ask` ↔ `question`)

omp advertises interactive multi-choice prompts as `ask` with
`{questions:[{id, question, options, multi?}]}`. OpenCode plugins expect
`question` with `{questions:[{question, header, options[{label,description}],
multiple?}]}`. When the omp profile's `tools.question` role is live (`ask` in
the catalog), pi-bridge remaps the catalog, calls, tool choice, and history the
same way it remaps subagents — including synthesizing missing `id` values and
mapping `multiple` ↔ `multi`. Plain pi has no question role by default.

### Path bridge

On load, pi-bridge installs `Symbol.for("opencode.host.path-bridge")` so an
unmodified provider resolves project/global config, durable **data**, and
**cache** under `.omp` / `.pi` (and agent roots via `PI_CODING_AGENT_DIR` /
`PI_CONFIG_DIR`) instead of inventing `.opencode`. The bridge exposes
`globalConfigDirs`, `globalDataDir`, `globalCacheDir`, `projectConfigDirs`, and
`configFileNames`; provider auth, plan files, conversation snapshots, and model
caches follow those roots. A legacy `opencode.compat.path-bridge` key is set to
the same object for older provider releases.

### Cursor SwitchMode / GenerateImage tools

When `pi-bridge.json` includes `cursor-opencode-provider`, pi-bridge registers
the tools that provider already bridges on:

| Tool | Host | Behavior |
|---|---|---|
| `plan_enter` / `plan_exit` | **omp only** | Drive native omp plan mode (ACP-shaped `setPlanModeState` + proposal handler via `AgentRegistry`) |
| `cursor_plan_stage` | **omp only** | Stage the Cursor plan into omp's session-local artifact, then run omp's own review UI |
| `cursor_image_save` | **omp and pi** | Commit staged Cursor image bytes (`image_id` only) |

`cursor_plan_stage` follows the provider's plan-approval contract: the tool
**succeeds only when the user approved execution**. Choosing *Refine plan* (or
dismissing the prompt) reports the plan as written but not accepted, so the
provider keeps the model planning. Only returning real success there would make
Cursor start implementing a plan the user had just declined.

Plain **pi** has no plan mode, so SwitchMode stays refused there. Image save
works on both hosts when the Cursor provider is loaded in-process.

---

## Verify

1. Confirm the config file is found — `$PI_BRIDGE_CONFIG` set, or a
   `pi-bridge.json` present in one of the searched agent dirs.
2. Launch the host (`omp` / `pi`), open the model picker, and confirm the
   bridged provider appears with its models. The derived provider id may be
   de-collided (e.g. `cursor` → `cursor-opencode`) — check the host log for the
   "registering as" explanation.
3. Watch for `pi-bridge: failed to register provider …` errors — one bad
   config entry is isolated and logged rather than failing the whole extension.
4. When subagents are enabled, launch one short task and confirm it settles once.
   On OMP, both `{action: "jobs"}` and `{op: "jobs"}` should reach `hub`, and an
   auto-delivered result should resume the parent without spawning the task a
   second time.

Programmatic smoke test (instead of a config file):

```ts
import { registerOpenCodePlugin } from "@opencode-compat/pi-bridge"

export default async function (pi) {
  await registerOpenCodePlugin(pi, { package: "cursor-opencode-provider" })
}
```

`registerOpenCodePlugin` returns `{ profile, providerName, api, modelCount,
hasOAuth }` — a quick way to confirm what was discovered.
