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

The host is detected by probing which `pi-ai` package resolves
(`@oh-my-pi/pi-ai` vs `@earendil-works/pi-ai`); `PI_BRIDGE_HOST=omp|pi` forces
it. Provider-id collisions are handled: a *derived* id that would shadow a host
built-in is suffixed (`cursor` → `cursor-opencode`) with a logged explanation.

---

## Install via npm

Install the published `@opencode-compat/pi-bridge` through the host's own
extension installer, then register providers by config:

```bash
omp plugin install @opencode-compat/pi-bridge   # oh-my-pi
pi install @opencode-compat/pi-bridge           # pi
```

`pi-bridge` ships in the same `0.1.x` train as the rest of `@opencode-compat/*`.
Installed this way its dependencies resolve normally — no linking needed.

The provider package you name in the config is a separate install. Add it the
same way, so it resolves from the bridge's own tree:

```bash
omp plugin install cursor-opencode-provider     # oh-my-pi
pi install cursor-opencode-provider             # pi
```

---

## Install for local development

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

**2. Make everything this bridge imports resolvable from *its own* location.**
Node/Bun resolve a bare specifier relative to the **real** path of the importing
file, not any symlink it was reached through. `omp plugin install` / `pi install`
of a *checkout* only symlinks it, so resolution walks up the **OCP monorepo**,
never the host's plugin dir — installing the provider as a sibling there has no
effect on a checkout. Link it into `packages/pi-bridge`'s own `node_modules`
instead:

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

Once `@opencode-compat/pi-bridge` and the provider are installed as real
dependencies this becomes automatic. Nothing requires a machine-specific path
inside any file — only these commands vary per developer, the same as any
`npm link`-style local workflow.

---

## Configuration

Config lives at `$PI_BRIDGE_CONFIG`, else `pi-bridge.json` in the host's agent
dir (`~/.omp/agent/`, `~/.pi/agent/`, `~/.pi/`). Both hosts' locations are
searched, so one file works on either. **No providers register without it.**

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

Programmatic smoke test (instead of a config file):

```ts
import { registerOpenCodePlugin } from "@opencode-compat/pi-bridge"

export default async function (pi) {
  await registerOpenCodePlugin(pi, { package: "cursor-opencode-provider" })
}
```

`registerOpenCodePlugin` returns `{ profile, providerName, api, modelCount,
hasOAuth }` — a quick way to confirm what was discovered.
