# Host enablement notes

OCP is an **external compatibility layer** for OpenCode-compatible hosts.

| Host | Notes | Upstream (read-only reference) |
|------|-------|--------------------------------|
| **MiMo** | [mimo.md](./mimo.md) | [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) |
| **Kilo** | [kilo.md](./kilo.md) | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) |

These notes document how operators / this repo’s packages attach to a host (install-tree overrides via **`ocp setup`**, path expectations, Promise v2 kit). Hosts remain read-only references.

**User delivery UX (locked):** install `@opencode-compat/ocp` → run **`ocp setup`** → add consumer plugins via host config. A host `plugin` list entry for OCP alone is not Layer A.
