# Contributing to opencode-plugin-compat

External contributions are welcome. Start with an idea or bug report when the change is non-trivial (see below).

## Before you write code

Post an [idea or proposal](https://github.com/oakimov/opencode-plugin-compat/issues) first and wait for maintainer direction for new features, public APIs or configuration, host integrations, permission or lifecycle changes, broad refactors, dependency bumps, or changes to the package train. Bugs go to the same issue tracker with the evidence below.

Security vulnerabilities: report privately to the maintainer, using GitHub's private vulnerability reporting when available. Do not open a public issue, discussion or PR with vulnerability details, credentials or unredacted logs.

OCP owns compatibility between unchanged consumer providers and stock hosts. **Host checkouts, installed vendor binaries and vendor packages are read-only references.** Fix compatibility in OCP through public or host-injected extension/runtime seams; do not patch a host or add OCP detection, alternate-host vocabulary or host-specific schemas to a consumer provider. See [AGENTS.md](./AGENTS.md) for the governing boundaries.

## Bug reports

Every bug issue must include:

- Clear **reproduction steps**: host family/version, install mode, OCP package versions, consumer provider/version and entrypoint, selected model, expected behavior and actual result.
- The **loaded runtime**: resolved OCP build/profile and provider build, plus whether the host was restarted after rebuilding or reinstalling.
- Relevant **host and provider logs** from the same reproduction, with command exit statuses.
- A transcript or observable side effect for tool translation, streaming, cancellation, permissions, planning or execution handoffs. For interactive failures, describe the complete user flow and which approval or transition failed.

Use [TESTING.md](./TESTING.md) and the guide for the affected family: [OpenCode clones](./docs/hosts/opencode-clones.md), [Pi family](./docs/hosts/pi-family.md) or [DSH family](./docs/hosts/dsh-family.md). Compare tool declarations and the active catalog with [docs/tool-vocabulary.md](./docs/tool-vocabulary.md) for tool-contract failures.

Redact tokens, API keys, session/device IDs, account information, private identities and local paths before sharing evidence. Issues without a reproducible failure or relevant logs will be closed; for install/build failures before a model can run, state which evidence is unavailable and include the failing command and output.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test ./test
bun run test:coverage
bun run matrix
```

For package, dependency or published-bin changes, also run `bun run pack:check`. This is the package inspection gate; releases and publication must follow [AGENTS.md](./AGENTS.md) and [docs/guides/npm-publish.md](./docs/guides/npm-publish.md).

Rebuild and refresh the installed OCP/provider output, restart the affected stock host, and verify the loaded runtime before claiming a fix. Local development guidance lives in [TESTING.md](./TESTING.md); native OpenCode loads providers directly and must not be wrapped with an OCP development shim.

## Pull requests

We strive for exceptional quality and consistency. Keep at most **3 open PRs** per contributor at a time.

When opening one:

- Keep it small and focused on one problem.
- Explain the problem and fix in your own words; say how you verified it.
- For behavior changes, include **A/B testing results**: before versus after, tested revisions, stock host versions, OCP profiles, consumer providers/models, transcript and side effects, and what improved or regressed. Identify local fixtures, mocked tests and actual installed-host acceptance separately.
- **Preserve each host's security, sandbox and permission model.** Trace canonical catalog → arguments → validation → execution → replay. Downstream repairs do not satisfy upstream required-field validation.
- Keep the three mechanisms separate: clone facades and adapter, Pi bridge, and DSH bridge. Keep generic paths provider-neutral; provider-specific integrations must remain explicit and optional. Preserve existing behavior when relocating translation responsibilities.
- Add meaningful regressions for every affected path. Shared translation changes must verify all affected host families and consumer providers, including generic-provider behavior; one bridge's passing tests do not establish another host's acceptance.
- **Interactive changes need interactive acceptance on the stock host.** Drive approval dialogs, mode switches, plan review and execution handoffs in a real TTY; verify the transcript, side effect and absence of retries. Report a concrete compatibility limitation when stock extension/runtime seams cannot express the behavior.
- **Do not regress prompt caching or session continuity.** Verify stable catalogs, warm context, tool-result continuation, resume/cancellation behavior and relevant usage accounting at the tested head. Use the applicable [Cursor](./docs/guides/cursor-ocp-self-verify.md) or [Devin](./docs/guides/devin-ocp-self-verify.md) self-verification guide when those consumers are affected.
- Use native OpenCode 1.x and 2.0 as controls where applicable; they load providers directly. Verify every affected foreign-host consumer independently and explain exclusions with evidence.
- Update [docs/tool-vocabulary.md](./docs/tool-vocabulary.md) when active host tool contracts change. Keep architecture checks and package boundaries intact, including workspace pins, compiled bins and packed dependencies when affected.
- Link `Fixes #123` or `Closes #123` when applicable. Update [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` for user-facing changes and keep the relevant host guide accurate.
- Prefer conventional-commit titles (`fix:`, `docs:`, `test:`). PR descriptions must be concise, concrete and written for people.
- Keep credentials and private data out of source, fixtures, logs, reports and commit metadata. Scan outgoing content before publication and use public GitHub noreply attribution.

Missing access, skipped checks, setup/doctor output and model registration alone are validation gaps, not live behavior acceptance. ZCode remains detect/doctor-only; its migration companion does not establish OpenCode plugin loadability.

### Review and coverage requirements

- Pull request reviews follow the repository [review rubric](./docs/review-rules.md), including blocker checks for secrets, the vendor boundary, the provider boundary, the three host mechanisms, catalog integrity, and tool-vocabulary drift.
- **Resolve every Greptile finding before merge, regardless of severity**, including minor issues and nits. Address each finding and resolve its review thread; leave no open Greptile issues.
- **Provide sufficient test coverage for new and changed behavior**, including relevant error paths. Address uncovered changes and coverage regressions reported by Codecov; all applicable Codecov checks must pass under the repository's [coverage configuration](codecov.yml).
- CI job **`Typecheck, test, build`** must pass on the PR merge with `main`. Coverage for Codecov is measured on the PR head (see `.github/workflows/ci.yml`).
- **PRs with unresolved Greptile findings or Codecov coverage issues will be closed if they go 3 days without an update addressing those issues.** Keep the PR updated while working through review and coverage feedback.

## License

Contributions are licensed under the [Mozilla Public License 2.0](./LICENSE), matching OCP's package train.
