# @opencode-compat/pi-bridge

Runs **unmodified** OpenCode `aisdk`-type plugins as providers on either
Pi-family host — [pi](https://github.com/earendil-works/pi) and
[oh-my-pi](https://github.com/can1357/oh-my-pi) (omp), which is a fork of it.

Neither host is OpenCode, and neither has an `@opencode-ai/plugin`-shaped native
package, so the facade→native-plugin delegation OCP uses for OpenCode forks
(MiMo, Kilo) doesn't apply. Instead this package drives each host's own
extension seam, `pi.registerProvider(...)`, and translates between AI-SDK's
`doStream` protocol and the host's `Context` / `AssistantMessageEvent` stream.

## Adding a provider

```json
{ "providers": [{ "package": "cursor-opencode-provider" }] }
```

That's the whole configuration. Nothing else is required, and the provider
package needs no changes, because every remaining detail is discovered from
conventions OpenCode plugins **already** implement:

| Discovered | From the plugin's own… |
|---|---|
| provider id | `auth.provider` (else the package name) |
| model catalog | `config` hook — `config.provider[id].models`, models.dev entry shape |
| OAuth login | `auth.methods[]` where `type: "oauth"` — `authorize() → {url, callback()}` |
| API-key login | `auth.methods[]` where `type: "api"` — its `prompts[]` are driven through the host's own `onPrompt` |
| token refresh | `auth.loader` — plugins renew in-place and persist via `client.auth.set`, which this bridge captures |
| streaming | its `createXxx()` AI-SDK factory |
| model variants | its `variants` map + entry `options` — see below |

Because these are conventions rather than anything provider-specific, adding a
different OpenCode provider plugin is the same one-line entry.

A provider whose model catalog requires authentication may show no models
before login. After a successful host login, Pi/OMP automatically refreshes
that provider's catalog; the bridge supplies the newly resolved credential to
the plugin's `auth.loader` before re-running its `config` hook. The same path
reconstructs the loader credential from the host's stored key after restart.
Pi performs a cache-only catalog refresh while restoring a session; the bridge
returns Pi's stored catalog during that phase instead of replacing it with an
empty list. Successful network refreshes are persisted through Pi's model
store, so a provider model selected in the previous session can be restored
before the background refresh completes.

At session start, the bridge also activates Pi's optional built-in `find`,
`grep`, and `ls` tools when the host has them in its allowed tool registry. The
provider sees Pi's `find` as OpenCode's canonical `glob`; calls are translated
back to the host executor. An explicit Pi/OMP tool allowlist remains
authoritative. Arbitrary extension and MCP tools are not enabled implicitly.

## Model variants (effort / fast / …)

An OpenCode model entry may declare `variants`: display label → options object.
Cursor's `grok-4.6`, for instance, enumerates six — the cross product of
`effort` (low/medium/high) and `fast` (true/false). Neither host has a "variant"
concept, but both have a native **thinking-level picker**, so variants are split
along two axes:

- an **effort-like** dimension (`effort`, `reasoning`, …) maps onto the host's
  own level picker (`thinking.efforts` on omp, `thinkingLevelMap` on pi),
  delivered back at call time as `options.reasoning`. Provider values are
  aliased to host levels (`extra-high` → `xhigh`); values that name no intensity
  (`none`) are simply not offered;
- a **splitting** dimension — by default only `fast` — becomes a separate model
  entry;
- **every other** varying dimension collapses to one preferred value (`true` for
  boolean-ish ones, so Claude keeps its `thinking` variant);
- a **constant** dimension never reaches the model id: context tiers already
  arrive as separate OpenCode entries, so `context` adds nothing.

Between the split dimension and OpenCode's own context-tier entries, a family
reaches at most four entries — {fast, non-fast} × {1M, non-1M} — each with its
own effort picker:

```
gpt-5.6-sol            low | medium | high | xhigh | max
gpt-5.6-sol-fast       low | medium | high | xhigh | max
gpt-5.6-sol-1m         low | medium | high | xhigh | max
gpt-5.6-sol-1m-fast    (only when Cursor lists fast variants for that tier)
```

Picking `xhigh` on `gpt-5.6-sol-fast` sends `reasoning=xhigh, fast=true`, while
`languageModel()` receives the base id the plugin knows (`gpt-5.6-sol`) — the
provider resolves the rest from those parameters. Set `splitDimensions` on a
provider entry to change which dimensions split (`[]` collapses everything).

This stays generic: the parameter list is located structurally (not by key
name), the selected variant's options object is forwarded verbatim, and the
entry's own `options` — e.g. the wire model id on Cursor's 1M-context entries —
are merged in on every call under the provider id the **plugin** declares.
`effort` is the single convention-sensitive name, and it degrades safely: an
unrecognized dimension simply becomes separate entries instead.

## Subagents

The bridge also normalizes the Pi family's subagent tools to the OpenCode
`task` contract seen by an unmodified provider:

| Host | Live host tool | Host input | Plugin-facing input |
|---|---|---|---|
| oh-my-pi | built-in `task` | `{agent, task}` | `task({description, prompt, subagent_type})` |
| pi | optional `subagent` extension | `{agent, task}` | `task({description, prompt, subagent_type})` |

Translation covers the live tool catalog, emitted calls, named tool choice,
and prior call/result history. Call ids and unknown custom agent names remain
unchanged. omp's `general` uses its live default spawn policy and `explore`
maps to `scout`; pi's reference extension maps them to `worker` and `scout`.
No mapping activates when the tool is disabled or absent. If pi also advertises
an unrelated tool named `task`, the bridge exposes that host tool under the
collision-safe name `pi_host_task` while reserving canonical `task` for the
subagent executor.

OMP's `hub` is a built-in host tool, not an MCP server. Every `task` call
starts a new agent; results auto-deliver, while status and follow-up use
`hub jobs`, `hub wait`, or `hub send`. OMP also requires subagents to finish by
calling its hidden `yield` tool. OpenCode-style providers normally finish with
assistant text instead, so the bridge converts a terminal text response to the
live `yield` contract. It also disables OMP specialists' structured-output
schemas for canonical OpenCode `task` calls, preserving OpenCode's unstructured
result contract. Both behaviors are gated by the live host tools/profile and do
not affect pi or ordinary main-agent responses.

OMP's hub schema is strict and names its operation discriminator `op`. The
bridge accepts the common provider spelling `action` and translates it before
host validation, so `{action: "jobs"}` executes as `{op: "jobs"}`. If both are
present, the explicit host-native `op` value wins.

## Interactive prompts (`ask` ↔ `question`)

omp advertises interactive multi-choice prompts as `ask` with
`{questions:[{id, question, options, multi?}]}`. OpenCode plugins expect
`question` with `{questions:[{question, header, options[{label,description}],
multiple?}]}`. When the omp profile's `tools.question` role is live (`ask` in
the catalog), the bridge remaps the catalog, calls, named tool choice, and
history — synthesizing missing `id` values and mapping `multiple` ↔ `multi`.
Plain pi has no question role by default.

## Cursor SwitchMode / CreatePlan / GenerateImage tools

When `pi-bridge.json` includes `cursor-opencode-provider`, the extension
registers the tools that provider already bridges on:

| Tool | Host | Behavior |
|---|---|---|
| `plan_enter` / `plan_exit` | **omp only** | Drive native omp plan mode (ACP-shaped session APIs via `AgentRegistry`) |
| `cursor_plan_stage` | **omp only** | Stage Cursor CreatePlan markdown under omp's session-local `local://` root immediately before the provider calls native `write xd://propose` |
| `cursor_image_save` | **omp and pi** | Commit staged Cursor image bytes (`image_id` only) |

The CreatePlan bridge keeps Cursor's interaction open while
`cursor_plan_stage` writes the native plan artifact and opens an interactive
approval/refinement selector through omp's extension UI. Approval restores the
pre-plan tools and queues an implementation turn; refinement keeps plan mode
active. The bridge owns this UI directly because npm omp runs its bundled
`InteractiveMode` — source changes in a separate checkout cannot affect it.
This avoids both a tool-less detached plan and a repeated CreatePlan retry loop.
Plain **pi** has no plan mode, so SwitchMode stays refused there. Image save
works on both hosts when the Cursor provider is loaded in-process. Force
registration in tests with `PI_BRIDGE_CURSOR_HOST_TOOLS=1`.

## Path bridge

On extension load, the bridge installs `Symbol.for("opencode.host.path-bridge")`
for the detected host so unmodified providers resolve project/global config,
durable **data**, and **cache** under `.omp` / `.pi` (agent roots via
`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`) instead of inventing `.opencode`. The
bridge exposes `globalConfigDirs`, `globalDataDir`, `globalCacheDir`,
`projectConfigDirs`, and `configFileNames`; provider auth, plan files,
conversation snapshots, and model caches follow those roots. A legacy
`opencode.compat.path-bridge` key is set to the same object for older provider
releases.

OpenCode plugins also emit camelCase essential-tool args (`filePath`,
`oldString`, `workdir`). Pi-family hosts validate against `path` / `cwd` /
snake_case schemas and drop unrecognized keys when more than one string field
is required — so a write of `{filePath, content}` arrives as `{content}` and
fails. The bridge remaps those aliases for live `read` / `write` / `edit` /
`bash` tools (including `write` to `xd://…` MCP devices) before host
validation. Pi's `edit` additionally requires `edits: [{ oldText, newText }]`,
so a flat `{ oldString, newString }` call is converted at that same boundary.
Pi rejects an `oldText` that matches more than once and has no replace-all
mode, so the provider-facing `edit` contract omits `replaceAll` rather than
advertising an option the host cannot execute. Because that contract differs
from Pi's own schema, stored `edit` calls are translated back to the flat shape
when replayed as history, so the model never sees a prior call in a shape its
catalog does not declare; a stored multi-edit call keeps Pi's shape, since the
flat contract cannot express more than one replacement.
OMP's `read` has a different pagination contract: it accepts only `path` and
embeds ranges as `path:150-229`. The bridge advertises OpenCode's
`{filePath, offset, limit}` shape and folds explicit ranges into that selector;
plain Pi keeps its native separate `offset` / `limit` arguments unchanged.
Pi calls OpenCode's `glob` operation `find`; when `find` is active, the bridge
advertises it to the provider as `glob` and translates calls/results back to
`find`. Host-native keys already present win.

OMP's `todo` is ops-based (`op: init|start|done|…`). The bridge advertises it as
OpenCode `todowrite` / `todoread` and folds Cursor-style
`{todos:[{content,status}]}` snapshots into a single host op (`init` for open
work, `rm` when nothing remains active, `view` for reads). Native `{op:…}` calls
still pass through.

OMP's `edit` is different again: it advertises a different schema per resolved
edit mode (model override, then `PI_EDIT_VARIANT`, then the `edit.mode` setting,
then the default `hashline`). The provider always sees OpenCode
`{filePath, oldString, newString}`. When the live host tool is hashline, the
bridge remaps those calls onto omp's replace-mode editor (the same
`old_string`/`new_string` contract Cursor's `pi_edit` frame uses) and keeps
hashline patches on the separate `hashline` tool. Parallel `hashline` calls that
share the same `[path#tag]` are coalesced into one multi-section host apply
(anchors still refer to the original snapshot) so the host's short per-path
snapshot history is not burned by one turn of disjoint hunks. Mode-independent
rules still apply in every mode.

When a result auto-delivers, OMP represents the custom completion notice as a
`developer` message with `attribution: "agent"`. The bridge promotes only the
matching background-job completion envelope to a provider-facing user turn;
other agent-attributed developer messages remain system context. This makes the
completion—not the original request—the live request on the resumed parent turn, so providers that
split conversation history from the latest user message do not restart the
original workflow or spawn duplicate agents. Ordinary developer messages remain
system context.

The host's stable provider `sessionId` is also forwarded as the namespaced
`x-opencode-session` (unless the caller already supplied an OpenCode
session-affinity header). This
lets stateful OpenCode providers retain their conversation/checkpoint across
ordinary Pi tool turns and asynchronous parent resumptions.

omp needs no extra installation. In pi, subagents are an optional host example,
not a core tool; install its `packages/coding-agent/examples/extensions/subagent`
extension and agent definitions first if you want the canonical `task` surface.
The provider bridge continues to work normally without it.

## Development helper scripts

From the OCP repository root, use the same `local|npm` workflow as the
MiMo/Kilo development helpers while retaining the Pi family's separate runtime
mechanism:

```bash
./scripts/ocp-dev.sh run pi
./scripts/ocp-dev.sh run pi --mode npm
./scripts/ocp-dev.sh run omp
./scripts/ocp-dev.sh run omp --mode npm
```

`local` installs locked dependencies, builds this checkout plus the local
provider checkout, registers the bridge using the selected host's native
installer, links that host's own `pi-ai` runtime into the real bridge checkout,
and writes the provider's absolute `dist/index.js` to `pi-bridge.json`. `npm`
installs both published packages and switches the same config entry back to the
provider's bare package name. Other provider entries and optional fields on the
selected entry are preserved.

The local provider defaults to a sibling `cursor-opencode-provider` checkout or
`~/Projects/cursor-opencode-provider`. Set `OCP_DEV_PROVIDER_PATH` and
`OCP_DEV_PLUGIN` for another provider. npm versions default to `latest`; pin
them with `OCP_DEV_BRIDGE_VERSION` and `OCP_DEV_PLUGIN_VERSION`. Set
`PI_BRIDGE_CONFIG` for a non-default config file, or `PI_CODING_AGENT_DIR` for
a non-default host agent directory.

These scripts never call `ocp setup`: Pi-family hosts use their native
extension loaders, and the package manifest selects an explicit Pi or OMP
entrypoint so a checkout containing both development dependencies cannot be
misdetected.

## Manual local install

Two separate concerns — don't conflate them:

**1. Make the host discover this extension.**

```bash
omp plugin install <path-to>/opencode-plugin-compat/packages/pi-bridge   # oh-my-pi
pi install <path-to>/opencode-plugin-compat/packages/pi-bridge           # pi
```

**2. Point config directly at the built provider entry.** This avoids relying
on a sibling package being resolvable from the real bridge checkout:

```bash
# pi-bridge.json
{
  "providers": [
    { "package": "/absolute/path/to/cursor-opencode-provider/dist/index.js" }
  ]
}
```

**3. Make the host's `pi-ai` resolvable from the real checkout.** The helper
scripts do this portably for either host. For manual setup, link the matching
package from the installed host CLI's dependency tree into
`packages/pi-bridge/node_modules`.

For repeatable switching and portable host-runtime discovery, prefer
`./scripts/ocp-dev.sh run pi` / `run omp` over performing these steps by hand.

## Config reference

Config lives at `$PI_BRIDGE_CONFIG`, else `pi-bridge.json` in the host's agent
dir (`~/.omp/agent/`, `~/.pi/agent/`, `~/.pi/`). Both hosts' locations are
searched, so one file works on either. No providers register without it.

Only `package` is required:

| Field | Purpose |
|---|---|
| `package` | npm specifier, path, or `file://` URL of the plugin |
| `providerName` | Override the discovered provider id |
| `api` | Override the custom wire-api id (default `<providerName>-bridge`) |
| `apiKey` | Env-var name (or literal) for key auth; rendered into each host's own syntax |
| `createOptions` | Options for the AI-SDK factory; `"$apiKey"` anywhere is replaced with the resolved key |
| `models` | Static model list, bypassing the plugin's `config` hook |
| `disableOAuth` | Ignore the plugin's auth hook (e.g. env-var key only) |
| `preferAuthMethod` | `"oauth"` or `"api"` when a plugin offers both |
| `factoryExport` / `pluginExport` | Disambiguate exports when auto-detection can't |
| `splitDimensions` | Variant dimensions that become separate host model ids (default `["fast"]`) |

**Provider-id collisions.** A plugin declares its own id, which may match one
the host ships natively — `cursor-opencode-provider` declares `"cursor"`, and
omp has a built-in `cursor` provider. Since `registerProvider` has no collision
guard, a *derived* id that would shadow a host built-in is suffixed
(`cursor` → `cursor-opencode`) with a logged explanation. An explicit
`providerName` is always used as-is.

## Host differences handled for you

Both hosts share an ancestor, so their surfaces are alike but not identical.
Each delta below was read from host source and lives as data in
`host/profile.ts`:

| | oh-my-pi | pi |
|---|---|---|
| pi-ai package | `@oh-my-pi/pi-ai` | `@earendil-works/pi-ai` |
| dynamic models | `fetchDynamicModels(apiKey)` | `refreshModels(ctx)` (transactional) |
| `oauth.refreshToken` / `getApiKey` | optional | **required** |
| `apiKey` syntax | bare env-var name | `$VAR` / `!cmd` template |
| `Context.systemPrompt` | `string[]` | `string` |
| extra stream event | `image_end` | `deferred` done-reason |
| subagent executor | built-in `task` | optional `subagent` extension |

Normal host installation selects an explicit Pi or OMP manifest entrypoint.
Generic/programmatic loading falls back to probing which `pi-ai` package
resolves, and `PI_BRIDGE_HOST=omp|pi` remains an explicit override. Only the
event variants **both** hosts share are emitted, so the translation layer is
identical on each.

### Provider-native MCP resource operations

The bridge can translate only AI-SDK tool calls emitted by `doStream`; it never
parses a consumer provider's private wire protocol. Providers that speak their
own native MCP resource protocol must decode and reply to it themselves, before
the AI-SDK stream boundary. Errors naming `list_mcp_resources_exec_args` or
`read_mcp_resource_exec_args` mean the provider's build does not settle those
native requests: upgrade to a provider version that handles its own MCP
resource operations internally (current `cursor-opencode-provider` releases do;
older ones must be upgraded). No resource URI or correlated result channel
reaches `pi-bridge`, so the bridge cannot safely reconstruct that call — it
must not vendor provider-specific wire parsing. Ordinary advertised host tools,
including an explicit `read_mcp_resource` tool, continue to pass through and
are translated like any other tool.

## Programmatic use

```ts
import { registerOpenCodePlugin } from "@opencode-compat/pi-bridge"

export default async function (pi) {
  await registerOpenCodePlugin(pi, { package: "cursor-opencode-provider" })
}
```

`registerAiSdkProvider` (`bridge.ts`) remains available for registering an
AI-SDK provider that isn't an OpenCode plugin at all.

**License:** MPL-2.0 — see the monorepo [README](../../README.md).
