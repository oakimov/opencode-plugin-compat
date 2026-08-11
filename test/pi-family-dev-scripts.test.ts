import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const helper = resolve(import.meta.dir, "../scripts/pi-family-dev-common.sh")
const packageJsonPath = resolve(import.meta.dir, "../packages/pi-bridge/package.json")

function bash(command: string, args: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-c", command, "pi-family-dev-test", ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("Pi-family development scripts", () => {
  test("config switching preserves unrelated providers and selected provider options", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-pi-family-config-"))
    const provider = join(root, "cursor-opencode-provider")
    const config = join(root, "agent", "pi-bridge.json")
    try {
      mkdirSync(join(provider, "dist"), { recursive: true })
      mkdirSync(join(root, "agent"), { recursive: true })
      writeFileSync(join(provider, "package.json"), '{"name":"cursor-opencode-provider"}\n')
      writeFileSync(join(provider, "dist", "index.js"), "export {}\n")
      writeFileSync(
        config,
        `${JSON.stringify(
          {
            providers: [
              { package: "other-provider", apiKey: "OTHER_KEY" },
              { packageSpecifier: "cursor-opencode-provider", splitDimensions: [] },
            ],
          },
          null,
          2,
        )}\n`,
        { mode: 0o640 },
      )

      const localEntry = join(provider, "dist", "index.js")
      let result = bash(
        'source "$1"; pi_family_dev_patch_config "$2" "$3" cursor-opencode-provider',
        [helper, config, localEntry],
      )
      expect(result.exitCode).toBe(0)
      let data = JSON.parse(readFileSync(config, "utf8"))
      expect(data.providers).toEqual([
        { package: "other-provider", apiKey: "OTHER_KEY" },
        { package: localEntry, splitDimensions: [] },
      ])
      expect(statSync(config).mode & 0o777).toBe(0o640)

      result = bash(
        'source "$1"; pi_family_dev_patch_config "$2" cursor-opencode-provider cursor-opencode-provider',
        [helper, config],
      )
      expect(result.exitCode).toBe(0)
      data = JSON.parse(readFileSync(config, "utf8"))
      expect(data.providers).toEqual([
        { package: "other-provider", apiKey: "OTHER_KEY" },
        { package: "cursor-opencode-provider", splitDimensions: [] },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("new config files are private and contain only the requested provider", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-pi-family-new-config-"))
    const config = join(root, "nested", "pi-bridge.json")
    try {
      const result = bash(
        'source "$1"; pi_family_dev_patch_config "$2" demo-provider demo-provider',
        [helper, config],
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ providers: [{ package: "demo-provider" }] })
      expect(statSync(config).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("Pi and OMP npm modes use their native package-manager syntax", () => {
    const command = `
      source "$1"
      pi_family_dev_pi_remove_if_present() { printf 'pi-remove <%s> <%s>\\n' "$1" "$2"; }
      pi_family_dev_omp_remove_if_present() { printf 'omp-remove <%s> <%s>\\n' "$1" "$2"; }
      pi_family_dev_patch_config() { printf 'config <%s> <%s> <%s>\\n' "$1" "$2" "$3"; }
      fake_host() { printf 'host'; for arg in "$@"; do printf ' <%s>' "$arg"; done; printf '\\n'; }
      pi_family_dev_install_npm pi fake_host /ocp/packages/pi-bridge demo-provider
      pi_family_dev_install_npm omp fake_host /ocp/packages/pi-bridge demo-provider
    `
    const result = bash(command, [helper], {
      PI_BRIDGE_CONFIG: "/agent/pi-bridge.json",
      OCP_DEV_BRIDGE_VERSION: "1.2.3",
      OCP_DEV_PLUGIN_VERSION: "4.5.6",
    })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain("host <install> <npm:@opencode-compat/pi-bridge@1.2.3>")
    expect(output).toContain("host <install> <npm:demo-provider@4.5.6>")
    expect(output).toContain("host <plugin> <install> <@opencode-compat/pi-bridge@1.2.3> <--force>")
    expect(output).toContain("host <plugin> <install> <demo-provider@4.5.6> <--force>")
    expect(output.match(/config <\/agent\/pi-bridge.json> <demo-provider> <demo-provider>/g)).toHaveLength(2)
  })

  test("Pi and OMP local modes register only the bridge and use the provider module path", () => {
    const command = `
      source "$1"
      pi_family_dev_link_host_ai() { printf 'peer <%s> <%s> <%s>\\n' "$1" "$2" "$3"; }
      pi_family_dev_pi_remove_if_present() { printf 'pi-remove <%s> <%s>\\n' "$1" "$2"; }
      pi_family_dev_omp_remove_if_present() { printf 'omp-remove <%s> <%s>\\n' "$1" "$2"; }
      pi_family_dev_patch_config() { printf 'config <%s> <%s> <%s>\\n' "$1" "$2" "$3"; }
      fake_host() { printf 'host'; for arg in "$@"; do printf ' <%s>' "$arg"; done; printf '\\n'; }
      pi_family_dev_install_local pi fake_host /ocp/packages/pi-bridge /provider demo-provider
      pi_family_dev_install_local omp fake_host /ocp/packages/pi-bridge /provider demo-provider
    `
    const result = bash(command, [helper], { PI_BRIDGE_CONFIG: "/agent/pi-bridge.json" })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain("host <install> </ocp/packages/pi-bridge>")
    expect(output).toContain("host <plugin> <install> </ocp/packages/pi-bridge>")
    expect(output.match(/config <\/agent\/pi-bridge.json> <\/provider\/dist\/index.js> <demo-provider>/g)).toHaveLength(2)
    expect(output).not.toContain("host <install> </provider>")
  })

  test("local mode links the runtime peer supplied by the selected host", () => {
    const root = mkdtempSync(join(tmpdir(), "ocp-pi-family-peer-"))
    const cli = join(root, "global", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
    const peer = join(root, "global", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai")
    const bridge = join(root, "bridge")
    try {
      mkdirSync(join(peer), { recursive: true })
      mkdirSync(join(cli, ".."), { recursive: true })
      mkdirSync(bridge, { recursive: true })
      writeFileSync(join(peer, "package.json"), '{"name":"@earendil-works/pi-ai"}\n')
      writeFileSync(cli, "#!/usr/bin/env bun\n")
      symlinkSync(cli, join(root, "pi"))

      const result = bash(
        'source "$1"; pi_family_dev_link_host_ai pi "$2" "$3"',
        [helper, join(root, "pi"), bridge],
      )
      expect(result.exitCode).toBe(0)
      const target = join(bridge, "node_modules", "@earendil-works", "pi-ai")
      expect(readlinkSync(target)).toBe(realpathSync(peer))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("host manifests select explicit entrypoints without overriding an operator choice", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"))
    expect(pkg.pi.extensions).toEqual(["./dist/extension-pi.js"])
    expect(pkg.omp.extensions).toEqual(["./dist/extension-omp.js"])

    const piEntrypoint = pathToFileURL(resolve(import.meta.dir, "../packages/pi-bridge/src/extension-pi.ts")).href
    const ompEntrypoint = pathToFileURL(resolve(import.meta.dir, "../packages/pi-bridge/src/extension-omp.ts")).href
    const pi = Bun.spawnSync(["bun", "-e", `delete process.env.PI_BRIDGE_HOST; await import(${JSON.stringify(piEntrypoint)}); console.log(process.env.PI_BRIDGE_HOST)`])
    const omp = Bun.spawnSync(["bun", "-e", `delete process.env.PI_BRIDGE_HOST; await import(${JSON.stringify(ompEntrypoint)}); console.log(process.env.PI_BRIDGE_HOST)`])
    const preserved = Bun.spawnSync(["bun", "-e", `process.env.PI_BRIDGE_HOST = "pi"; await import(${JSON.stringify(ompEntrypoint)}); console.log(process.env.PI_BRIDGE_HOST)`])
    expect(pi.exitCode).toBe(0)
    expect(pi.stdout.toString().trim()).toBe("pi")
    expect(omp.exitCode).toBe(0)
    expect(omp.stdout.toString().trim()).toBe("omp")
    expect(preserved.exitCode).toBe(0)
    expect(preserved.stdout.toString().trim()).toBe("pi")
  })

  test("entry scripts are executable and never route through ocp setup", () => {
    for (const name of ["pi-dev.sh", "omp-dev.sh"]) {
      const script = resolve(import.meta.dir, `../scripts/${name}`)
      expect(statSync(script).mode & 0o111).not.toBe(0)
      expect(readFileSync(script, "utf8")).not.toContain("ocp setup")
    }
    expect(readFileSync(helper, "utf8")).not.toContain("host_dev_run_ocp_setup")
    expect(readFileSync(helper, "utf8")).toContain("dist/extension-pi.js")
    expect(readFileSync(helper, "utf8")).toContain("dist/extension-omp.js")
  })
})
