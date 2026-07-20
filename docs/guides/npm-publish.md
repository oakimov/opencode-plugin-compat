# Publish `@opencode-compat/*` to npm (public)

Operator guide for the first and later releases of the OCP bridge.

OCP **never** publishes under `@opencode-ai/*` — only **public** `@opencode-compat/*`, remapped into host plugin install trees by **`ocp setup`**.

All workspace packages ship with:

```json
"publishConfig": { "access": "public" }
```

They are **not** private packages. First publish and CI both pass `--access public`.

---

## Prerequisites

1. [Bun](https://bun.sh) ≥ 1.2 (`packageManager` pins `bun@1.3.14`)
2. npm account that **owns** the **`opencode-compat`** org ([org create](https://www.npmjs.com/org/create) if needed)
3. Public GitHub repo `oakimov/opencode-plugin-compat` (needed for OIDC provenance)
4. Release commits you intend to ship on `main`
5. `bun install && bun run build && bun test`

---

## First-time publishing (bootstrap 0.1.0)

Trusted Publishing (OIDC) can only be attached **after** each package already exists on the registry. The first train is therefore a **local create-publish**, then a one-time Trusted Publisher registration.

### 1. Confirm org + login

```bash
npm login
npm whoami                    # e.g. oakimov
npm org ls opencode-compat    # you should be owner
```

### 2. Dry-run

```bash
cd /path/to/opencode-plugin-compat
bun run pack:check
```

This builds, typechecks, tests, and `bun pm pack --dry-run`s all 8 **public** packages in dependency order.

### 3. Create-publish locally (interactive)

Run in a **real terminal** (npm 2FA will prompt for OTP):

```bash
bun run publish:npm
# same as: bun scripts/publish.ts --publish
```

What this does:

1. Build + test  
2. Pack each package with **Bun** (rewrites `workspace:*` → `0.1.0`)  
3. `npm publish <tarball> --access public` for each package  

Order:

1. `@opencode-compat/profile`
2. `@opencode-compat/host-promise-v2`
3. `@opencode-compat/migrate-zcode`
4. `@opencode-compat/adapter`
5. `@opencode-compat/facade-sdk`
6. `@opencode-compat/facade-plugin`
7. `@opencode-compat/cli`
8. `@opencode-compat/ocp`

If a mid-train publish fails after some packages succeeded:

```bash
bun scripts/publish.ts --publish --skip-existing
```

**Avoid OTP spam (optional):** create a granular npm token with publish rights on `@opencode-compat/*` and **Bypass 2FA for automation**, put it in `~/.npmrc`, then re-run `bun run publish:npm`.

### 4. Verify public packages

```bash
npm view @opencode-compat/ocp version
npm view @opencode-compat/profile version
# should print 0.1.0 for each
```

Or open https://www.npmjs.com/package/@opencode-compat/ocp — access should be **Public**.

### 5. Register Trusted Publisher (one-time, all 8 packages)

Required so later tag pushes publish **without** a long-lived npm token (same pattern as `cursor-opencode-provider`).

For **each** package below, on npmjs.com:

1. Open the package → **Settings** → **Trusted Publisher**  
2. Add **GitHub Actions**:
   - Organization / user: `oakimov`
   - Repository: `opencode-plugin-compat`
   - Workflow filename: `publish.yml`  *(exactly — no path)*  
   - Permit publishing  

Packages:

- `@opencode-compat/profile`
- `@opencode-compat/host-promise-v2`
- `@opencode-compat/migrate-zcode`
- `@opencode-compat/adapter`
- `@opencode-compat/facade-sdk`
- `@opencode-compat/facade-plugin`
- `@opencode-compat/cli`
- `@opencode-compat/ocp`

Ensure `.github/workflows/publish.yml` is on `main` before the next tagged release.

### 6. Smoke-test as a consumer

```bash
bun add -g @opencode-compat/ocp
# bins use #!/usr/bin/env bun — Bun must be on PATH

ocp doctor --host mimo
# After host plugins are installed:
ocp setup --host mimo
ocp setup --host kilo
```

---

## Later releases (OIDC / no OTP)

```bash
# 1. Bump the whole train (package.json + VERSION constants + bun.lock)
bun scripts/bump-version.ts 0.1.2

# 2. Verify (fails closed if bun.lock or packed deps drift from the train)
bun run pack:check

# 3. Commit + push main (include bun.lock)
git add -A && git commit -m "chore: release 0.1.2"
git push origin main

# 4. Tag must match package version (v-prefix)
git tag v0.1.2
git push origin v0.1.2
```

`bump-version.ts` rewrites **`bun.lock` workspace package versions** to match the train (plain `bun install` alone will not), then runs `bun install` to validate. Bun’s `pm pack` rewrites `workspace:*` **from the lockfile**, not from `package.json` — a stale lock publishes wrong transitive pins (what happened on `0.1.1`).

`pack:check` / publish always:

1. Assert all package.json versions are equal (the train)  
2. Assert `bun.lock` workspace versions equal that train  
3. Pack tarballs and assert every packed `@opencode-compat/*` dependency is an **exact** train pin  

GitHub Actions workflow **Publish** then:

- install → typecheck → test → build  
- `bun scripts/publish.ts --publish --oidc --skip-tests`  
- packs with Bun, publishes each **public** tarball with `npm publish --access public --provenance` via OIDC  

No `NPM_TOKEN` secret. Publisher identity will look like `GitHub Actions <npm-oidc-no-reply@github.com>`.

---

## Scripts reference

| Script | Purpose |
|---|---|
| `bun run pack:check` / `publish:dry` | Build + test + pack + **train gates** (lockfile + packed deps) |
| `bun run pack` | Same (tarballs under `.tmp/npm-pack`) |
| `bun run publish:npm` | Local/first-time publish (public) |
| `bun scripts/publish.ts --publish --oidc` | CI Trusted Publishing |
| `bun scripts/publish.ts --publish --skip-existing` | Resume after partial publish |
| `bun scripts/bump-version.ts <ver>` | Sync train version across packages **and refresh bun.lock** |

---

## Notes

- **Public only** — never set `"private": true` on workspace packages; never publish with restricted access.
- **Do not** publish impersonating `@opencode-ai/plugin` / `@opencode-ai/sdk`. Layer A overrides remap those names to `@opencode-compat/facade-*` inside host install trees only.
- Re-run `ocp setup` after host plugin install/upgrade.
- Keep all eight package versions equal for a train release.
- Always commit the refreshed **`bun.lock`** with a version bump. Publish CI will fail if lockfile or packed deps disagree with the train.
- `prepack` runs `tsc` per package; root scripts still build the project-references graph first.
- Bun shebang CLIs (`ocp`, `compat`, `opencode-compat`) require Bun on `PATH` after global install.