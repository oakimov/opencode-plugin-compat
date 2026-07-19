# Disable Kilo Code product telemetry

**Status:** companion privacy guide (not an OCP runtime feature)  
**Host:** Kilo CLI / VS Code (`@kilocode/cli`, `@kilocode/kilo-telemetry`)  
**Evidence baseline:** [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) (`@kilocode/kilo-telemetry`, CLI bootstrap) + [oa-tools/kilo-review/KILO_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/kilo-review/KILO_RESEARCH.md) §7

Kilo ships **PostHog product analytics on by default**. Unlike ZCode, Kilo has **first-party opt-out** knobs. Prefer those over firewalling.

Related: [ZCode telemetry block (docs-only)](./zcode-telemetry-block.md) · MiMo: `MIMOCODE_ENABLE_ANALYSIS=false`

---

## What is sent

| | Detail |
|---|---|
| Package | `@kilocode/kilo-telemetry` (`posthog-node`) |
| Endpoint | `https://us.i.posthog.com` |
| Identity | Persistent machine id under XDG data (`…/kilo/telemetry-id`, typically `~/.local/share/kilo/telemetry-id`); on Kilo auth, identify/alias to email / org id |
| Event examples | CLI start/exit; session start/end/message; LLM **metadata** (provider, model, tokens, cost — not prompt bodies in the event enum); command/tool/agent; indexing lifecycle; share; MCP; auth; feedback; errors; `Telemetry Disabled` |

This guide covers **PostHog product telemetry**. Separate OpenTelemetry exporter env vars (`OTEL_EXPORTER_OTLP_*`) are unrelated control-plane/debug plumbing and are **not** what Kilo wires through `experimental.openTelemetry` today.

**Naming caveat:** Kilo reuses the config key `experimental.openTelemetry` as the enable flag for **PostHog** in CLI bootstrap (`enabled: cfg.experimental?.openTelemetry !== false`). Setting it `false` opts out of PostHog; it is not a general “disable all observability forever” claim.

---

## Recommended disable (CLI)

### Option A — config (persistent)

In global Kilo config (any of `~/.config/kilo/kilo.json`, `kilo.jsonc`, or `config.json` — same `experimental` object):

```json
{
  "experimental": {
    "openTelemetry": false
  }
}
```

Project configs under `.kilo/` / `.kilocode/` can carry the same key if you want a repo-local override, but global is the usual place for a machine-wide opt-out.

### Option B — environment (strongest when set)

```bash
export KILO_TELEMETRY_LEVEL=off
```

Any value **other than** `all` disables PostHog. If `KILO_TELEMETRY_LEVEL` is **unset**, Kilo falls back to the config flag above. If it **is** set, it **wins** over config:

| `KILO_TELEMETRY_LEVEL` | Result |
|---|---|
| unset | use `experimental.openTelemetry` (`true` / missing ⇒ enabled) |
| `all` | force enabled |
| anything else (`off`, `none`, `0`, …) | force disabled |

Put the export in your shell profile, IDE run config, or the environment of whatever spawns `kilo` / `kilocode`.

### Runtime API (clients of `kilo serve`)

Authenticated clients can `POST /telemetry/setEnabled` with `{ "enabled": false }` on the local server. The VS Code extension uses this so toggling VS Code telemetry consent updates an already-running CLI (which only reads `KILO_TELEMETRY_LEVEL` once at spawn).

---

## VS Code extension

1. Disable VS Code product telemetry (VS Code setting / privacy UI → `vscode.env.isTelemetryEnabled === false`).
2. The Kilo extension **skips** webview→CLI `POST /telemetry/capture` when VS Code telemetry is off, and calls `POST /telemetry/setEnabled` so the CLI PostHog client opts out at runtime.

For belt-and-suspenders when the extension spawns CLI, also set `KILO_TELEMETRY_LEVEL=off` (or config Option A) in the environment used for `kilo serve`.

---

## Optional host block

If you also want network enforcement (broken opt-out, compromised binary, or defense in depth):

- DNS sinkhole / firewall: `us.i.posthog.com`
- Kilo’s own shutdown path already soft-fails when PostHog is unreachable (exit is bounded; telemetry must not hang short commands)

Do **not** block `api.kilo.ai` / `app.kilo.ai` for telemetry alone — those are Gateway / console control plane.

---

## Verification

1. Set Option A and/or B; restart CLI / `kilo serve`.
2. Confirm no successful POSTs to `us.i.posthog.com` (Little Snitch, `lsof -i`, mitmproxy, pf logs, etc.).
3. Optional: remove or ignore `~/.local/share/kilo/telemetry-id` if you do not want a stable local machine id retained (regenerated on next enable).

---

## Honesty

- Opt-out is a **Kilo host** feature, not something OCP plugins implement or guarantee.
- Companion apps (mobile, etc.) may use other vendors (Sentry, AppsFlyer, …) outside this CLI PostHog path — see Kilo product privacy pages.
- Re-check after Kilo upgrades; key names and defaults can drift.
