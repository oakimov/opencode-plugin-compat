# @opencode-compat/host-promise-v2

Shared Promise v2 aisdk host kit wired from the OCP layer.

Matches OpenCode `@opencode-ai/plugin/v2/promise` shape:

```ts
import {
  createPromiseV2Host,
  define,
} from "@opencode-compat/host-promise-v2"

const plugin = define({
  id: "demo",
  async setup(ctx) {
    await ctx.aisdk.sdk(async (event) => {
      // event.sdk = …
    })
    await ctx.aisdk.language(async (event) => {
      // event.language = LanguageModelV3
    })
  },
})

const host = createPromiseV2Host()
await host.register(plugin)
const { language, sdk } = await host.resolveProvider({
  providerID: "demo",
  modelID: "m1",
  package: "demo-pkg",
})
```

Adapter helper: `wirePromiseV2()` from `@opencode-compat/adapter` / `@opencode-compat/ocp`.

On MiMo/Kilo there is **no** native in-process aisdk emit yet — operators call `resolveProvider` from an external sidecar after Layer A setup. See [`docs/hosts/mimo.md`](../../docs/hosts/mimo.md) §3 (copy-paste smoke + success criteria).

**License:** MPL-2.0

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md).
