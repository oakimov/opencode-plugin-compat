import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const helper = resolve(import.meta.dir, "../scripts/host-dev-common.sh")
const cleaner = resolve(import.meta.dir, "../scripts/clean-test-state.sh")

function bash(command: string, args: string[] = []) {
  return Bun.spawnSync(["bash", "-c", command, "host-dev-test", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("MiMo/Kilo host-dev cleanup", () => {
  test("standalone test-state cleanup is executable and exposes provider reset", () => {
    const syntax = Bun.spawnSync(["bash", "-n", cleaner], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(syntax.exitCode).toBe(0)

    const help = Bun.spawnSync([cleaner, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(help.exitCode).toBe(0)
    expect(help.stdout.toString()).toContain("--provider PATH")
    expect(help.stdout.toString()).toContain("--host mimo|kilo")
    expect(statSync(cleaner).mode & 0o111).not.toBe(0)
  })

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
    // The wrapper must exist before the config is pointed at it, and the slot
    // must be written before setup runs against it.
    expect(localBody.indexOf("ocp_dev_build_wrapper")).toBeLessThan(
      localBody.indexOf("ocp_dev_apply_slot"),
    )
    expect(localBody.indexOf("ocp_dev_apply_slot")).toBeLessThan(
      localBody.indexOf("host_dev_run_ocp_setup"),
    )
    expect(npmBody.indexOf("host_dev_clean_plugin_installs")).toBeLessThan(
      npmBody.indexOf("host_dev_reinstall_plugin_npm"),
    )
    expect(npmBody).toContain('host_dev_reinstall_plugin_npm "$host_cli" "$plugin"')
    expect(npmBody.indexOf("ocp_dev_apply_slot")).toBeLessThan(
      npmBody.indexOf("host_dev_reinstall_plugin_npm"),
    )
    expect(npmBody.indexOf("ocp_dev_apply_slot")).toBeLessThan(
      npmBody.indexOf("host_dev_run_ocp_setup"),
    )
    expect(npmBody).not.toContain("host_dev_restore_config")
  })

  test("local mode never mutates the shared provider checkout", () => {
    const source = readFileSync(helper, "utf8")
    const localBody = source.slice(
      source.indexOf("host_dev_local()"),
      source.indexOf("host_dev_npm()"),
    )

    // Native OpenCode reads the stock checkout by absolute path, and both
    // clones read it too. Any of these in the local path reintroduces the
    // last-writer-wins breakage this design removed.
    for (const destructive of [
      "host_dev_wire_provider_facades",
      "host_dev_refresh_provider_stock",
      "host_dev_remove_provider_dependencies",
      "host_dev_reinstall_provider_dependencies",
    ]) {
      expect(localBody).not.toContain(destructive)
    }

    // Guard the checkout before touching anything, and re-assert afterwards.
    expect(localBody.indexOf("ocp_dev_assert_stock_clean")).toBeLessThan(
      localBody.indexOf("ocp_dev_build_wrapper"),
    )
    expect(localBody.lastIndexOf("ocp_dev_assert_stock_clean")).toBeGreaterThan(
      localBody.indexOf("host_dev_run_ocp_setup"),
    )

    // The cache module must point at the per-host wrapper, not the stock tree:
    // pointing it at the checkout would serve an uninstrumented provider.
    expect(localBody).toContain('host_dev_link_cache_to_provider "$module_dir" "$wrapper"')
  })

  test("the facade-into-stock helper is gone entirely", () => {
    // It is not enough for local mode to stop calling it; leaving it defined
    // invites a future caller to reintroduce the breakage.
    expect(readFileSync(helper, "utf8")).not.toContain("host_dev_wire_provider_facades()")
  })
})

describe("ocp-dev apply_slot stock eviction", () => {
  const ocpCommon = resolve(import.meta.dir, "../scripts/ocp-dev-common.sh")

  test("removes absolute stock checkout paths from plugin[] so absolute-plugins cannot dirty stock", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-slot-"))
    const stock = join(root, "stock-provider")
    const stockEntry = join(stock, "dist", "index.js")
    const wrapperEntry = join(root, "wrapper", "dist", "index.js")
    const configPath = join(root, "kilo.jsonc")
    const stateDir = join(root, "state")
    try {
      mkdirSync(join(stock, "dist"), { recursive: true })
      writeFileSync(stockEntry, "export default {}\n")
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            plugin: [stockEntry, "/other/user-plugin.js"],
            provider: { cursor: { npm: `file://${stockEntry}` } },
          },
          null,
          2,
        ),
      )

      const result = bash(
        'source "$1"; export OCP_DEV_STATE_DIR="$2"; ocp_dev_apply_slot kilo "$3" local "$4" "file://$4" "$5" "$6"',
        [ocpCommon, stateDir, configPath, wrapperEntry, stock, join(root, "wrapper")],
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("stock checkout plugin path")

      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        plugin: string[]
        provider?: { cursor?: { npm?: string } }
      }
      expect(config.plugin).toEqual(["/other/user-plugin.js", wrapperEntry])
      expect(config.plugin.some((entry) => entry.includes("stock-provider"))).toBe(false)
      expect(config.provider?.cursor?.npm).toBe(`file://${wrapperEntry}`)

      const manifestPath = join(stateDir, "kilo", "state.json")
      expect(existsSync(manifestPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        config: { stockPluginEntriesBefore?: string[]; pluginAdded?: string }
      }
      expect(manifest.config.pluginAdded).toBe(wrapperEntry)
      expect(manifest.config.stockPluginEntriesBefore).toEqual([stockEntry])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
