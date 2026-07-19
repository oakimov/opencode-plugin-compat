# @opencode-compat/migrate-zcode

Companion **plugin package migrator**: take a plugin directory that vendors
`skills/`, `commands/`, and marketplace manifests (`.zcode-plugin` /
`.claude-plugin` / `.codex-plugin` / `marketplace.json`) and emit a ZCode
`.zcode-plugin` tree. Optional **marketplace wrap** packs one or more plugins
into a glm-fleet-shaped catalog (`plugins/<slug>/` + root `marketplace.json`).

**Not OCP.** Does **not** run `@opencode-ai/plugin` JS hooks on ZCode (T0).
**Does not migrate host MCP** — ZCode uses its own MCP; this tool never reads
`opencode.json` MCP maps.

**License:** MPL-2.0

```ts
import {
  migrateZcode,
  migrateZcodeMarketplace,
} from "@opencode-compat/migrate-zcode"

const { report, tree } = await migrateZcode({
  pluginDir: "/path/to/plugin-package",
  outDir: "/path/to/out-zcode-plugin",
})

// Multi-plugin marketplace wrap (glm-fleet layout):
const fleet = await migrateZcodeMarketplace({
  pluginDirs: ["/path/to/a", "/path/to/b"],
  outDir: "/path/to/out-fleet",
  marketplaceName: "my-fleet",
  ownerName: "oakimov",
})
```

Plan: [`docs/plans/zcode-asset-migrator-plan.md`](../../docs/plans/zcode-asset-migrator-plan.md)
