# Kilo — OCP enablement notes

**Host (reference only):** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)  
**OCP packages:** [`@opencode-compat/facade-plugin`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-plugin), [`facade-sdk`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/facade-sdk), [`adapter`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/adapter), [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2)  
**HostProfile id:** `kilo`  
**Upstream pin observed:** OpenCode `v1.17.4` / `@kilocode/plugin@7.4.11`

OCP attaches as an **external compatibility layer**. Do **not** PR or fork Kilo to land OCP.

---

## 1. Install-tree facade overrides (Layer A)

Where the host installs npm plugins ([packages/core/src/npm.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/npm.ts), [packages/opencode/src/plugin/shared.ts](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/plugin/shared.ts)), OpenCode plugins should resolve OCP facades via install overrides:

```json
{
  "@opencode-ai/plugin": "npm:@opencode-compat/facade-plugin@0.1.0",
  "@opencode-ai/sdk": "npm:@opencode-compat/facade-sdk@0.1.0"
}
```

Generate with:

```bash
opencode-compat overrides
```

**npm publish of `@opencode-compat/*` is held until necessary.**

Classic Hooks keys already match OpenCode 1.18.3 core — T1 is primarily override + adapter dispatch to `@kilocode/plugin`.

---

## 2. Project dirs / `.opencode` (Layer B / T2)

Kilo scans **`.kilo` / `.kilocode`** in [ConfigPaths.directories](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/paths.ts). It may warn about leftover `.opencode` dirs for migration; default is native-only.

OCP’s `kilo` profile keeps `compatProjectDirs: [".opencode"]` for matrix `--compat-scan`. Operators who need OpenCode project plugins can copy/symlink into `.kilo` — **not** via a Kilo upstream PR from this project.

---

## 3. Promise v2 / `host-promise-v2` (Layer E / T3)

Wire `@opencode-compat/host-promise-v2` at provider-resolve time from the OCP layer / sidecar. Until that exists, `capabilities.promiseV2` stays `false` and `v2/promise` fails loud.

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
