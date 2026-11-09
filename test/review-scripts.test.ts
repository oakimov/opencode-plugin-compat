import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Each case spawns Python, Bash or Git several times; Bun's 5 s default fails
// under ordinary machine load, unevenly across cases.
setDefaultTimeout(30_000)

const root = path.resolve(import.meta.dir, "..")
const secret = "review_" + "testsecretvalue"

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), PYTHONDONTWRITEBYTECODE: "1" },
    input: options.input,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function without(names: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  for (const name of names) delete env[name]
  return env
}

function hostKernel(): string {
  return spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim()
}

function selectedPython(): string {
  const result = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" })
  const found = (result.stdout || "").trim()
  if (result.status !== 0 || !found.startsWith("/")) throw new Error(result.stderr || "python3 is required")
  return found
}

function bashHere(script: string, env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  return run("bash", ["-c", script], { env })
}

describe("cloud agent install", () => {
  it("matches the environment install string", () => {
    const script = fs.readFileSync(path.join(root, "scripts/cloud-agent-install.sh"), "utf8")
    // A checkout may keep this tracked file out of its working tree (skip-worktree),
    // so Cursor does not apply it locally; compare the tracked copy then.
    const environmentFile = path.join(root, ".cursor/environment.json")
    const environmentText = fs.existsSync(environmentFile)
      ? fs.readFileSync(environmentFile, "utf8")
      : spawnSync("git", ["show", ":.cursor/environment.json"], { cwd: root, encoding: "utf8" }).stdout
    const environment = JSON.parse(environmentText) as {
      install: string
    }
    expect(environment.install).toBe(script)
    expect(environment.install).toContain("https://bun.sh/install")
    expect(environment.install).toContain("bun install --frozen-lockfile")
    expect(environment.install).toContain("bun run build")
    expect(environment.install).toContain("packages/*/dist/*.js")
    expect(environment.install).toContain("zsh")
    expect(environment.install).toContain("python3")
    expect(environment.install).toContain("openssl")
    expect(environment.install).not.toContain("opencode.ai")
    expect(environment.install).not.toContain("opencode1")
    expect(environment.install).not.toContain("opencode2")
    expect(environment.install).not.toContain("OPENCODE")
    expect(environment.install).not.toContain("scripts/cloud-agent-install.sh")
    expect(environment.install).not.toContain("scripts/configure-opencode.sh")
    expect(environment.install).not.toContain("opencode.json")
    expect(script).not.toContain("<<'PY'")
  })

  it("does not install when sourced", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-source-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho called > \"$HOME/curl-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "curl"), 0o755)
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/cloud-agent-install.sh
        declare -F install_main >/dev/null
        printf 'sourced\n'
        `,
        { HOME: directory, PATH: `${bin}:/usr/bin:/bin` },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("sourced\n")
      expect(fs.existsSync(path.join(directory, "curl-called"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("stops when the Bun installer cannot be downloaded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-fail-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho called > \"$HOME/curl-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "curl"), 0o755)
    try {
      const result = run("bash", ["scripts/cloud-agent-install.sh"], {
        env: without([], { HOME: directory, PATH: `${bin}:/usr/bin:/bin` }),
      })
      expect(result.status).not.toBe(0)
      expect(fs.readFileSync(path.join(directory, "curl-called"), "utf8")).toContain("called")
      expect(fs.existsSync(path.join(directory, ".bun"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("installs workspace deps, builds, and verifies package dist", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-ok-"))
    const bin = path.join(directory, "bin")
    const bunBin = path.join(directory, ".bun", "bin")
    const localBin = path.join(directory, "local", "bin")
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(bin)
    fs.mkdirSync(bunBin, { recursive: true })
    fs.mkdirSync(localBin, { recursive: true })
    fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true })
    // Redirect the absolute Cloud Agent bun path into the private home so the
    // test never writes under the real /usr/local/bin.
    const script = fs
      .readFileSync(path.join(root, "scripts/cloud-agent-install.sh"), "utf8")
      .replaceAll("/usr/local/bin/bun", `${localBin}/bun`)
    fs.writeFileSync(path.join(workspace, "scripts/cloud-agent-install.sh"), script)
    fs.writeFileSync(
      path.join(bunBin, "bun"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/bun.log"
if [ "$1" = "--version" ]; then
  echo '1.2.3'
  exit 0
fi
if [ "$1" = "install" ]; then
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p "$(pwd)/packages/profile/dist"
  printf 'export {}\n' > "$(pwd)/packages/profile/dist/index.js"
  exit 0
fi
echo "unexpected bun $*" >&2
exit 1
`,
    )
    fs.chmodSync(path.join(bunBin, "bun"), 0o755)
    fs.writeFileSync(
      path.join(bin, "sudo"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/sudo.log"
if [ "$1" = "ln" ]; then
  shift
  exec ln "$@"
fi
exit 0
`,
    )
    fs.chmodSync(path.join(bin, "sudo"), 0o755)
    for (const tool of ["zsh", "python3", "openssl"]) {
      fs.writeFileSync(path.join(bin, tool), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(bin, tool), 0o755)
    }
    try {
      const result = run("bash", [path.join(workspace, "scripts/cloud-agent-install.sh")], {
        env: without([], {
          HOME: directory,
          PATH: `${bin}:${localBin}:/usr/bin:/bin`,
        }),
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("Bun 1.2.3")
      expect(fs.readFileSync(path.join(directory, "bun.log"), "utf8")).toContain("install --frozen-lockfile")
      expect(fs.readFileSync(path.join(directory, "bun.log"), "utf8")).toContain("run build")
      expect(fs.existsSync(path.join(workspace, "packages/profile/dist/index.js"))).toBe(true)
      expect(fs.readFileSync(path.join(directory, "sudo.log"), "utf8")).toContain("ln -sf")
      expect(fs.existsSync(path.join(localBin, "bun"))).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("stops when packages/*/dist is missing after build", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "install-nodist-"))
    const bin = path.join(directory, "bin")
    const bunBin = path.join(directory, ".bun", "bin")
    const localBin = path.join(directory, "local", "bin")
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(bin)
    fs.mkdirSync(bunBin, { recursive: true })
    fs.mkdirSync(localBin, { recursive: true })
    fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true })
    const script = fs
      .readFileSync(path.join(root, "scripts/cloud-agent-install.sh"), "utf8")
      .replaceAll("/usr/local/bin/bun", `${localBin}/bun`)
    fs.writeFileSync(path.join(workspace, "scripts/cloud-agent-install.sh"), script)
    fs.writeFileSync(
      path.join(bunBin, "bun"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.3'; exit 0; fi
exit 0
`,
    )
    fs.chmodSync(path.join(bunBin, "bun"), 0o755)
    fs.writeFileSync(
      path.join(bin, "sudo"),
      `#!/bin/sh
if [ "$1" = "ln" ]; then shift; exec ln "$@"; fi
exit 0
`,
    )
    fs.chmodSync(path.join(bin, "sudo"), 0o755)
    for (const tool of ["zsh", "python3", "openssl"]) {
      fs.writeFileSync(path.join(bin, tool), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(bin, tool), 0o755)
    }
    try {
      const result = run("bash", [path.join(workspace, "scripts/cloud-agent-install.sh")], {
        env: without([], {
          HOME: directory,
          PATH: `${bin}:${localBin}:/usr/bin:/bin`,
        }),
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Missing packages/*/dist after build.")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("isolated check", () => {
  it("rejects missing, injected, non-GitHub, and --live targets before git runs", () => {
    expect(run("bash", ["scripts/isolated-check.sh"]).status).toBe(2)
    const live = run("bash", ["scripts/isolated-check.sh", "--live"])
    expect(live.status).toBe(2)
    expect(live.stderr).toContain("no --live")
    expect(live.stderr).toContain("Usage:")
    const liveAfter = run("bash", ["scripts/isolated-check.sh", "12", "--live"])
    expect(liveAfter.status).toBe(2)
    expect(liveAfter.stderr).toContain("no --live")
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-git-"))
    const bin = path.join(directory, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho called > \"$HOME/git-called\"\nexit 1\n")
    fs.chmodSync(path.join(bin, "git"), 0o755)
    try {
      const env = without([], { HOME: directory, PATH: `${bin}:/usr/bin:/bin` })
      for (const target of ["12;rm -rf /", "https://evil.example/pull/1", "https://github.com/a/b/commit/1", "--local"]) {
        const result = run("bash", ["scripts/isolated-check.sh", target], { env })
        expect(result.status, target).toBe(2)
      }
      expect(fs.existsSync(path.join(directory, "git-called"))).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("parses a pull number and a canonical pull URL", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-origin-"))
    try {
      expect(run("git", ["init", "--quiet", directory]).status).toBe(0)
      expect(
        run("git", ["-C", directory, "remote", "add", "origin", "https://github.com/oakimov/opencode-plugin-compat.git"])
          .status,
      ).toBe(0)
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/isolated-check.sh
        [[ -f "$ROOT/scripts/isolated-check.sh" ]]
        ROOT="$FIXTURE_REPOSITORY"
        show() {
          if check_parse_target "$1"; then printf 'ok %s\\n' "$pr"; else printf 'bad\\n'; fi
        }
        show 156
        show '12;rm -rf /'
        show 'https://github.com/oakimov/opencode-plugin-compat/pull/156'
        show 'https://github.com/oakimov/opencode-plugin-compat/pull/156/files'
        show 'https://github.com/oakimov/opencode-plugin-compat/pull/156?w=1'
        show 'https://github.com/unrelated/project/pull/156'
        show 'https://evil.example/pull/1'
        show --local
      `,
        { ...process.env, FIXTURE_REPOSITORY: directory },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain("x-access-token")
      expect(result.stdout).toBe(
        ["ok 156", "bad", "ok 156", "ok 156", "ok 156", "bad", "bad", "bad"].join("\n") + "\n",
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not fetch when the pull URL names a different repository", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-foreign-"))
    const log = path.join(directory, "git.log")
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *"remote get-url"* ]]; then
            printf '%s\\n' "https://x-access-token:supersecret@github.com/oakimov/opencode-plugin-compat"
            return 0
          fi
          if [[ "$*" == *fetch* ]]; then
            printf 'FETCHED\\n' >> "$LOG"
            return 0
          fi
          echo "unexpected git $*" >&2
          return 1
        }
        check_main "https://github.com/unrelated/project/pull/156"
        `,
        { LOG: log },
      )
      expect(result.status).toBe(2)
      expect(`${result.stdout}${result.stderr}`).toContain("Refusing unrelated/project")
      expect(`${result.stdout}${result.stderr}`).not.toContain("supersecret")
      expect(fs.readFileSync(log, "utf8")).not.toContain("FETCHED")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("places a tool linked from outside /usr/bin on the boundary PATH", () => {
    // macOS's default temp directory is a symlink; the tool file is reported resolved.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-tool-link-"))
    const src = path.join(directory, "src")
    const bin = path.join(directory, "bin")
    const hidden = path.join(directory, "hidden")
    const real = path.join(hidden, "tool-real")
    const secretFile = path.join(hidden, "secret")
    fs.mkdirSync(src)
    fs.mkdirSync(bin)
    fs.mkdirSync(hidden)
    fs.writeFileSync(real, "#!/bin/sh\necho tool-ok\n")
    fs.chmodSync(real, 0o755)
    fs.writeFileSync(secretFile, "SECRET\n", { mode: 0o600 })
    fs.symlinkSync(real, path.join(bin, "mytool"))
    const env = { PATH: `${bin}:/usr/bin:/bin` }
    try {
      const decision = bashHere(
        `
        set -euo pipefail
        source scripts/isolate-run.sh
        if isolate_tool_file true; then echo 'true-mounted'; else echo 'true-visible'; fi
        isolate_tool_file mytool
      `,
        env,
      )
      expect(decision.status, decision.stderr).toBe(0)
      expect(decision.stdout).toBe(`true-visible\n${fs.realpathSync(real)}\n`)
      if (hostKernel() !== "Linux") return
      const ran = run(
        "bash",
        [
          "scripts/isolate-run.sh",
          "--src",
          src,
          "--tool",
          "mytool",
          "--",
          "/bin/sh",
          "-c",
          'printf "where=%s\\n" "$(command -v mytool)"; mytool; if ls "$1" >/dev/null 2>&1; then echo LEAK; else echo hidden; fi',
          "sh",
          hidden,
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` } },
      )
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
      expect(ran.stdout).toContain("where=/opt/tools/mytool")
      expect(ran.stdout).toContain("tool-ok")
      expect(ran.stdout).toContain("hidden")
      expect(ran.stdout).not.toContain("SECRET")
      expect(ran.stdout).not.toContain("LEAK")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("runs a native runtime binary without exposing its install directory", () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "review-native-runtime-"))
    const src = path.join(directory, "src")
    const bin = path.join(directory, "bin")
    const homeInstall = path.join(directory, "private-install")
    fs.mkdirSync(src)
    fs.mkdirSync(bin)
    fs.mkdirSync(homeInstall)
    const native = path.join(homeInstall, "runtime")
    fs.copyFileSync(process.execPath, native)
    fs.chmodSync(native, 0o755)
    fs.symlinkSync(native, path.join(bin, "mytool"))
    try {
      const ran = run(
        "bash",
        [
          "scripts/isolate-run.sh",
          "--src",
          src,
          "--tool",
          "mytool",
          "--",
          "/bin/sh",
          "-c",
          'printf "where=%s\\n" "$(command -v mytool)"; mytool --version; if ls "$1" >/dev/null 2>&1; then echo LEAK; else echo hidden; fi',
          "sh",
          homeInstall,
        ],
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` } },
      )
      if (ran.status === 2 && /ISOLATION=unavailable/.test(ran.stderr)) return
      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
      if (hostKernel() === "Linux") expect(ran.stdout).toContain("where=/opt/tools/mytool")
      else expect(ran.stdout).toMatch(/where=.+\/cursor-isolate-tools\.[^/]+\/mytool/)
      expect(ran.stdout).toContain("hidden")
      expect(ran.stdout).not.toContain("LEAK")
      expect(ran.stdout.trim().split("\n").some((line) => /\d+\.\d+/.test(line))).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("drops reviewer secrets and removes the sandbox on exit", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-isolate-src-"))
    const result = bashHere(
      `
      set -euo pipefail
      source scripts/isolated-check.sh
      trap check_cleanup EXIT
      check_begin_sandbox
      printf 'home %s\\n' "$isolate_home"
      ISOLATE_SRC="$SRC" check_run_isolated /bin/sh -c 'printf "KEY=%s\\nSECRET=%s\\nAPPKEY=%s\\nHOME=%s\\nTMP=%s\\n" "\${REVIEW_APP_ID-}" "\${SECRET_TOKEN-}" "\${REVIEW_APP_PRIVATE_KEY-}" "$HOME" "$TMPDIR"'
    `,
      {
        ...process.env,
        REVIEW_APP_ID: "app-123",
        SECRET_TOKEN: "super-secret",
        REVIEW_APP_PRIVATE_KEY: secret,
        SRC: src,
      },
    )
    fs.rmSync(src, { recursive: true, force: true })
    if (result.status === 2 && /ISOLATION=unavailable/.test(result.stderr)) return
    expect(result.status, result.stderr).toBe(0)
    const home = result.stdout.match(/^home (\S+)$/m)?.[1]
    expect(home).toBeTruthy()
    expect(result.stdout).toContain("KEY=")
    expect(result.stdout).not.toContain("app-123")
    expect(result.stdout).not.toContain("super-secret")
    expect(result.stdout).not.toContain(secret)
    expect(result.stdout).toContain("APPKEY=")
    if (hostKernel() === "Linux") {
      expect(result.stdout).toContain("HOME=/home/reviewer")
      expect(result.stdout).toContain("TMP=/tmp")
    } else {
      expect(result.stdout).toContain("HOME=")
      expect(result.stdout).not.toContain(`HOME=${process.env.HOME}`)
      expect(result.stdout).not.toContain("HOME=/home/reviewer")
    }
    expect(fs.existsSync(home!)).toBe(false)
  })

  it("does not archive a commit other than the trusted one", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-trust-"))
    const log = path.join(directory, "git.log")
    const trusted = "a".repeat(40)
    const fetched = "b".repeat(40)
    try {
      const mismatch = bashHere(
        `
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *fetch* ]]; then return 0; fi
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$FETCHED"; return 0; fi
          if [[ "$*" == *archive* ]]; then printf 'ARCHIVED\\n' >> "$LOG"; return 0; fi
          echo "unexpected git $*" >&2
          return 1
        }
        tar() { printf 'TAR\\n' >> "$LOG"; }
        check_main 156
      `,
        { LOG: log, FETCHED: fetched, CURSOR_REVIEW_TRUST_SHA: trusted },
      )
      expect(mismatch.status).toBe(2)
      expect(mismatch.stderr).toContain(`Fetched ${fetched}, not the trusted ${trusted}`)
      expect(mismatch.stdout).toContain(`Check commit: ${fetched}`)
      const trace = fs.readFileSync(log, "utf8")
      expect(trace).not.toContain("ARCHIVED")
      expect(trace).not.toContain("TAR")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("archives the captured commit when FETCH_HEAD moves during archive", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-archive-sha-"))
    const log = path.join(directory, "git.log")
    const archiveArg = path.join(directory, "archive-arg")
    const trusted = "a".repeat(40)
    const other = "b".repeat(40)
    try {
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/isolated-check.sh
        git() {
          printf '%s\\n' "$*" >> "$LOG"
          if [[ "$*" == *fetch* ]]; then return 0; fi
          if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$TRUSTED"; return 0; fi
          if [[ "$*" == *archive* ]]; then
            printf '%s\\n' "\${@: -1}" > "$ARCHIVE_ARG"
            return 0
          fi
          echo "unexpected git $*" >&2
          return 1
        }
        tar() {
          local dest=""
          while [[ "$#" -gt 0 ]]; do
            if [[ "$1" == -C ]]; then dest="$2"; shift 2; continue; fi
            shift
          done
          [[ -n "$dest" ]]
          local obj
          obj="$(cat "$ARCHIVE_ARG")"
          if [[ "$obj" == FETCH_HEAD ]]; then obj="$OTHER"; fi
          printf '%s\\n' "$obj" > "$dest/REV"
        }
        check_step() { echo "\${1}=passed"; return 0; }
        check_main 156
      `,
        {
          LOG: log,
          ARCHIVE_ARG: archiveArg,
          TRUSTED: trusted,
          OTHER: other,
          CURSOR_REVIEW_TRUST_SHA: trusted,
          PATH: "/usr/bin:/bin",
        },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(`Check commit: ${trusted}`)
      expect(result.stdout).toContain("CHECK_SUMMARY pr=156 checks=0")
      expect(fs.readFileSync(archiveArg, "utf8").trim()).toBe(trusted)
      expect(fs.readFileSync(log, "utf8")).not.toContain("archive FETCH_HEAD")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("translates darwin virtual paths and does not allow every file read", () => {
    // On macOS the default temp directory is a symlink into /private. Seatbelt
    // matches resolved paths, so the profile must name them, never the link.
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "review-darwin-"))
    const directory = fs.realpathSync(linked)
    const src = path.join(directory, "src")
    const harness = path.join(directory, "harness")
    const secretDir = path.join(directory, "secret-dir")
    const toolDir = path.join(directory, "cellar", "tool", "1", "bin")
    try {
      fs.mkdirSync(src)
      fs.mkdirSync(harness)
      fs.mkdirSync(secretDir)
      const toolRoot = path.join(directory, "cellar", "tool", "1")
      const outsideBin = path.join(directory, "outside", "bin")
      fs.mkdirSync(path.join(toolRoot, "lib"), { recursive: true })
      fs.mkdirSync(toolDir, { recursive: true })
      fs.mkdirSync(outsideBin, { recursive: true })
      fs.writeFileSync(path.join(toolDir, "mytool"), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(toolDir, "mytool"), 0o755)
      fs.writeFileSync(path.join(toolRoot, "credential"), "SECRET\n", { mode: 0o600 })
      fs.writeFileSync(path.join(outsideBin, "other"), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(outsideBin, "other"), 0o755)
      fs.writeFileSync(path.join(directory, "outside", "secret"), "SECRET\n", { mode: 0o600 })
      fs.symlinkSync(path.join(outsideBin, "other"), path.join(toolDir, "other"))
      const result = bashHere(
        `
        set -euo pipefail
        source scripts/isolate-run.sh
        darwin_home=""
        darwin_tmp=""
        darwin_tools=""
        darwin_profile=""
        cleanup() {
          [[ -z "$darwin_home" ]] || rm -rf "$darwin_home"
          [[ -z "$darwin_tmp" ]] || rm -rf "$darwin_tmp"
          [[ -z "$darwin_tools" ]] || rm -rf "$darwin_tools"
          [[ -z "$darwin_profile" ]] || rm -f "$darwin_profile"
        }
        trap cleanup EXIT
        src="$SRC"
        tools=(mytool other)
        ro_binds=("$HARNESS:/opt/harness")
        env_names=()
        set_pairs=("CHECK_ROOT=/src" "REVIEW_HOME=/tmp/review-home")
        command=(bash /opt/harness/scripts/isolated-check.sh /src/file.txt)
        isolate_darwin_prepare "$src"
        printf 'TOOLS=%s\\n' "$darwin_tools"
        echo '---PROFILE---'
        cat "$darwin_profile"
        echo '---COMMAND---'
        n="$(isolate_count darwin_command)"
        i=0
        while [[ "$i" -lt "$n" ]]; do
          isolate_at darwin_command "$i"
          printf '\\n'
          i=$((i + 1))
        done
        echo '---TRANSLATED---'
        isolate_translate /src
        printf '\\n'
        isolate_translate /tmp/review-home
        printf '\\n'
        echo '---LINK---'
        readlink "$darwin_tools/mytool"
      `,
        {
          SRC: path.join(linked, "src"),
          HARNESS: path.join(linked, "harness"),
          PATH: `${path.join(linked, "cellar", "tool", "1", "bin")}:/usr/bin:/bin`,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      const profile = result.stdout.split("---PROFILE---\n")[1]?.split("---COMMAND---\n")[0] ?? ""
      if (linked !== directory) expect(profile).not.toContain(`"${linked}`)
      for (const scratch of ["home", "tmp", "tools"]) {
        const rule = profile.match(new RegExp(`"([^"]*/cursor-isolate-${scratch}\\.[^"/]+)"`))?.[1]
        expect(rule, scratch).toBeDefined()
        expect(fs.realpathSync.native(path.dirname(rule!))).toBe(path.dirname(rule!))
      }
      expect(profile).toContain('(allow file-write*\n  (literal "/dev/null")\n')
      const command =
        result.stdout.split("---COMMAND---\n")[1]?.split("---TRANSLATED---\n")[0]?.trim().split("\n") ?? []
      const translated = result.stdout.split("---TRANSLATED---\n")[1]?.trim().split("\n") ?? []
      expect(profile.split("\n")).not.toContain("(allow file-read*)")
      expect(profile).toContain('(literal "/")')
      expect(profile).not.toContain('(subpath "/")')
      expect(profile).toContain("(allow file-map-executable")
      expect(profile).toContain("/System/Volumes/Preboot/Cryptexes/OS")
      expect(profile).toContain("/private/var/db/dyld")
      expect(profile).toContain("/private/etc")
      expect(profile).toContain(harness)
      expect(profile).not.toContain(secretDir)
      const write = profile.split("(allow file-write*")[1] ?? ""
      expect(write).toContain(src)
      expect(write).not.toContain(harness)
      expect(command).toEqual(["bash", path.join(harness, "scripts/isolated-check.sh"), path.join(src, "file.txt")])
      expect(translated[0]).toBe(src)
      expect(translated[1]).toMatch(/\/review-home$/)
      expect(result.stdout.split("---LINK---\n")[1]?.trim()).toBe(path.join(toolDir, "mytool"))
      const toolFile = path.join(toolDir, "mytool")
      const otherFile = path.join(outsideBin, "other")
      expect(profile).toContain(`(literal "${toolFile}")`)
      expect(profile).toContain(`(literal "${otherFile}")`)
      expect(profile).not.toContain(`(subpath "${toolRoot}")`)
      expect(profile).not.toContain(`(subpath "${toolDir}")`)
      expect(profile).not.toContain(`(subpath "${path.join(toolRoot, "lib")}")`)
      expect(profile).not.toContain(`(subpath "${path.join(directory, "outside")}")`)
      expect(profile).not.toContain(path.join(toolRoot, "credential"))
      expect(profile).not.toContain(path.join(directory, "outside", "secret"))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("allows only the root directory inode and the selected tool file", () => {
    // The default temp directory is a symlink on macOS; rules name the resolved file.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-darwin-root-"))
    const src = path.join(directory, "src")
    const prefix = path.join(directory, "private-prefix")
    const bin = path.join(prefix, "bin")
    const sentinel = path.join(prefix, "credential")
    const tool = path.join(bin, "mytool")
    fs.mkdirSync(src)
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(tool, 0o755)
    fs.writeFileSync(sentinel, "SECRET\n", { mode: 0o600 })
    const script = `
      set -euo pipefail
      source scripts/isolate-run.sh
      darwin_home=""
      darwin_tmp=""
      darwin_tools=""
      darwin_profile=""
      cleanup() {
        [[ -z "$darwin_home" ]] || rm -rf "$darwin_home"
        [[ -z "$darwin_tmp" ]] || rm -rf "$darwin_tmp"
        [[ -z "$darwin_tools" ]] || rm -rf "$darwin_tools"
        [[ -z "$darwin_profile" ]] || rm -f "$darwin_profile"
      }
      trap cleanup EXIT
      src="$SRC"
      tools=(mytool)
      ro_binds=()
      env_names=()
      set_pairs=()
      command=(/usr/bin/true)
      isolate_darwin_prepare "$src"
      cat "$darwin_profile"
    `
    try {
      for (const shell of ["bash", "/bin/bash"]) {
        const result = run(shell, ["-c", script], { env: { SRC: src, PATH: `${bin}:/usr/bin:/bin` } })
        expect(result.status, `${shell}\n${result.stderr}`).toBe(0)
        expect(result.stdout).toContain('(literal "/")')
        expect(result.stdout).not.toContain('(subpath "/")')
        expect(result.stdout.split("\n")).not.toContain("(allow file-read*)")
        expect(result.stdout).toContain(`(literal "${fs.realpathSync(tool)}")`)
        for (const hidden of [prefix, bin, fs.realpathSync(prefix), fs.realpathSync(bin)]) {
          expect(result.stdout).not.toContain(`(subpath "${hidden}")`)
        }
        expect(result.stdout).not.toContain(sentinel)
        expect(result.stdout).not.toContain(fs.realpathSync(sentinel))
      }
      if (hostKernel() === "Darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
        for (const shell of ["bash", "/bin/bash"]) {
          for (const args of [["/usr/bin/true"], ["/bin/echo", "ok"], ["/bin/bash", "-c", "exit 0"]]) {
            const ran = run(shell, ["scripts/isolate-run.sh", "--src", src, "--tool", "mytool", "--", ...args], {
              env: { PATH: `${bin}:/usr/bin:/bin` },
            })
            expect(ran.status, `${shell} ${args.join(" ")}\n${ran.stderr}`).toBe(0)
          }
        }
        const leaked = run("bash", ["scripts/isolate-run.sh", "--src", src, "--tool", "mytool", "--", "/bin/cat", sentinel], {
          env: { PATH: `${bin}:/usr/bin:/bin` },
        })
        expect(leaked.status).not.toBe(0)
        expect(leaked.stdout).not.toContain("SECRET")
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("hides host files and refuses to modify the trusted harness", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-boundary-"))
    const src = path.join(directory, "src")
    const secretFile = path.join(directory, "sentinel")
    const harness = path.join(directory, "harness.txt")
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(src, "file.txt"), "hello\n")
    fs.writeFileSync(secretFile, "TOPSECRET\n", { mode: 0o600 })
    fs.writeFileSync(harness, "CANARY\n")
    fs.symlinkSync(secretFile, path.join(src, "escape"))
    fs.writeFileSync(path.join(directory, "parent-secret"), "PARENTSECRET\n")
    fs.symlinkSync("../parent-secret", path.join(src, "rel"))
    const probe = path.join(src, "probe.py")
    fs.writeFileSync(
      probe,
      `import pathlib, sys
secret, harness, socket = sys.argv[1:]
print("SRC="+pathlib.Path("/src/file.txt").read_text().strip())
def attempt(label, fn):
    try:
        print(label + "=" + fn())
    except Exception as error:
        print(label + "_ERR=" + type(error).__name__)
attempt("SECRET", lambda: pathlib.Path(secret).read_text())
attempt("ESCAPE", lambda: pathlib.Path("/src/escape").read_text())
attempt("REL", lambda: pathlib.Path("/src/rel").read_text())
attempt("HARNESS", lambda: pathlib.Path(harness).write_text("PWNED\\n") or "ok")
attempt("RO", lambda: pathlib.Path("/opt/harness/harness.txt").write_text("PWNED\\n") or "ok")
import subprocess
pathlib.Path("/src/copied").mkdir(exist_ok=True)
remount = subprocess.run(["mount", "-o", "remount,bind,rw", "/opt/harness"], capture_output=True, text=True)
print("REMOUNT=" + str(remount.returncode))
copied = subprocess.run(["mount", "--bind", "/opt/harness", "/src/copied"], capture_output=True, text=True)
print("REMOUNT_BIND=" + str(copied.returncode))
attempt("REMOUNT_WRITE", lambda: pathlib.Path("/opt/harness/harness.txt").write_text("PWNED\\n") or "ok")
for line in pathlib.Path("/proc/self/status").read_text().splitlines():
    if line.startswith(("CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:", "NoNewPrivs:")):
        print(line.replace("\\t", " "))
pathlib.Path("/src/owned.txt").write_text("ok\\n")
print("OWNED=ok")
print("WORKSPACE=" + str(pathlib.Path("/workspace").exists()))
print("GIT=" + str(pathlib.Path("/src/.git").exists()))
print("SOCKET=" + str(pathlib.Path(socket).exists()))
`,
    )
    const socket = path.join(directory, "agent.sock")
    const bound = spawnSync(selectedPython(), ["-c", "import socket,sys\ns=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", socket])
    expect(bound.status).toBe(0)
    const marker = `isolate-host-only-${process.pid}`
    let sleeper: ReturnType<typeof spawn> | undefined
    try {
      const result = run(
        "bash",
        [
          "scripts/isolate-run.sh",
          "--src",
          src,
          "--ro-bind",
          `${directory}:/opt/harness`,
          "--",
          "python3",
          "/src/probe.py",
          secretFile,
          harness,
          socket,
        ],
        { env: { ...process.env, REVIEW_APP_PRIVATE_KEY: secret } },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("SRC=hello")
      expect(result.stdout).toContain("SECRET_ERR=FileNotFoundError")
      expect(result.stdout).toContain("ESCAPE_ERR=FileNotFoundError")
      expect(result.stdout).toContain("REL_ERR=FileNotFoundError")
      expect(result.stdout).toContain("HARNESS_ERR=FileNotFoundError")
      expect(result.stdout).toContain("RO_ERR=")
      expect(result.stdout).toMatch(/REMOUNT=[1-9]/)
      expect(result.stdout).toMatch(/REMOUNT_BIND=[1-9]/)
      expect(result.stdout).toContain("REMOUNT_WRITE_ERR=")
      for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
        expect(result.stdout).toContain(`${set}: 0000000000000000`)
      }
      expect(result.stdout).toContain("NoNewPrivs: 1")
      expect(result.stdout).toContain("OWNED=ok")
      expect(result.stdout).toContain("WORKSPACE=False")
      expect(result.stdout).toContain("GIT=False")
      expect(result.stdout).toContain("SOCKET=False")
      expect(result.stdout).not.toContain(secret)
      expect(result.stdout).not.toContain("TOPSECRET")
      expect(fs.readFileSync(harness, "utf8")).toBe("CANARY\n")
      sleeper = spawn("bash", ["-c", `exec -a ${marker} sleep 30`], { detached: true, stdio: "ignore" })
      sleeper.unref()
      const seen = spawnSync("bash", ["-c", `ps -A -o args= | grep -F ${JSON.stringify(marker)} || true`], {
        encoding: "utf8",
      })
      expect(seen.stdout).toContain(marker)
      fs.writeFileSync(
        path.join(src, "scan.py"),
        `import os, pathlib
marker = os.environ["MARKER"]
found = False
for child in pathlib.Path("/proc").iterdir():
    if not child.name.isdigit():
        continue
    try:
        raw = (child / "cmdline").read_bytes().decode("utf-8", "replace")
    except Exception:
        continue
    if marker in raw:
        found = True
print("SAW=" + str(found))
`,
      )
      const inside = run("bash", [
        "scripts/isolate-run.sh",
        "--src",
        src,
        "--set",
        `MARKER=${marker}`,
        "--",
        "python3",
        "/src/scan.py",
      ])
      expect(inside.status, inside.stderr).toBe(0)
      expect(inside.stdout).toContain("SAW=False")
    } finally {
      if (sleeper?.pid) spawnSync("kill", ["-KILL", String(sleeper.pid)])
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails closed when the isolation mechanism is unavailable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-no-unshare-"))
    const bin = path.join(directory, "bin")
    const src = path.join(directory, "src")
    const marker = path.join(directory, "ran")
    fs.mkdirSync(bin)
    fs.mkdirSync(src)
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho Linux\n")
    fs.writeFileSync(path.join(bin, "unshare"), "#!/bin/sh\nexit 1\n")
    fs.chmodSync(path.join(bin, "uname"), 0o755)
    fs.chmodSync(path.join(bin, "unshare"), 0o755)
    try {
      const result = run(
        "bash",
        ["scripts/isolate-run.sh", "--src", src, "--", "python3", "-c", `open(${JSON.stringify(marker)},"w").write("ran")`],
        { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } },
      )
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("ISOLATION=unavailable")
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("removes the worktree when the check exits early", () => {
    const result = bashHere(`
      set -euo pipefail
      source scripts/isolated-check.sh
      trap check_cleanup EXIT
      base_tmp=$(mktemp -d)
      export TMPDIR="$base_tmp"
      worktree=$(mktemp -d "$TMPDIR/ocp-pr-check-test.XXXXXX")
      printf '%s\\n' "$base_tmp"
      exit 1
    `)
    expect(result.status).toBe(1)
    const base = result.stdout.trim()
    expect(fs.readdirSync(base)).toEqual([])
    fs.rmSync(base, { recursive: true, force: true })
  })

  it("runs a command when no tools or environment names are passed", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-empty-arrays-"))
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "/usr/bin/true"])
      if (result.status === 2 && /ISOLATION=unavailable/.test(result.stderr)) return
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it("lets the command write its source, home, temp directory and /dev/null from the default temp root", () => {
    // os.tmpdir() is a symlink on macOS. A profile naming the link denied every
    // write and the working directory while the run still exited 0.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-writable-"))
    try {
      const result = run("bash", [
        "scripts/isolate-run.sh",
        "--src",
        src,
        "--",
        "/bin/sh",
        "-c",
        [
          'cd "$1"',
          "pwd -P >/dev/null",
          'echo source > "$1/written"',
          'echo home > "$HOME/written"',
          'echo temp > "$TMPDIR/written"',
          "echo discarded > /dev/null",
          "echo WROTE",
        ].join(" && "),
        "sh",
        "/src",
      ])
      if (result.status === 2 && /ISOLATION=unavailable/.test(result.stderr)) return
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toBe("WROTE\n")
      expect(fs.readFileSync(path.join(src, "written"), "utf8")).toBe("source\n")
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("runs nested isolation with no capabilities and keeps ancestor binds read-only", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-nested-isolation-"))
    const src = path.join(directory, "src")
    const trusted = path.join(directory, "trusted")
    fs.mkdirSync(path.join(src, "inner"), { recursive: true })
    fs.mkdirSync(trusted)
    fs.writeFileSync(path.join(trusted, "canary"), "CANARY\n")
    fs.copyFileSync(path.join(root, "scripts/isolate-run.sh"), path.join(src, "isolate-run.sh"))
    const inner = `
import json, os, pathlib
status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
print(json.dumps({"uid":os.geteuid(), "gid":os.getegid(), "caps":{key:status[key].strip() for key in ("CapInh","CapPrm","CapEff","CapBnd","CapAmb")}, "nnp":status["NoNewPrivs"].strip()}))
`
    const attack = `
import pathlib, subprocess, sys
result = subprocess.run(["mount", "-o", "remount,bind,rw", "/opt/trusted"], capture_output=True)
if result.returncode == 0: sys.exit("ancestor bind remounted writable")
try:
    pathlib.Path("/opt/trusted/canary").write_text("CHANGED")
except OSError:
    print("ANCESTOR_READONLY")
else:
    sys.exit("ancestor bind changed")
`
    fs.writeFileSync(
      path.join(src, "probe.py"),
      `
import json, os, pathlib, subprocess, sys
${inner}
if "REVIEW_APP_PRIVATE_KEY" in os.environ: sys.exit("credential entered boundary")
# This raw child gets capabilities in its own namespace, but inherited
# read-only mounts must remain locked against remounting and writes.
subprocess.run(["unshare","--user","--map-root-user","--mount","--pid","--fork","--mount-proc","python3","-c",${JSON.stringify(attack)}], check=True)
subprocess.run(["bash","/src/isolate-run.sh","--src","/src/inner","--","python3","-c",${JSON.stringify(inner)}], check=True)
`,
    )
    try {
      const result = run(
        "bash",
        ["scripts/isolate-run.sh", "--src", src, "--ro-bind", `${trusted}:/opt/trusted`, "--", "python3", "/src/probe.py"],
        { env: { ...process.env, REVIEW_APP_PRIVATE_KEY: secret } },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const rows = result.stdout.split("\n").filter((line) => line.startsWith("{"))
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(JSON.parse(row)).toEqual({
          uid: 1000,
          gid: 1000,
          caps: Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((key) => [key, "0000000000000000"])),
          nnp: "1",
        })
      }
      expect(result.stdout).toContain("ANCESTOR_READONLY")
      expect(fs.readFileSync(path.join(trusted, "canary"), "utf8")).toBe("CANARY\n")
      expect(result.stdout).not.toContain(secret)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("retains locked nested bind mounts and makes each one read-only", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-nested-bind-"))
    fs.mkdirSync(path.join(directory, "src"))
    fs.mkdirSync(path.join(directory, "shared", "nested"), { recursive: true })
    fs.mkdirSync(path.join(directory, "data"))
    const data = path.join(directory, "data", "value")
    fs.writeFileSync(data, "preserved\n")
    try {
      const result = run("unshare", [
        "--user",
        "--map-root-user",
        "--mount",
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `
        set -euo pipefail
        mount --bind "$1/data" "$1/shared/nested"
        bash "$2/scripts/isolate-run.sh" --src "$1/src" --ro-bind "$1/shared:/opt/shared" -- python3 -c '
import pathlib, sys
target = pathlib.Path("/opt/shared/nested/value")
print(target.read_text().strip())
try:
    target.write_text("changed")
except OSError:
    print("READONLY")
else:
    sys.exit(4)
'
      `,
        "sh",
        directory,
        root,
      ])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toBe("preserved\nREADONLY\n")
      expect(fs.readFileSync(data, "utf8")).toBe("preserved\n")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("reaps an orphaned grandchild and returns the command status", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-reaper-"))
    fs.writeFileSync(
      path.join(src, "probe.py"),
      [
        "import os, sys, time",
        "if os.getpid() == 1 or os.getppid() != 1:",
        "    print('COMMAND_PID=%s PARENT=%s' % (os.getpid(), os.getppid()))",
        "    sys.exit(2)",
        "pid = os.fork()",
        "if pid == 0:",
        "    grand = os.fork()",
        "    if grand == 0:",
        "        os.execv('/bin/sleep', ['sleep', '30'])",
        "    os.kill(grand, 9)",
        "    open('/src/orphan', 'w').write(str(grand))",
        "    os._exit(0)",
        "os.waitpid(pid, 0)",
        "orphan = int(open('/src/orphan').read())",
        "deadline = time.time() + 2",
        "while time.time() < deadline:",
        "    try:",
        "        os.kill(orphan, 0)",
        "    except OSError:",
        "        print('ORPHAN_GONE')",
        "        sys.exit(0)",
        "    time.sleep(0.05)",
        "print('ORPHAN_ALIVE')",
        "sys.exit(3)",
        "",
      ].join("\n"),
    )
    try {
      const result = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "python3", "/src/probe.py"])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("ORPHAN_GONE")
      const status = run("bash", ["scripts/isolate-run.sh", "--src", src, "--", "python3", "-c", "import sys; sys.exit(7)"])
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(7)
    } finally {
      fs.rmSync(src, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "linux")("forwards termination to the command session", async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "review-reaper-signal-"))
    const ready = path.join(src, "ready")
    const child = spawn("bash", ["scripts/isolate-run.sh", "--src", src, "--", "sh", "-c", "echo $$ > /src/ready; exec sleep 30"], {
      cwd: root,
      detached: true,
    })
    const started = Date.now()
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50))
    const sleepAlive = (namespacePid: string) => {
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue
        try {
          const status = fs.readFileSync(`/proc/${name}/status`, "utf8")
          if (!status.startsWith("Name:\tsleep\n")) continue
          const nspid = status.split("\n").find((line) => line.startsWith("NSpid:"))
          if (nspid?.split(/\s+/).includes(namespacePid)) return true
        } catch {
          // The process exited while it was being read.
        }
      }
      return false
    }
    try {
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null || Date.now() - started > 8000) {
          throw new Error(`command did not start: exit=${child.exitCode}`)
        }
        await pause()
      }
      const namespacePid = fs.readFileSync(ready, "utf8").trim()
      expect(sleepAlive(namespacePid)).toBe(true)
      process.kill(-child.pid!, "SIGTERM")
      const killed = Date.now()
      while (sleepAlive(namespacePid)) {
        if (Date.now() - killed > 5000) throw new Error("sleep survived SIGTERM to the boundary")
        await pause()
      }
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() - killed > 5000) throw new Error("boundary did not exit after SIGTERM")
        await pause()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(src, { recursive: true, force: true })
    }
  })
})
