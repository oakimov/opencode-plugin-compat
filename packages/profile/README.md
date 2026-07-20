# @opencode-compat/profile

HostProfile types, draft profiles (`opencode` / `mimo` / `kilo` / `zcode`), `detect()`, and facade override helpers for `ocp setup`.

Capability flags include Option B adoption inputs (`streamToolCallEnsure`, `bashDescriptionRequired`) — see [OCP 0.1 §5–§6.5](../../docs/ocp/0.1.md).

**License:** MPL-2.0

```ts
import { detect, mimoProfile, CORE_HOOKS } from "@opencode-compat/profile"

const { profile, supported, message } = detect()
// or: detect({ env: { OPENCODE_COMPAT_HOST: "mimo" } })
```

**End-user install:** [INSTALL.md](../../INSTALL.md).

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md) §5.