# ZCode — external OpenCode-plugin bridge (experimental)

`ocp zcode` runs an **unchanged** OpenCode provider plugin in an OCP process and serves it to stock ZCode as a loopback **Anthropic Messages** endpoint. ZCode keeps its own agent, transcript, native tools, permission prompts and model picker. The only change on the ZCode side is an ordinary Personal provider/model entry in its settings.

This is separate from the clone ABI: ZCode stays **T0** for `@opencode-ai/plugin` loading ([opencode-clones.md §5](opencode-clones.md#5-zcode--not-a-load-target)), and `ocp migrate-zcode` is unchanged.

## Status

| Area | State |
|---|---|
| Wire contract | Built against the ZCode 3.18.2 source (`fec97590`): `@ai-sdk/anthropic@3.0.81` posting to `{baseURL}/messages` with `x-api-key` and `Authorization: Bearer` (`apps/zcode-cli/packages/adapters/src/model/model-execution.ts:341-349`, `:466-489`). Exercised in tests with that same client version. |
| Stock ZCode acceptance | **Not done.** No shipped ZCode build was installed when this was written. Run `ocp zcode probe` (below) on the installed build before relying on any row in this table. |
| Classic provider plugins | Load, `auth` hook login, durable refresh via `auth.loader`, `config` catalog, `doStream` and `doGenerate` (falls back to aggregating `doStream`). |
| Promise v2 (1.18) / OpenCode 2.x server plugins | Rejected at startup (`contract-unsupported`). |
| Native tools | `Read` ↔ canonical `read` ([tool vocabulary](../tool-vocabulary.md#files-and-commands)). Every other advertised tool, including MCP tools, passes through with its exact name and schema. |
| Plugin-owned tools over MCP, process hooks | Not implemented. |
| Session affinity | Not forwarded. ZCode's model request carries no verified workspace identity, so the bridge sends the provider no `x-opencode-session-id`. Catalog order is still frozen per ZCode session inside OCP. |
| Cancellation | A client disconnect or shutdown aborts the in-flight provider call. Stop while a tool or approval is pending (no open model request) is not handled. |
| Unmapped request fields | `thinking`, `metadata`, `cache_control`, `speed`, `inference_geo`, `context_management`, `output_config.effort/task_budget` and `tool_choice.disable_parallel_tool_use` are accepted, then logged by name. Any other unknown field or content block is rejected with HTTP 400. |

## Install

```bash
bun add -g @opencode-compat/ocp
ocp zcode install <provider-package>@<exact-version>
ocp zcode credential --file ~/.local/share/opencode-compat/zcode/state/model-credential
```

`install` puts the plugin in the OCP-owned install root (`$XDG_DATA_HOME/opencode-compat/zcode/plugins`) and prints the resolved entry and its sha256. `credential` writes a new 0600 bridge credential and prints it once. That credential authorizes ZCode to this bridge. It is not the plugin's upstream credential.

## Configure

`$XDG_CONFIG_HOME/opencode-compat/zcode-bridge.json` (or `--config <file>`). OCP reads this file and never rewrites it.

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 18731 },
  "bindings": [{
    "id": "main",
    "workspace": "/absolute/path/to/project",
    "credentials": { "model": { "file": "/absolute/path/to/model-credential" } },
    "plugins": [{
      "id": "provider",
      "package": "<provider-package>",
      "version": "<exact-version>",
      "contract": "classic",
      "models": [{ "alias": "<zcode-model-id>", "upstream": "<provider-model-id>" }]
    }]
  }]
}
```

- `listen.host` must be loopback. Credentials are `{ "env": "NAME" }` or `{ "file": "/abs/path" }` references. Each binding needs a distinct model credential, which selects the binding.
- Optional plugin fields: `entry` (an `exports` subpath), `factoryExport`, `pluginExport`, `providerId` and `options` (AI-SDK factory options; `$apiKey` is substituted).
- Optional `limits`: `maxBodyBytes`, `maxConcurrentRequests`, `maxSessions` (retained per-session tool catalogs). A reload that changes `listen`, `maxBodyBytes` or `maxSessions` is refused until restart.
- Unknown fields, duplicate binding or plugin ids, duplicate aliases, shared credential references and version ranges are rejected with the JSON path.

```bash
ocp zcode check          # readiness: package version, entry sha256, auth, models; exit 2 = login required
ocp zcode auth --binding main --plugin provider [--method oauth|api]
ocp zcode models         # IDs, limits and modalities to enter in ZCode
ocp zcode serve          # SIGHUP reloads; a failed reload keeps the old generation serving
                         # an upgraded plugin package needs a restart, not a reload
```

Upstream auth is stored privately per binding/plugin/provider (`$XDG_DATA_HOME/opencode-compat/zcode/state/auth/`, 0600). A refresh made by an in-flight request never overwrites a newer login.

## ZCode settings

1. Add a Personal provider: API format **Anthropic Messages**, base URL `http://127.0.0.1:18731/v1`, API key = the bridge credential.
2. Add an enabled Personal model whose ID is an alias from `ocp zcode models`, with the printed context/output limits and input modalities.
3. Select that model in a fresh session.

Revert: select your previous model, remove the OCP model and provider entries, then stop `ocp zcode serve`. OCP's credentials and auth state stay until you delete them.

## Probe (Step 0 evidence)

```bash
ocp zcode probe [--port 18731] [--transcript <file>]
```

This serves a deterministic built-in model (`ocp-probe`) through the same endpoint and prints a one-time credential. Configure it in ZCode as above, then:

- Send any message. Expect `OCP-PROBE-TEXT`.
- Send a message containing `ocp probe read`. Expect a native `Read` of a generated temp file, then `OCP-PROBE-OK` once the next request carries the matching result.

The private transcript (0600 JSONL) records header names, protocol headers, ZCode attribution labels (`x-zcode-session-type`, `x-zcode-query-source`), block types, tool names, stop reasons and verdicts. Session, query, request and trace ids are stored only as keyed hashes. The key is per run and never written, so ids can be compared within one run but are not persisted. The transcript contains no prompt text, file contents, local paths or credentials.

## Privacy and telemetry

- ZCode attribution and trace headers are kept for OCP's correlation and logs and are never forwarded to the plugin or its upstream.
- Default logs carry route, binding, model alias, the ZCode request id, status, sanitized error code and OCP version.
- Selecting the OCP model sends that model's requests to the loopback bridge instead of a Z.AI endpoint. ZCode's own product telemetry is unaffected. The ZCode 3.18.2 source compiles its telemetry endpoints into the build (`packages/shared/src/env.ts:58-64`) and exposes no user opt-out, and OCP does not change ZCode telemetry. Block it at the host level: [zcode-telemetry-block.md](../guides/zcode-telemetry-block.md).
