# Provider host action reliability

- [x] Audit the MiMo provider session and separate host-visible results from the provider's pre-wrapper debug output.
- [x] Identify the detection boundary and define safe precedence for runtime identity.
- [x] Recognize host-owned runtime markers in the shared profile detector and generated shim runtime.
- [x] Use the setup-time install-tree host hint only when stronger runtime detection is unavailable.
- [x] Add unit and generated-shim integration coverage for MiMo and pass-through hosts.
- [x] Update OCP documentation and record the correction lesson.
- [x] Run focused tests, typecheck, build, and the full suite.

## Universal schema-key adoption

- [x] Derive target property names from each call's advertised tool schema rather than host identity.
- [x] Preserve exact keys and rename only unique separator/case-insensitive matches.
- [x] Support nested objects, arrays, and local schema composition without guessing ambiguous keys.
- [x] Apply the same logic to stream and generate results in both the adapter and generated install-tree runtime.
- [x] Verify future-fork naming conventions, OpenCode pass-through, ambiguous schemas, and MCP-owned schemas.
- [x] Refresh documentation, generated MiMo shims, and all verification gates.
- [x] Restrict provider discovery so unrelated `create*` utility exports are not shimmed.

## Design

OCP remains the sole owner of LanguageModel adoption. Detection precedence is explicit override, live binary/environment identity, then the setup-time host hint attached to the host-specific install tree. Host capabilities still control behavioral gaps such as stream initialization, while argument-key adoption is driven by the exact advertised tool schema and therefore also supports future forks and external MCP tools without host-specific naming tables. Provider packages do not need host-specific code.

## Review

- Log evidence: the captured write completed and returned through Cursor's held stream. The provider's debug log records its own pre-wrapper parts, so its bare `tool-call` line does not show what MiMo received after OCP adoption.
- Residual defect fixed: the installed entry recorded `hostHint: "mimo"`, but generated code ignored the hint and recognized too few host-owned environment markers. A provider worker without a host name in its executable path could therefore select the safe pass-through policy.
- Fix: recognize host-owned marker names and prefixes, inspect binary basenames instead of full argv paths, and use the validated setup-time hint only after explicit/live detection fails.
- Scope: this remains an OCP install-tree action for all compatible `create*` LanguageModel providers; no consumer-provider fork or host-specific provider code is required.
- Verification: focused tests (54 passed), full suite (80 passed), TypeScript project build/typecheck, installed-runtime smoke, and `git diff --check` all pass.
- Universal follow-up: provider tool arguments are now aligned at the final LanguageModel boundary from the exact schema supplied by the active host. Canonical matching removes separators and folds case, but only a unique match is renamed; exact, semantic-mismatch, and ambiguous keys are preserved. The same recursive implementation is present in the source adapter and generated zero-dependency runtime.
- Installation follow-up: a Kilo cache refresh exposed that arbitrary packages with a `create*` export (including `fast-check`) were considered providers. Discovery now requires a provider signal (`@ai-sdk/provider`, `languageModel`, or a provider package name), and regression coverage proves utility packages remain untouched.
