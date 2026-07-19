# Reference M1 patches

Reference patches / PR outlines for cooperating forks. Cite **GitHub repo paths only** (no local checkout paths).

| Host | Outline | Upstream | PR-source fork |
|------|---------|----------|----------------|
| **MiMo** | [mimo-m1.md](./mimo-m1.md) | [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) | [oakimov/MiMo-Code](https://github.com/oakimov/MiMo-Code) |
| **Kilo** | [kilo-m1.md](./kilo-m1.md) | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | [oakimov/kilocode](https://github.com/oakimov/kilocode) |

Each outline covers:

1. **Layer A** — install-time facade overrides (`@opencode-ai/plugin` → `@opencode-compat/facade-*`)
2. **Layer B** — `.opencode` dual-scan (MiMo always-on; Kilo opt-in via `KILO_OCP_SCAN_OPENCODE`)
3. **Layer E** — embed [`host-promise-v2`](https://github.com/oakimov/opencode-plugin-compat/tree/main/packages/host-promise-v2) at provider-resolve

See [`docs/plans/phase0-adr-universal-compat.md`](https://github.com/oakimov/opencode-plugin-compat/blob/main/docs/plans/phase0-adr-universal-compat.md) §P3.
