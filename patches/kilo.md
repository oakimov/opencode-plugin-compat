# Kilo — OCP enablement notes

**Host (reference only):** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)
**User-facing package:** [`@opencode-compat/ocp`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/ocp) (umbrella + `ocp setup`)
**Bridge packages (internal):** [`facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)
**HostProfile id:** `kilo`
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

OCP attaches as an **external compatibility layer**. Kilo is a read-only host reference.

---

## 1. Install-tree facade overrides (Layer A)

Where the host installs npm plugins ([packages/core/src/npm.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/npm.ts), [packages/opencode/src/plugin/shared.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/shared.ts)), OpenCode plugins should resolve OCP facades via install overrides:

```json
{
  "@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@0.1.0",
  "@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@0.1.0"
}
```

**Preferred UX:** install `@opencode-compat/ocp`, then run **`ocp setup`** (writes the overrides into the host plugin install tree). Equivalent: `compat setup` / print-only `compat overrides` / `opencode-compat overrides`.

```bash
ocp setup
# or (bridge CLI):
opencode-compat overrides
```

Then add **consumer** plugins via Kilo config as usual. Listing OCP itself in `plugin` is optional bootstrap only — it does **not** intercept other plugins’ `@opencode-ai/plugin` imports.

**npm publish of `@opencode-compat/*` is held until necessary.**

Classic Hooks keys already match OpenCode 1.18.3 core — T1 is primarily override + adapter dispatch to `@kilocode/plugin`.

---

## 2. Project dirs / `.opencode` (Layer B / T2)

Kilo scans **`.kilo` / `.kilocode`** in [ConfigPaths.directories](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/paths.ts). It may warn about leftover `.opencode` dirs for migration; default is native-only.

OCP’s `kilo` profile keeps `compatProjectDirs: [".opencode"]` for matrix `--compat-scan`. Operators who need OpenCode project plugins can copy/symlink into `.kilo`.

---

## 3. Promise v2 / `host-promise-v2` (Layer E / T3)

Kilo does **not** publish a portable `@opencode-ai/plugin/v2/promise` path for arbitrary OpenCode plugins. OCP supplies Promise v2 via `@opencode-compat/host-promise-v2` + facade overrides.

```ts
import { wirePromiseV2 } from "@opencode-compat/ocp"

const host = wirePromiseV2({ env: { OPENCODE_COMPAT_HOST: "kilo" } })
await host.register(plugin)
await host.resolveProvider({ providerID, modelID, package: pkg })
```

`HostProfile` for `kilo` sets `capabilities.promiseV2` / `aisdkProviderHooks` to **true** (OCP-layer kit). Live Kilo provider-resolve must call into `resolveProvider` from a sidecar/operator helper — host source stays read-only.

Reference host files (read-only): [packages/opencode/src/provider/provider.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/provider/provider.ts), [packages/opencode/src/plugin/loader.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/loader.ts).

---

## 4. Telemetry (non-runtime)

OCP does **not** kill Kilo PostHog. See [`docs/guides/kilocode-telemetry-disable.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/kilocode-telemetry-disable.md).

---

## 5. Verification

```bash
OPENCODE_COMPAT_HOST=kilo opencode-compat doctor
opencode-compat matrix --host kilo
opencode-compat matrix --host kilo --compat-scan
```
