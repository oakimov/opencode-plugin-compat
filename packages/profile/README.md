# @opencode-compat/profile

HostProfile types, draft profiles (`opencode` / `mimo` / `kilo` / `zcode`), and `detect()`.

**License:** MPL-2.0

```ts
import { detect, mimoProfile, CORE_HOOKS } from "@opencode-compat/profile"

const { profile, supported, message } = detect()
// or: detect({ env: { OPENCODE_COMPAT_HOST: "mimo" } })
```

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md) §5.
