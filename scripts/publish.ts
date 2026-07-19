#!/usr/bin/env bun
/**
 * Prepare / dry-run / publish public `@opencode-compat/*` in dependency order.
 *
 * Usage:
 *   bun scripts/publish.ts                 # build + test + pack dry-run
 *   bun scripts/publish.ts --pack           # also write tarballs under .tmp/npm-pack
 *   bun scripts/publish.ts --publish        # first-time / local (OTP-friendly)
 *   bun scripts/publish.ts --publish --oidc # CI Trusted Publishing (npm + OIDC)
 *
 * Always packs with Bun (rewrites workspace:* → concrete versions), then
 * publishes via `npm publish <tarball> --access public` so packages stay public
 * and CI can use npm OIDC provenance (Bun alone does not drive Trusted Publishing).
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** Bottom-up publish order (dependents last). */
export const PACKAGES = [
  "profile",
  "host-promise-v2",
  "migrate-zcode",
  "adapter",
  "facade-sdk",
  "facade-plugin",
  "cli",
  "ocp",
] as const

type PkgJson = {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  files?: string[]
  bin?: Record<string, string>
  publishConfig?: { access?: string }
}

function run(
  command: string,
  args: string[],
  cwd = ROOT,
  opts: { inheritStdio?: boolean } = {},
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    ...(opts.inheritStdio
      ? { stdio: "inherit" as const }
      : { encoding: "utf8" as const }),
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  }
}

function readPkg(dirName: string): PkgJson {
  const path = join(ROOT, "packages", dirName, "package.json")
  return JSON.parse(readFileSync(path, "utf8")) as PkgJson
}

function trainVersion(): string {
  const versions = new Set(PACKAGES.map((dir) => readPkg(dir).version))
  if (versions.size !== 1) {
    throw new Error(
      `Train version mismatch across packages: ${[...versions].join(", ")}. ` +
        `Bump together with: bun scripts/bump-version.ts <version>`,
    )
  }
  return [...versions][0]!
}

function assertTagMatches(version: string): void {
  const refType = process.env.GITHUB_REF_TYPE
  const refName = process.env.GITHUB_REF_NAME
  if (refType === "tag" && refName) {
    const expected = refName.replace(/^v/, "")
    if (expected !== version) {
      throw new Error(
        `Git tag ${refName} does not match package versions ${version}. ` +
          `Tag must be v${version}.`,
      )
    }
    return
  }

  // Local optional: --tag v0.1.0
  const args = process.argv.slice(2)
  const tagIdx = args.indexOf("--tag")
  if (tagIdx >= 0) {
    const tag = args[tagIdx + 1]
    if (!tag) throw new Error("--tag requires a value like v0.1.0")
    const expected = tag.replace(/^v/, "")
    if (expected !== version) {
      throw new Error(`--tag ${tag} does not match package versions ${version}`)
    }
  }
}

function assertPublishReady(): string {
  const version = trainVersion()
  assertTagMatches(version)

  for (const dir of PACKAGES) {
    const pkg = readPkg(dir)
    if (pkg.private) {
      throw new Error(
        `${pkg.name}: package.json has "private": true — OCP packages must be public`,
      )
    }
    if (pkg.publishConfig?.access && pkg.publishConfig.access !== "public") {
      throw new Error(
        `${pkg.name}: publishConfig.access must be "public" (got ${pkg.publishConfig.access})`,
      )
    }
    if (!pkg.files?.length) throw new Error(`${pkg.name}: missing files[]`)

    const distIndex = join(ROOT, "packages", dir, "dist", "index.js")
    if (!existsSync(distIndex)) {
      throw new Error(`${pkg.name}: missing ${distIndex} — run bun run build`)
    }

    if (pkg.bin) {
      for (const [binName, rel] of Object.entries(pkg.bin)) {
        const abs = join(ROOT, "packages", dir, rel)
        if (!existsSync(abs)) {
          throw new Error(`${pkg.name}: bin ${binName} missing at ${rel}`)
        }
        const text = readFileSync(abs, "utf8")
        if (text.includes("../src/") || text.includes("/src/index.ts")) {
          throw new Error(
            `${pkg.name}: bin ${binName} imports src/ — published tarball only ships dist/`,
          )
        }
        if (!text.startsWith("#!/usr/bin/env bun")) {
          throw new Error(`${pkg.name}: bin ${binName} must use bun shebang`)
        }
      }
    }
  }

  for (const dir of PACKAGES) {
    const pkg = readPkg(dir)
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@opencode-compat/")) continue
      const depDir = PACKAGES.find((d) => readPkg(d).name === dep)
      if (!depDir) throw new Error(`${pkg.name}: unknown workspace dep ${dep}`)
    }
  }

  console.log(`publish-ready: ${PACKAGES.length} public packages @ ${version}`)
  return version
}

