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

## Install

Two separate concerns — don't conflate them:

**1. Make the host discover this extension.**

```bash
omp plugin install <path-to>/opencode-plugin-compat/packages/pi-bridge   # oh-my-pi
pi install <path-to>/opencode-plugin-compat/packages/pi-bridge           # pi
```

**2. Make everything this bridge imports resolvable from *its own* location.**
Node/Bun resolve a bare specifier relative to the **real** path of the importing
file, not any symlink it was reached through — so installing packages as
*siblings* under the host's plugin dir does **not** make them importable here.
Once these are published to npm and installed as real dependencies it's
automatic; for local checkouts, link them into `packages/pi-bridge/node_modules`:

```bash
# the provider package named in your config
cd <path-to>/cursor-opencode-provider && bun link
cd <path-to>/opencode-plugin-compat/packages/pi-bridge && bun link cursor-opencode-provider
```

**On pi additionally**, the host's `pi-ai` is not a sibling of this package the
way omp's is, so link it too (it ships inside the installed CLI):

```bash
cd <path-to>/opencode-plugin-compat/packages/pi-bridge
mkdir -p node_modules/@earendil-works
ln -sfn "$(dirname "$(readlink -f "$(which pi)")")/../node_modules/@earendil-works/pi-ai" \
        node_modules/@earendil-works/pi-ai
```

Nothing requires a machine-specific path inside any file — only these commands
vary per developer, the same as any `npm link`-style local workflow.

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

The host is detected by probing which `pi-ai` package resolves; `PI_BRIDGE_HOST=omp|pi`
forces it. Only the event variants **both** hosts share are emitted, so the
translation layer is identical on each.

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
