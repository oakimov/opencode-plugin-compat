# Disable MiMo Code product analytics

**Status:** companion privacy guide (not an OCP runtime feature)  
**Host:** MiMo Code CLI (`@mimo-ai/cli` / XiaomiMiMo/MiMo-Code)  
**Evidence baseline:** [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) (`packages/opencode/src/metrics` → Xiaomi tracking) + [oa-tools/mimo-review/MIMO_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/mimo-review/MIMO_RESEARCH.md) §6–§7

MiMo ships **Xiaomi usage analytics on by default**, with a **first-party env opt-out**. Prefer that over firewalling.

Related: [Kilo telemetry disable](./kilocode-telemetry-disable.md) · [ZCode telemetry block (docs-only)](./zcode-telemetry-block.md)

---

## What is sent

| | Detail |
|---|---|
| Client path | `packages/opencode/src/metrics` (MiMo fork tree) |
| Endpoint | `https://tracking.miui.com/track/v4/o` |
| Default | **Enabled** unless opted out |
| Opt-out | `MIMOCODE_ENABLE_ANALYSIS=false` |

This guide covers **MiMo product / usage analysis** to Xiaomi tracking. Separate OpenTelemetry / local tracing plumbing (if present) is not the Xiaomi `tracking.miui.com` path and is **not** claimed to be gated by this env var.

**Honesty:** Hosted MiMo Auto / Xiaomi platform inference can still send **code and prompts to Xiaomi** when you use those models — that is inference traffic, not the metrics opt-out below. Opting out of analysis does **not** anonymize hosted LLM usage.

---

## Recommended disable

### Environment (primary / documented)

```bash
export MIMOCODE_ENABLE_ANALYSIS=false
```

Put the export in your shell profile, IDE run config, or the environment of whatever spawns `mimocode` / `@mimo-ai/cli`.

| `MIMOCODE_ENABLE_ANALYSIS` | Result |
|---|---|
| unset / anything other than `false` (typical) | analytics **enabled** (default) |
| `false` | analytics **disabled** |

Re-check after MiMo upgrades — flag spelling and default can drift.

### Optional host block

If you also want network enforcement (broken opt-out, compromised binary, or defense in depth):

- DNS sinkhole / firewall: `tracking.miui.com`

Do **not** treat blocking Xiaomi **inference / OAuth / install CDN** hosts as “telemetry only” — those are product control-plane and model paths (see MiMo install / config schema hosts such as `mimo.xiaomi.com`).

---

## Verification

1. Export `MIMOCODE_ENABLE_ANALYSIS=false`; restart the MiMo CLI.
2. Confirm no successful POSTs to `tracking.miui.com` (Little Snitch, `lsof -i`, mitmproxy, pf logs, etc.).
3. If you still use MiMo Auto / Xiaomi-hosted models, expect separate HTTPS to Xiaomi inference endpoints — that is **not** fixed by the analysis flag.

---

## Honesty

- Opt-out is a **MiMo host** feature, not something OCP plugins implement or guarantee.
- Compared to ZCode (no in-app opt-out), MiMo is transparent and open-source about the flag — but still **defaults to on**.
- Re-check after MiMo upgrades; key names and endpoints can drift.
