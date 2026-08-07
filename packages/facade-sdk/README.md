# @opencode-compat/facade-sdk

Install-override stand-in for `@opencode-ai/sdk`. Written into host plugin install trees by **`ocp setup`** — do not publish under `@opencode-ai/*`.

## Surface

| Export | Role |
|--------|------|
| `.` | Classic Auth/Model/Provider types + `createOpencodeClient` |
| `./v2/client` | `OpencodeClient` / `createOpencodeClient` for catalog plugins |
| `./v2/types` | `ModelV2Info` and related catalog types |
| `./v2/gen/client` | Opaque transport `Client` typing |
| `./v2` | Re-exports client + types |

On **kilo** / **mimo**, `v2.model.list` polyfills from [models.dev](https://models.dev) instead of re-entering in-process `GET /api/model` during classic `config` hooks (Plugin.state deadlock). Directory headers are taken from `HostProfile.http` (`x-kilo-*` / `x-mimocode-*` / `x-opencode-*`).

**End-user install:** [INSTALL.md](../../INSTALL.md). **License:** MPL-2.0

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md).
