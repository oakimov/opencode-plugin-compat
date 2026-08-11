import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const helper = resolve(import.meta.dir, "../scripts/host-dev-common.sh")

function bash(command: string, args: string[] = []) {
  return Bun.spawnSync(["bash", "-c", command, "host-dev-test", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("MiMo/Kilo host-dev cleanup", () => {
  test("removes every cached plugin version without touching other packages", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-host-clean-"))
    const packages = join(root, "cache", "packages")
    const latest = join(packages, "cursor-opencode-provider@latest")
    const pinned = join(packages, "cursor-opencode-provider@0.4.0")
    const rootModule = join(packages, "node_modules", "cursor-opencode-provider")
    const unrelated = join(packages, "unrelated-provider@latest")
    try {
      for (const dir of [latest, pinned, rootModule, unrelated]) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "marker"), "present\n")
      }

      const result = bash(
        'source "$1"; host_dev_clean_plugin_installs "$2" cursor-opencode-provider',
        [helper, packages],
      )
      expect(result.exitCode).toBe(0)
      expect(existsSync(latest)).toBe(false)
      expect(existsSync(pinned)).toBe(false)
      expect(existsSync(rootModule)).toBe(false)
      expect(existsSync(unrelated)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("provider cleanup removes only node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-provider-clean-"))
    try {
      writeFileSync(join(root, "package.json"), '{"name":"demo-provider"}\n')
      mkdirSync(join(root, "node_modules", "dependency"), { recursive: true })
      writeFileSync(join(root, "source.ts"), "export {}\n")

      const result = bash(
        'source "$1"; host_dev_remove_provider_dependencies "$2"',
        [helper, root],
      )
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(root, "node_modules"))).toBe(false)
      expect(existsSync(join(root, "package.json"))).toBe(true)
      expect(existsSync(join(root, "source.ts"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an empty cache is a successful no-op under nounset", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-host-empty-"))
    const packages = join(root, "cache", "packages")
    try {
      mkdirSync(packages, { recursive: true })
      const result = bash(
        'set -u; source "$1"; host_dev_clean_plugin_installs "$2" cursor-opencode-provider',
        [helper, packages],
      )
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a cache target that is not a packages directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-host-unsafe-"))
    try {
      const result = bash(
        'source "$1"; host_dev_clean_plugin_installs "$2" cursor-opencode-provider',
        [helper, root],
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("must end in /packages")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("both modes clean before installing or modifying shim state", () => {
    const source = readFileSync(helper, "utf8")
    const localBody = source.slice(
      source.indexOf("host_dev_local()"),
      source.indexOf("host_dev_npm()"),
    )
    const npmBody = source.slice(
      source.indexOf("host_dev_npm()"),
      source.indexOf("host_dev_usage()"),
    )

    expect(localBody).not.toContain("host_dev_install_plugin_local")
    expect(localBody.indexOf("host_dev_clean_plugin_installs")).toBeLessThan(
      localBody.indexOf("host_dev_link_cache_to_provider"),
    )
    expect(localBody.indexOf("host_dev_reinstall_provider_dependencies")).toBeLessThan(
      localBody.indexOf("host_dev_refresh_provider_stock"),
    )
    expect(localBody.indexOf("host_dev_patch_config_local")).toBeLessThan(
      localBody.indexOf("host_dev_run_ocp_setup"),
    )
    expect(npmBody.indexOf("host_dev_clean_plugin_installs")).toBeLessThan(
      npmBody.indexOf("host_dev_reinstall_plugin_npm"),
    )
    expect(npmBody).toContain('host_dev_reinstall_plugin_npm "$host_cli" "$plugin"')
    expect(npmBody.indexOf("host_dev_patch_config_npm")).toBeLessThan(
      npmBody.indexOf("host_dev_reinstall_plugin_npm"),
    )
    expect(npmBody.indexOf("host_dev_patch_config_npm")).toBeLessThan(
      npmBody.indexOf("host_dev_run_ocp_setup"),
    )
    expect(npmBody).not.toContain("host_dev_restore_config")
  })
})
