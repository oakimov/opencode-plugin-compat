# MiMo — OCP enablement notes

**Host (reference only):** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)
**User-facing package:** [`@opencode-compat/ocp`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/ocp) (umbrella + `ocp setup`)
**Bridge packages (internal):** [`facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)
**HostProfile id:** `mimo`

OCP attaches as an **external compatibility layer**. MiMo is a read-only host reference.

---

## 1. Install-tree facade overrides (Layer A)

Where the host installs npm plugins into its cache (typically under the MiMo XDG/cache `packages/` tree — see [packages/opencode/src/npm/index.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/npm/index.ts) and [packages/opencode/src/plugin/shared.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/shared.ts)), OpenCode plugins that import `@opencode-ai/plugin` / `@opencode-ai/sdk` should resolve OCP facades via install overrides:

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

Then add **consumer** plugins via MiMo config as usual. Listing OCP itself in `plugin` is optional bootstrap only — it does **not** intercept other plugins’ `@opencode-ai/plugin` imports.

**npm publish of `@opencode-compat/*` is held until necessary.** Until then, pin via whatever install channel this monorepo supports without modifying MiMo source (git checkout + local override tooling, packed tarballs, etc.).

Do **not** override `@opencode-ai/plugin` straight to `@mimo-ai/plugin` — that skips OCP (v2 surface, doctor, shared host kit).

---

## 2. Project dirs / `.opencode` (Layer B / T2)

MiMo today walks **`.mimocode`** in [ConfigPaths.directories](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/config/paths.ts). OCP’s `HostProfile` for `mimo` records `compatProjectDirs: [".opencode"]` for matrix / doctor honesty.

Closing path gaps is the **bridge’s** job (docs, doctor, optional operator copy/symlink into `.mimocode`).

---

## 3. Promise v2 / `host-promise-v2` (Layer E / T3)

MiMo does **not** publish `@mimo-ai/plugin/v2/promise`. OCP supplies Promise v2 via `@opencode-compat/host-promise-v2`, exposed through the facade override for `@opencode-ai/plugin/v2/promise`.

```ts
import { wirePromiseV2 } from "@opencode-compat/ocp"
// or: createPromiseV2Host / runPromisePlugin from @opencode-compat/host-promise-v2

const host = wirePromiseV2({ env: { OPENCODE_COMPAT_HOST: "mimo" } })
await host.register(plugin) // plugin from define({ id, setup })
const { language, sdk } = await host.resolveProvider({
  providerID: "…",
  modelID: "…",
  package: "…",
})
```

`HostProfile` for `mimo` sets `capabilities.promiseV2` / `aisdkProviderHooks` to **true** because the OCP layer provides the kit. Live MiMo provider-resolve still needs an operator/sidecar call into `resolveProvider` (no host source edits). Until that seam is reached in-process, plugins that only `define()` without a host calling `resolveProvider` will not inject models into MiMo’s native path.

---

## 4. Classic hook gaps (facade policy)

MiMo’s published classic surface lacks `dispose` and `experimental.provider.small_model` vs OCP core. Facade / doctor: accept + no-op + warn. Do **not** surface MiMo `actor.*` / `session.*` on the portable `@opencode-ai/plugin` path (ADR-7).

---

## 5. Telemetry (non-runtime)

OCP does **not** kill MiMo analytics. See [`docs/guides/mimocode-telemetry-disable.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/guides/mimocode-telemetry-disable.md) (`MIMOCODE_ENABLE_ANALYSIS=false`).

---

## 6. Verification

```bash
OPENCODE_COMPAT_HOST=mimo opencode-compat doctor
opencode-compat matrix --host mimo
opencode-compat matrix --host mimo --compat-scan
```
