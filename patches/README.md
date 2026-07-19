# Host enablement notes (not upstream patches)

OCP is an **external compatibility layer** for OpenCode-compatible hosts. It is **not** delivered by PRing or forking MiMo/Kilo.

| Host | Notes | Upstream (read-only reference) |
|------|-------|--------------------------------|
| **MiMo** | [mimo.md](./mimo.md) | [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) |
| **Kilo** | [kilo.md](./kilo.md) | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) |

These notes document how operators / this repo’s packages attach to a host (install-tree overrides via **`ocp setup`**, path dual-scan expectations, Promise v2 kit). They are **not** patch series to merge into those repos.

**User delivery UX (locked):** install `@opencode-compat/ocp` → run **`ocp setup`** → add consumer plugins via host config. A host `plugin` list entry for OCP alone is not Layer A.

**Do not** open upstream PRs, maintain long-lived host forks, or treat `patches/` as a contribution track to XiaomiMiMo / Kilo-Org.
