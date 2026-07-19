# Conformance fixtures

OCP §10 Plugin×Host×Tier fixtures. Run via CLI:

```bash
bun run matrix
# or
bun packages/cli/bin/compat.ts matrix
bun packages/cli/bin/compat.ts matrix --host mimo --compat-scan
bun packages/cli/bin/compat.ts matrix --fixture v2.aisdk.language --host opencode
```

| Fixture | Tier | Notes |
|---------|------|--------|
| `classic.auth.oauth-shape` | T1 | Auth oauth authorize/callback smoke |
| `classic.config-mutate` | T1 | `config` hook mutates input |
| `classic.tool-before-after` | T1 | tool execute hooks |
| `classic.chat-params` | T1 | `chat.params` mutates options |
| `alias.resolve-plugin` | T1 | facade-plugin / facade-sdk resolve |
| `local.dot-opencode-scan` | T2 | native scan or `--compat-scan` (operator/docs expectation) |
| `v2.aisdk.language` | T3 | LanguageModelV3 injection via host kit |
| `v2.unsupported-domain` | T3 | loud stub for unimplemented domains |
| `zcode.t0-doctor` | T0 | ZCode doctor message only |

Programmatic API: `runMatrix`, `formatMatrix`, `matrixOk` from `./index.ts`.