# @opencode-compat/adapter

Universal OCP host adapter. **One** runtime: detect the host (`HostProfile`), then map facade calls to that host’s native SDK. Host differences are profile data + internal dispatch — not separate packages per host.

Also owns **Option B** LanguageModel adoption helpers used by `ocp setup` provider entry shims: host-profile stream behavior (`streamToolCallEnsure`, `bashDescriptionRequired`, `clearSettledTodos`) plus host-independent argument-key adoption from each tool's advertised schema. V3 aggregates are normalized into coherent cache and reasoning partitions for streaming and generation. Unknown exact totals remain unknown. Entries are force-instrumented in place without backups; rebuild/reinstall restores out-of-box files. See [OCP 0.1 §6.5](../../docs/ocp/0.1.md).

Kilo and MiMo keep context snapshots on assistant messages and reconcile
separate step accounting through public plugin events. Any provider can opt
in through the neutral `usageVersion: 3` metadata contract. Devin additionally
has a package-selected integration for cache counters that represent context
snapshots rather than billed input partitions. Generic providers do not infer
provider semantics from metadata names. Install-tree runtime copies share
the reconciliation state; rerun `ocp setup` to refresh existing shims.
Instrumented plugin entries gain one event-only `__ocpUsageEvents` export;
the provider's own exports keep their identity, so hosts load its plugin
once. Each host event is reconciled once, also for providers that forward
events themselves.

Clone-host Devin usage retains the billed aggregate and cost; its larger
snapshot is preserved as `providerMetadata.ocpContext`. Native clone context
meters do not consume that separate field. Replacing billed usage with the
snapshot would inflate native assistant costs, which the public part-update
API cannot repair. Pi, OMP, and DSH use their separate metering seams instead.

**End-user install:** [MiMo/Kilo](../../docs/hosts/opencode-clones.md) · [pi/omp](../../docs/hosts/pi-family.md) · [DSH](../../docs/hosts/dsh-family.md). **License:** MPL-2.0

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md).
