# @opencode-compat/adapter

Universal OCP host adapter. **One** runtime: detect the host (`HostProfile`), then map facade calls to that host’s native SDK. Host differences are profile data + internal dispatch — not separate packages per host.

Also owns **Option B** LanguageModel adoption helpers used by `ocp setup` provider entry shims: host-profile stream behavior (`streamToolCallEnsure`, `bashDescriptionRequired`) plus host-independent argument-key adoption from each tool's advertised schema. See [OCP 0.1 §6.5](../../docs/ocp/0.1.md).

**End-user install:** [INSTALL.md](../../INSTALL.md). **License:** MPL-2.0

See the monorepo [README](../../README.md) and [OCP 0.1](../../docs/ocp/0.1.md).