function packedTarballName(pkg: PkgJson): string {
  // Bun names scoped packs: @opencode-compat/profile → opencode-compat-profile-0.1.0.tgz
  const bare = pkg.name.startsWith("@")
    ? pkg.name.slice(1).replace("/", "-")
    : pkg.name
  return `${bare}-${pkg.version}.tgz`
}

function registryHasVersion(name: string, version: string): boolean {
  const r = run("npm", ["view", `${name}@${version}`, "version"])
  return r.ok && r.stdout.trim() === version
}

function packAll(packDir: string, write: boolean): number {
  if (write) {
    rmSync(packDir, { recursive: true, force: true })
    mkdirSync(packDir, { recursive: true })
  }

  for (const dir of PACKAGES) {
    const pkg = readPkg(dir)
    const cwd = join(ROOT, "packages", dir)
    console.log(`→ pack ${pkg.name}@${pkg.version}`)
    const r = write
      ? run("bun", ["pm", "pack", "--destination", packDir], cwd)
      : run("bun", ["pm", "pack", "--dry-run"], cwd)
    if (!r.ok) {
      console.error(r.stderr || r.stdout)
      return r.status ?? 1
    }
    const lines = (r.stdout || r.stderr).trim().split("\n")
    console.log(`  ${lines[lines.length - 1] || "ok"}`)
  }
  return 0
}

function publishFromTarballs(
  packDir: string,
  opts: { oidc: boolean; skipExisting: boolean },
): number {
  if (!opts.oidc) {
    const who = run("npm", ["whoami"])
    if (!who.ok) {
      console.error("Not logged in to npm. Run: npm login")
      console.error(who.stderr || who.stdout)
      return 1
    }
    console.log(`npm user: ${who.stdout.trim()}`)
  } else {
    console.log("OIDC mode: skipping npm whoami (Trusted Publishing)")
  }

  for (const dir of PACKAGES) {
    const pkg = readPkg(dir)
    const tarball = join(packDir, packedTarballName(pkg))
    if (!existsSync(tarball)) {
      console.error(`Missing tarball ${tarball}`)
      console.error(
        `Present: ${existsSync(packDir) ? readdirSync(packDir).join(", ") : "(no pack dir)"}`,
      )
      return 1
    }

    if (opts.skipExisting && registryHasVersion(pkg.name, pkg.version)) {
      console.log(`→ skip ${pkg.name}@${pkg.version} (already on registry)`)
      continue
    }

    console.log(`→ publish ${pkg.name}@${pkg.version} (public)`)
    const args = [
      "publish",
      tarball,
      "--access",
      "public",
    ]
    // Provenance: automatic with Trusted Publishing; explicit in OIDC CI.
    if (opts.oidc) args.push("--provenance")

    const r = run("npm", args, ROOT, { inheritStdio: true })
    if (!r.ok) {
      if (r.stderr || r.stdout) console.error(r.stderr || r.stdout)
      console.error(
        `Stopped at ${pkg.name}. Already-published packages were not unpublished.`,
      )
      console.error(
        "Resume with: bun scripts/publish.ts --publish --skip-existing",
      )
      console.error(
        "OTP/2FA: run in an interactive terminal, or use a granular automation token.",
      )
      return r.status ?? 1
    }
    console.log(`  published ${pkg.name}@${pkg.version}`)
  }

  console.log("All @opencode-compat/* packages published (public).")
  return 0
}

function main(): number {
  const args = process.argv.slice(2)
  const doPublish = args.includes("--publish")
  const writePack = args.includes("--pack") || doPublish
  const skipTests = args.includes("--skip-tests")
  const oidc =
    args.includes("--oidc") ||
    process.env.NPM_OIDC === "1" ||
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  const skipExisting = args.includes("--skip-existing")

  console.log("→ build")
  let r = run("bun", ["run", "build"])
  if (!r.ok) {
    console.error(r.stderr || r.stdout)
    return r.status ?? 1
  }

  if (!skipTests) {
    console.log("→ typecheck")
    r = run("bun", ["run", "typecheck"])
    if (!r.ok) {
      console.error(r.stderr || r.stdout)
      return r.status ?? 1
    }
    console.log("→ test")
    r = run("bun", ["test", "./test"])
    if (!r.ok) {
      console.error(r.stderr || r.stdout)
      return r.status ?? 1
    }
  }

  let version: string
  try {
    version = assertPublishReady()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    return 1
  }

  const packDir = join(ROOT, ".tmp", "npm-pack")
  const packStatus = packAll(packDir, writePack)
  if (packStatus !== 0) return packStatus

  if (!doPublish) {
    console.log(
      [
        "",
        "Dry-run complete (public packages).",
        "First-time publishing: see docs/guides/npm-publish.md",
        "  bun run publish:npm",
        "Later (after Trusted Publisher): push tag v" + version,
        "",
        "Consumers:",
        "  bun add -g @opencode-compat/ocp",
        "  ocp setup --host mimo",
      ].join("\n"),
    )
    return 0
  }

  return publishFromTarballs(packDir, { oidc, skipExisting })
}

if (import.meta.main) {
  process.exit(main())
}