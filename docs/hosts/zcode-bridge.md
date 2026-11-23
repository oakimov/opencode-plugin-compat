# ZCode — external OpenCode-plugin bridge (experimental)

`ocp zcode` runs an **unchanged** OpenCode provider plugin in an OCP process and serves it to stock ZCode as a loopback **Anthropic Messages** endpoint. ZCode keeps its own agent, transcript, native tools, permission prompts and model picker. The only change on the ZCode side is an ordinary Personal provider/model entry in its settings.

This is separate from the clone ABI: ZCode stays **T0** for `@opencode-ai/plugin` loading ([opencode-clones.md §5](opencode-clones.md#5-zcode--not-a-load-target)), and `ocp migrate-zcode` is unchanged.

## Status

| Area | State |
|---|---|
| Wire contract | Built against the ZCode 3.18.2 source (`fec97590`): `@ai-sdk/anthropic@3.0.81` posting to `{baseURL}/messages` with `x-api-key` and `Authorization: Bearer` (`apps/zcode-cli/packages/adapters/src/model/model-execution.ts:341-349`, `:466-489`). Exercised in tests with that same client version. |
| Stock ZCode acceptance | The embedded CLI from the [ZCode 3.18.2 macOS arm64 release](https://github.com/zai-org/ZCode/releases/tag/v3.18.2) completed the probe with one native `Read`, one replayed tool result, and the final marker. The desktop UI, interactive approvals, and live upstream providers still require acceptance testing. |
| Classic provider plugins | Load, `auth` hook login, durable refresh via `auth.loader`, `config` catalog, `doStream` and `doGenerate` (falls back to aggregating `doStream`). |
| Promise v2 (1.18) / OpenCode 2.x server plugins | Rejected at startup (`contract-unsupported`). |
| Native tools | `Read` ↔ canonical `read` ([tool vocabulary](../tool-vocabulary.md#files-and-commands)). Every other advertised tool, including MCP tools, passes through with its exact name and schema. |
| Plugin-owned tools over MCP, process hooks | Not implemented. |
| Session affinity | Not forwarded. ZCode's model request carries no verified workspace identity, so the bridge sends the provider no `x-opencode-session-id`. OCP freezes catalog order per routed model target, workspace, and ZCode session. Repointing an alias starts a fresh catalog. |
| Cancellation | A client disconnect or shutdown aborts the in-flight provider call. Stop while a tool or approval is pending (no open model request) is not handled. |
| Unmapped request fields | `thinking`, `metadata`, `cache_control`, `speed`, `inference_geo`, `context_management`, `output_config.effort/task_budget` and `tool_choice.disable_parallel_tool_use` are accepted, then logged by name. Any other unknown field or content block is rejected with HTTP 400. |

Two ways to run it. Both leave ZCode unmodified, and both end with the same ZCode-side Personal provider.

| | A. npm registry | B. Local checkout (`ocp-dev`) |
|---|---|---|
| Bridge | published `@opencode-compat/ocp` | this OCP checkout, built |
| Provider | published package, exact version | provider checkout (default `../cursor-opencode-provider`), built |
| OCP home | your XDG dirs | isolated, under `~/.cache/ocp-dev/zcode/home` |
| ZCode provider entry | you add it in ZCode Settings | `ocp-dev` inserts it into `provider_config.json` |

## A. From the npm registry

No published release has the `zcode` command yet (0.4.4 and earlier lack it). It ships with the first release that includes this bridge.

```bash
bun add -g @opencode-compat/ocp
ocp zcode install <provider-package>@<exact-version>
ocp zcode credential --file ~/.local/share/opencode-compat/zcode/state/model-credential
```

`install` puts the plugin in the OCP-owned install root (`$XDG_DATA_HOME/opencode-compat/zcode/plugins`) and prints the resolved entry and its sha256. `credential` writes a new 0600 bridge credential and prints it once. That credential authorizes ZCode to this bridge. It is not the plugin's upstream credential.

Write the [bridge config](#bridge-configuration), then:

```bash
ocp zcode check          # readiness: package version, entry sha256, auth, models; exit 2 = login required
ocp zcode auth --binding main --plugin provider [--method oauth|api]
ocp zcode models         # IDs, limits and modalities to enter in ZCode
ocp zcode serve          # SIGHUP reloads; a failed reload keeps the old generation serving
                         # an upgraded plugin package needs a restart, not a reload
```

In ZCode Settings:

1. Add a Personal provider: API format **Anthropic Messages**, base URL `http://127.0.0.1:18731/v1`, API key = the bridge credential.
2. Add an enabled Personal model whose ID is one from `ocp zcode models`, with the printed context/output limits and input modalities.
3. Select that model in a fresh session.

Revert: select your previous model, remove the OCP model and provider entries, then stop `ocp zcode serve`. OCP's credentials and auth state stay until you delete them.

## B. From a local checkout (`ocp-dev`)

For a downloaded ZCode release running against this OCP checkout and a local provider checkout. Quit ZCode first: it holds `provider_config.json` under its own lock. Start it at least once beforehand, because ZCode imports legacy provider settings only while that file does not exist, so `ocp-dev` never creates it.

```bash
./scripts/ocp-dev.sh run zcode                 # this checkout + ../cursor-opencode-provider
./scripts/ocp-dev.sh run zcode --mode npm      # published @opencode-compat/ocp + provider
./scripts/ocp-dev.sh unshim zcode
```

`run` does the following:

1. Installs locked dependencies and builds OCP and the provider checkout, or installs the published packages with `--mode npm`.
2. Links the checkout into an isolated OCP home under `~/.cache/ocp-dev/zcode/home`.
3. Writes `~/.cache/ocp-dev/zcode/bin/ocp-zcode`, a wrapper for `ocp zcode` with that home, and a bridge config that serves the provider's whole catalog (`"models": "catalog"`).
4. Inserts one Personal provider rule, `ocp-dev`, into ZCode's [documented](https://github.com/zai-org/ZCode/blob/fec97590/apps/zcode-cli/docs/usage/03-config.md) `~/.zcode/v2/provider_config.json`. That rule uses Anthropic Messages to the bridge, the bridge credential, and the catalog's model ids. The edit is surgical: other providers, model rules, the provider order and your default selection are kept.

Then:

```bash
~/.cache/ocp-dev/zcode/bin/ocp-zcode auth --binding ocp-dev --plugin provider   # when check says login required
./scripts/ocp-dev.sh run zcode                                                   # rerun: ZCode lists the catalog after login
~/.cache/ocp-dev/zcode/bin/ocp-zcode serve
```

Open ZCode and pick an **OCP (ocp-dev)** model in a new session. After rebuilding the provider checkout, restart `serve`.

`unshim` removes the `ocp-dev` rule, any model rules that name it, its provider-order entry (only if `run` added it) and a default selection that points at it. It also removes the wrapper, links and bridge config. Upstream login and the bridge credential stay in `~/.cache/ocp-dev/zcode/home/data/opencode-compat/zcode/state`.

Both commands refuse to change an existing `ocp-dev` rule unless it uses the shim’s retained credential. If you already removed the provider rule, `unshim` uses its manifest to clean up the remaining shim settings.

| Variable | Role |
|---|---|
| `OCP_DEV_PROVIDER_PATH` / `OCP_DEV_PLUGIN` | provider checkout / package name (default `cursor-opencode-provider`) |
| `OCP_DEV_BRIDGE_VERSION` / `OCP_DEV_PLUGIN_VERSION` | npm versions or tags (default `latest`) |
| `OCP_DEV_ZCODE_PORT` | bridge port (default 18731) |
| `OCP_DEV_ZCODE_WORKSPACE` | workspace bound to the bridge (default home) |
| `ZCODE_APP` | ZCode install (default `/Applications/ZCode.app`, `~/Applications/ZCode.app`, or `zcode` on PATH) |
| `ZCODE_DATA_BASE_DIR` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | ZCode's own path overrides for `provider_config.json` |

The app path, the running-process check and the `provider_config.json` location come from the 3.18.2 source and docs. Confirm them against the installed build before relying on them.

## Bridge configuration

`$XDG_CONFIG_HOME/opencode-compat/zcode-bridge.json` (or `--config <file>`). OCP reads this file and never rewrites it. In local mode `ocp-dev` owns its own copy inside the isolated home.

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
      "models": "catalog"
    }]
  }]
}
```

- `models` is `"catalog"` (every model the plugin's own `config` hook publishes, under its own id, re-read after login and on reload) or explicit aliases `[{ "alias": "<zcode-model-id>", "upstream": "<provider-model-id>" }]`. Catalog ids that collide across plugins of one binding are a readiness error; give one plugin explicit aliases.
- Each model entry's own `options` are sent as provider options on every call.
- `listen.host` must be loopback. Credentials are `{ "env": "NAME" }` or `{ "file": "/abs/path" }` references. Each binding needs a distinct model credential, which selects the binding.
- Optional plugin fields: `entry` (an `exports` subpath), `factoryExport`, `pluginExport`, `providerId` and `options` (AI-SDK factory options; `$apiKey` is substituted).
- Optional `limits`: `maxBodyBytes`, `maxConcurrentRequests`, `maxSessions` (retained per-session tool catalogs). A reload that changes `listen`, `maxBodyBytes` or `maxSessions` is refused until restart.
- Unknown fields, duplicate binding or plugin ids, duplicate aliases, shared credential references and version ranges are rejected with the JSON path.

Upstream auth is stored privately per binding/plugin/provider (`$XDG_DATA_HOME/opencode-compat/zcode/state/auth/`, 0600). A refresh made by an in-flight request, or by another process, never overwrites a newer login. You can log in again or run `ocp zcode auth --logout` when the old credential fails during catalog discovery.

## Probe (Step 0 evidence)

```bash
ocp zcode probe [--port 18731] [--transcript <file>]
```

This serves a deterministic built-in model (`ocp-probe`) through the same endpoint and prints a one-time credential. Configure it in ZCode as above, then:

- Send any message. Expect `OCP-PROBE-TEXT`.
- Send a message containing `ocp probe read`. Expect a native `Read` of a generated temp file, then `OCP-PROBE-OK` once the next request carries the matching result. The probe file is removed on exit and the transcript is retained.

The private transcript (0600 JSONL) records header names, protocol headers, ZCode attribution labels (`x-zcode-session-type`, `x-zcode-query-source`), block types, tool names, stop reasons and verdicts. Session, query, request and trace ids are stored only as keyed hashes. The key is per run and never written, so ids can be compared within one run but are not persisted. The transcript contains no prompt text, file contents, local paths or credentials.

## Privacy and telemetry

- ZCode attribution and trace headers are kept for OCP's correlation and logs and are never forwarded to the plugin or its upstream.
- Default logs carry route, binding, model alias, a keyed hash of the ZCode request id, status, sanitized error code and OCP version.
- Selecting the OCP model sends that model's requests to the loopback bridge instead of a Z.AI endpoint. ZCode's own product telemetry is unaffected. The ZCode 3.18.2 source compiles its telemetry endpoints into the build (`packages/shared/src/env.ts:58-64`) and exposes no user opt-out, and OCP does not change ZCode telemetry. Block it at the host level: [zcode-telemetry-block.md](../guides/zcode-telemetry-block.md).
