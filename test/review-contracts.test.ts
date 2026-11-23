/**
 * Trusted review contracts (scripts/review-*-contracts.mjs) and the
 * isolated-check gate that compares them with the pull request's merge base.
 * The contracts read the archived subject; the gate decides which failures
 * the pull request introduced. Nothing here contacts GitHub or a host.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const bun = process.execPath

function contract(script: string, subject: string) {
  return spawnSync(bun, [path.join(root, "scripts", script), subject], { encoding: "utf8", timeout: 60_000 })
}

function subjectTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-review-subject-"))
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n")
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  return dir
}

describe("trusted review contracts on this checkout", () => {
  beforeAll(() => {
    // The catalog contract reads built dist, as it does after BUILD in the boundary.
    if (!fs.existsSync(path.join(root, "packages/opencode-loader/dist/index.js"))) {
      const built = spawnSync("bunx", ["tsc", "-b", "packages/opencode-loader"], { cwd: root, encoding: "utf8" })
      expect(built.status, built.stderr).toBe(0)
    }
  })

  for (const [script, label] of [
    ["review-boundary-contracts.mjs", "BOUNDARY_CONTRACTS"],
    ["review-catalog-contracts.mjs", "CATALOG_CONTRACTS"],
  ] as const) {
    test(`${label} pass with a single completion record`, () => {
      const result = contract(script, root)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const lines = result.stdout.trim().split("\n")
      expect(result.stdout).not.toMatch(/:failed/)
      expect(lines.filter(line => line.includes(":skipped"))).toEqual([])
      const records = lines.filter(line => line.startsWith("REVIEW_CONTRACT_COMPLETE="))
      expect(records).toEqual([`REVIEW_CONTRACT_COMPLETE=${label}:passed`])
      expect(result.stdout.trim().split("\n").at(-1)).toBe(`REVIEW_CONTRACT_COMPLETE=${label}:passed`)
    })
  }
})

describe("trusted review contracts detect regressions", () => {
  test("boundary contract names each violated invariant and skips absent areas", () => {
    const dir = subjectTree({
      "packages/profile/package.json": JSON.stringify({ version: "9.9.9" }),
      "packages/adapter/src/host.ts": 'import { x } from "@oh-my-pi/pi-ai"\n',
      "packages/pi-bridge/package.json": JSON.stringify({ dependencies: { "@opencode-compat/opencode-loader": "workspace:*" } }),
      "packages/pi-bridge/src/bridge.ts": 'import { tools } from "./cursor-host-tools.js"\n',
      "packages/dsh-bridge/src/path-bridge.ts": "export const missingSymbol = true\n",
    })
    try {
      const result = contract("review-boundary-contracts.mjs", dir)
      expect(result.status).toBe(1)
      expect(result.stdout).toMatch(/^BOUNDARY_CONTRACT=clone-adapter-has-no-pi-dsh:failed file="packages\/adapter\/src\/host\.ts" fingerprint=[a-f0-9]{64} occurrence=1 line=1$/m)
      expect(result.stdout).toContain("BOUNDARY_CONTRACT=pi-generic-has-no-static-cursor:failed")
      expect(result.stdout).toContain('BOUNDARY_CONTRACT=pi-bridge-exact-train-pins:failed file="packages/pi-bridge/package.json" dependency="@opencode-compat/opencode-loader"')
      expect(result.stdout).toContain('BOUNDARY_CONTRACT=path-bridge-neutral-symbol:failed file="packages/dsh-bridge/src/path-bridge.ts"')
      expect(result.stdout).toContain("BOUNDARY_CONTRACT=dsh-bridge-exact-train-pins:skipped dsh-bridge or train version absent")
      expect(result.stdout.trim().split("\n").at(-1)).toBe("REVIEW_CONTRACT_COMPLETE=BOUNDARY_CONTRACTS:failed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("catalog contract rejects a loader that re-sorts the established prefix", () => {
    const dir = subjectTree({
      "packages/opencode-loader/dist/index.js": `
        export function createToolCatalogOrder() {
          return tools => [...(tools ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        }
      `,
    })
    try {
      const result = contract("review-catalog-contracts.mjs", dir)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("CATALOG_CONTRACT=first-catalog-sorted-by-code-unit:passed")
      expect(result.stdout).toContain("CATALOG_CONTRACT=newcomer-appended-not-resorted:failed got=a,z; want=z,a")
      expect(result.stdout).toContain("CATALOG_CONTRACT=equal-name-descriptor-frozen:failed")
      expect(result.stdout.trim().split("\n").at(-1)).toBe("REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:failed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("contracts skip, not fail, a subject that predates the area; a missing subject is unavailable", () => {
    const dir = subjectTree({})
    try {
      for (const [script, label] of [["review-boundary-contracts.mjs", "BOUNDARY"], ["review-catalog-contracts.mjs", "CATALOG"]] as const) {
        const result = contract(script, dir)
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(new RegExp(`^${label}_CONTRACT=[a-z-]+:skipped `, "m"))
      }
      expect(contract("review-boundary-contracts.mjs", path.join(dir, "missing")).status).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Runs the real check_main with the boundary replaced by `isolated`. */
