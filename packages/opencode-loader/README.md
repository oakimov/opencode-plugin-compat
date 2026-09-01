# @opencode-compat/opencode-loader

Host-neutral loader for unmodified OpenCode `aisdk`-type plugins
(`hooks.auth`, `config.provider[id].models`, root `createXxx()` factory).

Used by `@opencode-compat/pi-bridge` and `@opencode-compat/dsh-bridge`. It does
not register anything with a host. Do not install this package as a DSH bundle
or a Pi extension by itself.

**License:** MPL-2.0
