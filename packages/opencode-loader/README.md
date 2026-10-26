# @opencode-compat/opencode-loader

Host-neutral loader for unmodified OpenCode `aisdk`-type plugins
(`hooks.auth`, `config.provider[id].models`, root `createXxx()` factory).

Used by `@opencode-compat/pi-bridge` and `@opencode-compat/dsh-bridge`. It does
not register anything with a host. Do not install this package as a DSH bundle
or a Pi extension by itself.

`withHostSkills(skills, run)` scopes advertised metadata to a provider request and its async work. Independently bundled copies share the same async context, so installing another provider's global reader preserves earlier providers' request catalogs without mixing concurrent requests. `currentRecordedHostSkills()` returns a copy of that snapshot, or an empty list outside a request. Hosts install the structural `opencode.host.skills` list before loading the provider. No skill bodies or filesystem discovery are involved.

`createToolCatalogOrder()` keeps each session's first nonempty descriptors in place and appends sorted newcomer batches; empty lifecycle calls remain empty.

**License:** MPL-2.0