function gate(isolated: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `
    set -euo pipefail
    source scripts/isolated-check.sh
    git() {
      case "$*" in
        *fetch*) return 0 ;;
        *rev-parse*) printf '%s\\n' "${"a".repeat(40)}" ;;
        *archive*) return 0 ;;
        *) return 1 ;;
      esac
    }
    tar() { return 0; }
    check_prepare_base() {
      if [[ "\${base_ready:-0}" -eq 1 ]]; then return 0; fi
      base_ready=1
      base_attempted=1
      base_tree="$(mktemp -d "\${TMPDIR:-/tmp}/ocp-pr-base.XXXXXX")"
      echo "BASE_TREE=prepared commit=${"b".repeat(40)}"
    }
    check_run_isolated() {
      printf '%s\\n' "\${CHECK_TREE:-head} $*" >> "$PROBE_LOG"
      ${isolated}
    }
    check_main 156
  `], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } })
}

describe("isolated-check contract gate", () => {
  test("a contract failure already on the merge base is pre-existing and does not fail the run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-"))
    try {
      const log = path.join(dir, "commands")
      const result = gate(`
        case "$*" in
          *review-boundary-contracts.mjs*)
            echo "BOUNDARY_CONTRACT=clone-adapter-has-no-pi-dsh:failed count=1; example=packages/adapter/src/old.ts:3"
            echo "REVIEW_CONTRACT_COMPLETE=BOUNDARY_CONTRACTS:failed"
            return 1 ;;
          *review-*-contracts.mjs*)
            echo "REVIEW_CONTRACT_COMPLETE=$(basename "$2" .mjs | tr a-z- A-Z_ | sed 's/^REVIEW_//')"":passed"
            return 0 ;;
        esac
        return 0
      `, { PROBE_LOG: log })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("BOUNDARY_CONTRACTS=pre-existing exit=1")
      expect(result.stdout).toContain("BOUNDARY_CONTRACTS_NEW=none")
      expect(result.stdout).toContain("BOUNDARY_CONTRACTS_PREEXISTING=BOUNDARY_CONTRACT=clone-adapter-has-no-pi-dsh:failed count=1; example=packages/adapter/src/old.ts:3")
      expect(result.stdout).toContain("UNIT_TESTS=passed")
      expect(result.stdout).toContain("CHECK_SUMMARY pr=156 checks=0 new_contracts=0 preexisting_contracts=1 blocking=none")
      const commands = fs.readFileSync(log, "utf8")
      expect(commands).toContain("head bun /opt/harness/scripts/review-boundary-contracts.mjs /src")
      expect(commands).toContain("base bun /opt/harness/scripts/review-boundary-contracts.mjs /src")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    { variant: "only shifts the old import", addition: "", status: 0 },
    { variant: "adds a different forbidden import", addition: 'import { y } from "@deepseek-ai/fixture"\n', status: 1 },
    { variant: "duplicates the old forbidden import", addition: 'import { x } from "@oh-my-pi/fixture"\n', status: 1 },
  ])("classifies boundary failures when the head $variant", ({ addition, status }) => {
    const file = "packages/adapter/src/host.ts"
    const oldImport = 'import { x } from "@oh-my-pi/fixture"\n'
    const base = subjectTree({ [file]: oldImport })
    const head = subjectTree({ [file]: addition ? oldImport + addition : "// line offset fixture\n" + oldImport })
    try {
      const result = gate(`
        case "$*" in
          *review-boundary-contracts.mjs*)
            target="$HEAD_SUBJECT"
            if [[ "$CHECK_TREE" == base ]]; then target="$BASE_SUBJECT"; fi
            "$CONTRACT_BUN" "$ROOT/scripts/review-boundary-contracts.mjs" "$target"
            return $? ;;
          *review-catalog-contracts.mjs*) echo "REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:passed"; return 0 ;;
        esac
        return 0
      `, { PROBE_LOG: path.join(head, "commands"), CONTRACT_BUN: bun, BASE_SUBJECT: base, HEAD_SUBJECT: head })
      expect(result.status, result.stdout + result.stderr).toBe(status)
      const lines = result.stdout.split("\n")
      expect(lines.filter(line => line.startsWith("BOUNDARY_CONTRACTS_PREEXISTING=BOUNDARY_CONTRACT="))).toHaveLength(1)
      expect(lines.filter(line => line.startsWith("BOUNDARY_CONTRACTS_NEW=BOUNDARY_CONTRACT="))).toHaveLength(status)
      expect(result.stdout).toContain("UNIT_TESTS=passed")
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(head, { recursive: true, force: true })
    }
  })

  test("a failure the merge base does not have fails the run while later checks still report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-"))
    try {
      const result = gate(`
        case "$*" in
          *review-catalog-contracts.mjs*)
            echo "CATALOG_CONTRACT=newcomer-appended-not-resorted:passed"
            if [[ "\${CHECK_TREE:-head}" == head ]]; then
              echo "CATALOG_CONTRACT=equal-name-descriptor-frozen:failed description=\\"changed\\""
              echo "REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:failed"
              return 1
            fi
            echo "REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:passed"
            return 0 ;;
          *review-boundary-contracts.mjs*) echo "REVIEW_CONTRACT_COMPLETE=BOUNDARY_CONTRACTS:passed"; return 0 ;;
        esac
        return 0
      `, { PROBE_LOG: path.join(dir, "commands") })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("CATALOG_CONTRACTS=failed exit=1")
      expect(result.stdout).toContain('CATALOG_CONTRACTS_NEW=CATALOG_CONTRACT=equal-name-descriptor-frozen:failed description="changed"')
      expect(result.stdout).toContain("UNIT_TESTS=passed")
      expect(result.stdout).toContain("new_contracts=1 preexisting_contracts=0 blocking=CATALOG_CONTRACTS")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a whole area disappearing on the head is a lost capability, using the contracts' real output", () => {
    const empty = subjectTree({})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-lost-"))
    try {
      const head = contract("review-catalog-contracts.mjs", empty)
      const base = contract("review-catalog-contracts.mjs", root)
      expect(head.status).toBe(0)
      expect(base.status).toBe(0)
      fs.writeFileSync(path.join(dir, "base"), base.stdout)
      fs.writeFileSync(path.join(dir, "head"), head.stdout)
      const lost = spawnSync("bash", ["-c", 'source scripts/isolated-check.sh; check_lost_contract_feature "$1" "$2"', "_", path.join(dir, "base"), path.join(dir, "head")], { cwd: root, encoding: "utf8" })
      expect(lost.status, lost.stderr).toBe(0)
      const lines = lost.stdout.trim().split("\n")
      expect(lines).toHaveLength(7)
      expect(lines.every(line => line.startsWith("CATALOG_CONTRACT=") && line.endsWith(":failed capability disappeared"))).toBe(true)
      // The same subject on both sides loses nothing.
      fs.writeFileSync(path.join(dir, "head"), base.stdout)
      const none = spawnSync("bash", ["-c", 'source scripts/isolated-check.sh; check_lost_contract_feature "$1" "$2"', "_", path.join(dir, "base"), path.join(dir, "head")], { cwd: root, encoding: "utf8" })
      expect(none.status).toBe(1)
      expect(none.stdout).toBe("")
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the gate fails a head whose contract output only skips what the base passed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-"))
    try {
      const result = gate(`
        case "$*" in
          *review-catalog-contracts.mjs*)
            if [[ "\${CHECK_TREE:-head}" == head ]]; then
              echo "CATALOG_CONTRACT=first-catalog-sorted-by-code-unit:skipped packages/opencode-loader/dist/index.js absent"
            else
              echo "CATALOG_CONTRACT=first-catalog-sorted-by-code-unit:passed"
            fi
            echo "REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:passed"
            return 0 ;;
          *review-boundary-contracts.mjs*) echo "REVIEW_CONTRACT_COMPLETE=BOUNDARY_CONTRACTS:passed"; return 0 ;;
        esac
        return 0
      `, { PROBE_LOG: path.join(dir, "commands") })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("CATALOG_CONTRACTS_NEW=CATALOG_CONTRACT=first-catalog-sorted-by-code-unit:failed capability disappeared")
      expect(result.stdout).toContain("blocking=CATALOG_CONTRACTS")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an incomplete contract run and an unavailable boundary are never passes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-"))
    try {
      const incomplete = gate(`
        case "$*" in
          *review-boundary-contracts.mjs*) echo "BOUNDARY_CONTRACT=clone-adapter-has-no-pi-dsh:passed"; return 0 ;;
          *review-*-contracts.mjs*) echo "REVIEW_CONTRACT_COMPLETE=X:passed"; return 0 ;;
        esac
        return 0
      `, { PROBE_LOG: path.join(dir, "a") })
      expect(incomplete.status).toBe(1)
      expect(incomplete.stdout).toContain("BOUNDARY_CONTRACTS_HEAD=incomplete exit=0")
      expect(incomplete.stdout).toContain("BOUNDARY_CONTRACTS_NEW=unclassified")

      const unavailable = gate(`
        case "$*" in *review-boundary-contracts.mjs*) return 2 ;; esac
        return 0
      `, { PROBE_LOG: path.join(dir, "b") })
      expect(unavailable.status).toBe(2)
      expect(unavailable.stdout).toContain("BOUNDARY_CONTRACTS=unavailable")
      expect(unavailable.stdout).not.toContain("UNIT_TESTS=")
      expect(unavailable.stdout).toContain("ISOLATION=unavailable")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the boundary mounts this checkout's contracts read-only, not the subject's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocp-gate-"))
    try {
      const result = spawnSync("bash", ["-c", `
        set -euo pipefail
        source scripts/isolated-check.sh
        # A subject that ships its own contract copy must not be the one mounted.
        mkdir -p "$SUBJECT/scripts" && echo 'console.log("WRONG_HARNESS")' > "$SUBJECT/scripts/review-boundary-contracts.mjs"
        cd "$SUBJECT"
        check_contract_scripts
        cmp "$isolate_contracts/review-boundary-contracts.mjs" "$ROOT/scripts/review-boundary-contracts.mjs"
        ls "$isolate_contracts"
        check_cleanup
      `], { cwd: root, encoding: "utf8", env: { ...process.env, SUBJECT: dir } })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim().split("\n")).toEqual(["review-boundary-contracts.mjs", "review-catalog-contracts.mjs"])
      const script = fs.readFileSync(path.join(root, "scripts/isolated-check.sh"), "utf8")
      expect(script).toContain('contracts=(--ro-bind "$isolate_contracts:/opt/harness/scripts")')
      // The copy is made under check_main's EXIT trap, never lazily by a direct caller.
      expect(script.indexOf("trap check_cleanup EXIT")).toBeLessThan(script.indexOf("if ! check_contract_scripts; then"))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
