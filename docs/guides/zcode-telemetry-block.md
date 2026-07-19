# Block ZCode telemetry (host firewall / DNS)

**Status:** documentation only — **not** an OPHP feature, marketplace plugin, or in-app kill switch  
**Host:** ZCode desktop (verified against **3.3.6** arm64)  
**Evidence:** [oa-tools/zcode-review/ZCODE_RESEARCH.md](https://github.com/oakimov/oa-tools/blob/main/zcode-review/ZCODE_RESEARCH.md); plan notes in [`universal-opencode-plugin-compat-plan.md`](../plans/universal-opencode-plugin-compat-plan.md) §7.1

ZCode has **no first-party telemetry opt-out**. OPHP cannot disable ARMS / product events from inside a plugin. This guide is host-level mitigation only.

Related (hosts **with** in-app opt-out):

- Kilo: [`kilocode-telemetry-disable.md`](./kilocode-telemetry-disable.md)
- MiMo: `MIMOCODE_ENABLE_ANALYSIS=false`

---

## Targets

| Class | Endpoint | Notes |
|---|---|---|
| Alibaba ARMS RUM | `proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com` (`/rum/web/v2`) | Always-on in 3.3.6 (`RF.init({enable:!0…})`) |
| ARMS wildcards (defense in depth) | `*.log.aliyuncs.com`, `*.rum.aliyuncs.com` as needed | Hostnames can rotate across builds |
| Product analytics | `https://zcode.z.ai/api/v1/event/report` | May rewrite onto a custom origin when `ZCODE_BASE_URL` / endpoint override is set |

**Evidence (3.3.6):** telemetry uses **hostname-only** endpoints. No reverse-DNS / PTR / IP-literal fallback in main bundles or `@arms/rum-electron`. The literal `http://192.168.6.166:8080` found in research is a **ZAPI catalog stub**, not telemetry.

---

## Tiered recipes

### Tier A — ARMS only (keeps `zcode.z.ai` control plane)

DNS sinkhole / Little Snitch / `pf` / Pi-hole the ARMS host(s) above (and wildcards if desired).

- Soft-fails / warns; app typically continues.
- Stops Alibaba RUM upload.
- Does **not** stop `zcode.z.ai` product `event/report`.

### Tier B — ARMS + product events (keep BYO LLM)

Also suppress product analytics:

1. **Preferred when available:** HTTPS path-aware proxy / filter for `zcode.z.ai` path `/api/v1/event/report` only.
2. **If path filtering is unavailable:** block whole host `zcode.z.ai` (see breakage matrix).

Use API-key / BYO models against non-`zcode.z.ai` catalog hosts (`api.z.ai`, `open.bigmodel.cn`, …).

### Tier C — maximum isolation

Block ARMS + `zcode.z.ai`; use API-key BYO only. Expect OAuth / Coding Plan / remote WS to fail.

---

## Breakage matrix when blocking `zcode.z.ai`

| Still typically works | Breaks |
|---|---|
| Local UI shell | OAuth / token refresh |
| API-key BYO inference to `api.z.ai` / `open.bigmodel.cn` / other catalog hosts | Client config fetch / updates |
| | WebSocket remote (`wss://zcode.z.ai/ws`) |
| | Coding Plan / Start Plan LLM proxy (`/api/v1/zcode-plan*`) |

Do **not** block whole `zcode.z.ai` “for telemetry alone” without accepting that matrix — the host is shared control plane **and** Coding Plan inference.

---

## Verification

1. Launch ZCode; trigger chat / idle long enough for RUM cycles.
2. Confirm ARMS host and (if Tier B/C) `…/api/v1/event/report` fail in Console.app / `lsof -i` / packet-filter logs.
3. Optional Tier B/C: confirm BYO chat to non-`zcode.z.ai` hosts still works.

---

## Honesty

- **Not** deliverable via OPHP, `.zcode-plugin`, ASAR patch, or `NODE_OPTIONS` (packaged Electron rejects useful injection paths; resign rejected as product path).
- Soft-fail telemetry ≠ “silent perfect privacy.” CDN / project hosts can change; re-check after ZCode upgrades.
- ZCode remains **T0** for OpenCode plugin compatibility (marketplace ABI ≠ `@opencode-ai/plugin`).
