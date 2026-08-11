# Shared helpers for MiMo / Kilo local-dev wiring (OCP checkout + local consumer plugin).
# Sourced by scripts/mimo-dev.sh and scripts/kilo-dev.sh — do not execute directly.

host_dev_die() {
  echo "host-dev: $*" >&2
  exit 1
}

host_dev_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/.." && pwd
}

host_dev_ocp_cli() {
  local root="$1"
  echo "$root/packages/ocp/bin/ocp.ts"
}

host_dev_default_provider_path() {
  local ocp_root="$1"
  local sibling
  sibling="$(dirname "$ocp_root")/cursor-opencode-provider"
  if [[ -d "$sibling/dist" ]]; then
    echo "$sibling"
    return 0
  fi
  if [[ -n "${OCP_DEV_PROVIDER_PATH:-}" && -d "${OCP_DEV_PROVIDER_PATH}/dist" ]]; then
    echo "${OCP_DEV_PROVIDER_PATH}"
    return 0
  fi
  local fallback="${HOME}/Projects/cursor-opencode-provider"
  if [[ -d "$fallback/dist" ]]; then
    echo "$fallback"
    return 0
  fi
  host_dev_die "local provider not found; set OCP_DEV_PROVIDER_PATH to your cursor-opencode-provider checkout"
}

host_dev_plugin_name() {
  echo "${OCP_DEV_PLUGIN:-cursor-opencode-provider}"
}

# --- host-specific paths ---

host_dev_config_dir() {
  local host="$1"
  case "$host" in
    mimo)
      if [[ -n "${MIMOCODE_HOME:-}" ]]; then
        echo "${MIMOCODE_HOME}/config"
      else
        echo "${XDG_CONFIG_HOME:-${HOME}/.config}/mimocode"
      fi
      ;;
    kilo)
      if [[ -n "${KILO_CONFIG_DIR:-}" ]]; then
        echo "${KILO_CONFIG_DIR}"
      else
        echo "${XDG_CONFIG_HOME:-${HOME}/.config}/kilo"
      fi
      ;;
    *) host_dev_die "unknown host: $host (expected mimo or kilo)" ;;
  esac
}

host_dev_cache_packages_dir() {
  local host="$1"
  case "$host" in
    mimo)
      if [[ -n "${MIMOCODE_HOME:-}" ]]; then
        echo "${MIMOCODE_HOME}/cache/packages"
      else
        echo "${XDG_CACHE_HOME:-${HOME}/.cache}/mimocode/packages"
      fi
      ;;
    kilo)
      echo "${XDG_CACHE_HOME:-${HOME}/.cache}/kilo/packages"
      ;;
    *) host_dev_die "unknown host: $host" ;;
  esac
}

host_dev_config_file() {
  local host="$1"
  local dir
  dir="$(host_dev_config_dir "$host")"
  case "$host" in
    mimo)
      if [[ -f "$dir/mimocode.json" ]]; then
        echo "$dir/mimocode.json"
      elif [[ -f "$dir/mimocode.jsonc" ]]; then
        echo "$dir/mimocode.jsonc"
      else
        echo "$dir/mimocode.json"
      fi
      ;;
    kilo)
      # Prefer kilo.* first — matches adapter path-bridge hostConfigFiles order.
      for name in kilo.jsonc kilo.json opencode.json opencode.jsonc config.json; do
        if [[ -f "$dir/$name" ]]; then
          echo "$dir/$name"
          return 0
        fi
      done
      echo "$dir/kilo.jsonc"
      ;;
  esac
}

host_dev_resolve_host_cli() {
  local host="$1"
  local bin
  case "$host" in
    mimo)
      if command -v mimo >/dev/null 2>&1; then
        command -v mimo
        return 0
      fi
      bin="${HOME}/.mimocode/bin/mimo"
      ;;
    kilo)
      if command -v kilo >/dev/null 2>&1; then
        command -v kilo
        return 0
      fi
      bin="${HOME}/.local/bin/kilo"
      ;;
    *) host_dev_die "unknown host: $host" ;;
  esac
  if [[ -x "$bin" ]]; then
    echo "$bin"
    return 0
  fi
  host_dev_die "$host CLI not found on PATH (tried $bin)"
}

host_dev_plugin_cache_pkg() {
  local packages_dir="$1"
  local plugin="$2"
  echo "${packages_dir}/${plugin}@latest"
}

host_dev_plugin_module_dir() {
  local pkg_root="$1"
  local plugin="$2"
  echo "${pkg_root}/node_modules/${plugin}"
}

host_dev_assert_safe_provider_checkout() {
  local provider_path="$1"
  if [[ -z "$provider_path" || "$provider_path" == "/" || "$provider_path" == "${HOME}" ]]; then
    host_dev_die "refusing unsafe provider checkout path: ${provider_path:-<empty>}"
  fi
  [[ -f "${provider_path}/package.json" ]] || host_dev_die "provider package.json missing: ${provider_path}"
}

host_dev_assert_safe_packages_dir() {
  local packages_dir="$1"
  if [[ -z "$packages_dir" || "$packages_dir" == "/" || "$packages_dir" == "${HOME}" ]]; then
    host_dev_die "refusing unsafe host packages path: ${packages_dir:-<empty>}"
  fi
  [[ "$(basename "$packages_dir")" == "packages" ]] || host_dev_die "host cache target must end in /packages: ${packages_dir}"
}

# Remove every cached version of one plugin, including the root node_modules
# copy used by some host releases. Package metadata is removed with the module
# so a later forced install cannot reuse a stale version or dependency tree.
host_dev_clean_plugin_installs() {
  local packages_dir="$1"
  local plugin="$2"
  local plugin_parent plugin_leaf candidate

  host_dev_assert_safe_packages_dir "$packages_dir"
  [[ -n "$plugin" && "$plugin" != /* && "$plugin" != *".."* ]] || host_dev_die "refusing unsafe plugin name: ${plugin:-<empty>}"

  plugin_parent="$(dirname "${packages_dir}/${plugin}")"
  plugin_leaf="$(basename "$plugin")"
  shopt -s nullglob
  for candidate in "${plugin_parent}/${plugin_leaf}@"*; do
    [[ "$(dirname "$candidate")" == "$plugin_parent" ]] || host_dev_die "refusing cache target outside plugin directory: ${candidate}"
    rm -rf "$candidate"
    echo "host-dev: removed cached plugin install ${candidate}"
  done
  shopt -u nullglob

  candidate="${packages_dir}/node_modules/${plugin}"
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    rm -rf "$candidate"
    echo "host-dev: removed root cached module ${candidate}"
  fi
}

host_dev_remove_provider_dependencies() {
  local provider_path="$1"
  local modules="${provider_path}/node_modules"

  host_dev_assert_safe_provider_checkout "$provider_path"
  if [[ -e "$modules" || -L "$modules" ]]; then
    rm -rf "$modules"
    echo "host-dev: removed provider dependencies ${modules}"
  fi
}

host_dev_reinstall_provider_dependencies() {
  local provider_path="$1"

  host_dev_remove_provider_dependencies "$provider_path"

  echo "host-dev: installing clean provider dependencies in ${provider_path}"
  (
    cd "$provider_path"
    if [[ -f bun.lock ]]; then
      command -v bun >/dev/null 2>&1 || host_dev_die "bun is required by ${provider_path}/bun.lock"
      bun install --frozen-lockfile
    elif [[ -f package-lock.json ]]; then
      command -v npm >/dev/null 2>&1 || host_dev_die "npm is required by ${provider_path}/package-lock.json"
      npm ci
    elif command -v bun >/dev/null 2>&1; then
      bun install
    elif command -v npm >/dev/null 2>&1; then
      npm install
    else
      host_dev_die "bun or npm is required to install provider dependencies"
    fi
  ) || host_dev_die "provider dependency install failed in ${provider_path}"
}

host_dev_patch_config_local() {
  local host="$1"
  local provider_path="$2"
  local config_file entry
  config_file="$(host_dev_config_file "$host")"
  entry="${provider_path}/dist/index.js"
  if [[ ! -f "$entry" ]]; then
    host_dev_die "provider entry missing: $entry (run bun run build in the provider checkout)"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    host_dev_die "bun is required to patch host config"
  fi
  bun - "$config_file" "$entry" "$host" "$provider_path" <<'BUN'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

const [configPath, entryPath, host, providerPath] = process.argv.slice(2)

let raw = "{}"
try {
  raw = readFileSync(configPath, "utf8")
} catch {
  mkdirSync(dirname(configPath), { recursive: true })
}

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")
const data = JSON.parse(stripComments(raw))

data.plugin = [entryPath]

const fileUrl = `file://${entryPath}`
data.provider = data.provider ?? {}
data.provider.cursor = {
  npm: fileUrl,
  name: "Cursor",
  models: data.provider.cursor?.models ?? {},
}

writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
console.log(`host-dev: wrote local plugin + provider.cursor into ${configPath}`)

// Kilo's plugin installer can create a second opencode.json even when
// kilo.jsonc is the canonical config. Delete only the exact generated shape;
// any alternate config containing user settings is preserved.
if (host === "kilo") {
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const candidate = join(dirname(configPath), name)
    if (candidate === configPath) continue
    try {
      const alternate = JSON.parse(stripComments(readFileSync(candidate, "utf8")))
      const keys = Object.keys(alternate)
      const plugins = alternate.plugin
      if (
        keys.length === 1 &&
        keys[0] === "plugin" &&
        Array.isArray(plugins) &&
        plugins.length === 1 &&
        (plugins[0] === providerPath || plugins[0] === entryPath)
      ) {
        unlinkSync(candidate)
        console.log(`host-dev: removed redundant generated config ${candidate}`)
      }
    } catch {
      // Missing, JSONC not parseable by the same host subset, or user-owned:
      // leave it untouched.
    }
  }
}
BUN
}

host_dev_patch_config_npm() {
  local host="$1"
  local plugin="$2"
  local config_file
  config_file="$(host_dev_config_file "$host")"
  if ! command -v bun >/dev/null 2>&1; then
    host_dev_die "bun is required to patch host config"
  fi
  bun - "$config_file" "$host" "$plugin" <<'BUN'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"

const [configPath, host, plugin] = process.argv.slice(2)
const pluginSpec = `${plugin}@latest`
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")

let raw = "{}"
try {
  raw = readFileSync(configPath, "utf8")
} catch {
  mkdirSync(dirname(configPath), { recursive: true })
}
const data = JSON.parse(stripComments(raw))
data.plugin = [pluginSpec]

const cursor = data.provider?.cursor
if (
  cursor &&
  typeof cursor === "object" &&
  typeof cursor.npm === "string" &&
  cursor.npm.startsWith("file:")
) {
  delete data.provider.cursor
  if (Object.keys(data.provider).length === 0) delete data.provider
}

writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
console.log(`host-dev: wrote ${pluginSpec} into ${configPath}`)

if (host === "kilo") {
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const candidate = join(dirname(configPath), name)
    if (candidate === configPath) continue
    try {
      const alternate = JSON.parse(stripComments(readFileSync(candidate, "utf8")))
      const keys = Object.keys(alternate)
      const plugins = alternate.plugin
      if (
        keys.length === 1 &&
        keys[0] === "plugin" &&
        Array.isArray(plugins) &&
        plugins.length === 1 &&
        (plugins[0] === plugin || plugins[0] === pluginSpec)
      ) {
        unlinkSync(candidate)
        console.log(`host-dev: removed redundant generated config ${candidate}`)
      }
    } catch {
      // Preserve missing, malformed, or user-owned alternate configs.
    }
  }
}
BUN
}

host_dev_wire_provider_facades() {
  local ocp_root="$1"
  local provider_path="$2"
  local facade_root="${ocp_root}/packages"
  local ai_dir="${provider_path}/node_modules/@opencode-ai"
  mkdir -p "$(dirname "$ai_dir")"
  rm -rf "$ai_dir"
  mkdir -p "$ai_dir"
  ln -sfn "${facade_root}/facade-plugin" "${ai_dir}/plugin"
  ln -sfn "${facade_root}/facade-sdk" "${ai_dir}/sdk"
  echo "host-dev: @opencode-ai/* → local OCP facades in ${provider_path}"
}

# Rebuild the out-of-box provider dist, then remove generated OCP artifacts.
# Rebuild/reinstall is the only stock source of truth; OCP never restores a
# captured entry backup.
#
# IMPORTANT: call this while the provider still has its real `@opencode-ai/*`
# dependencies (before wiring OCP facades). Facade typings are not a full
# substitute for `@opencode-ai/plugin` during `tsc`.
host_dev_refresh_provider_stock() {
  local provider_path="$1"
  local dist="${provider_path}/dist"
  local entry="${dist}/index.js"

  if [[ -f "$entry" ]] && grep -q "generated by ocp setup" "$entry" 2>/dev/null; then
    echo "host-dev: provider entry is shimmed; rebuild will overwrite it from sources"
  fi

  if [[ ! -f "${provider_path}/package.json" ]]; then
    host_dev_die "provider package.json missing: ${provider_path}"
  fi

  echo "host-dev: rebuilding provider stock dist in ${provider_path}"
  (
    cd "$provider_path"
    if command -v bun >/dev/null 2>&1; then
      bun run build
    else
      npm run build
    fi
  ) || host_dev_die "provider build failed in ${provider_path}"

  if [[ ! -f "$entry" ]]; then
    host_dev_die "provider entry missing after build: ${entry}"
  fi
  if grep -q "generated by ocp setup" "$entry" 2>/dev/null; then
    host_dev_die "provider ${entry} still looks shimmed after rebuild"
  fi

  if [[ -f "${dist}/index.ocp-original.js" || -f "${dist}/ocp-lm-runtime.js" || -f "${dist}/ocp-shim-meta.json" ]]; then
    rm -f "${dist}/index.ocp-original.js" "${dist}/ocp-lm-runtime.js" "${dist}/ocp-shim-meta.json"
    echo "host-dev: removed generated/legacy OCP artifacts under ${dist}"
  fi
  echo "host-dev: stock entry ready for ocp setup at ${entry}"
}

host_dev_verify_provider_shim() {
  local host="$1"
  local provider_path="$2"
  local dist="${provider_path}/dist"
  local entry="${dist}/index.js"
  local meta="${dist}/ocp-shim-meta.json"

  [[ -f "$entry" ]] || host_dev_die "missing shim entry after setup: ${entry}"
  [[ -f "${dist}/ocp-lm-runtime.js" ]] || host_dev_die "missing ocp-lm-runtime.js after setup"
  grep -q "generated by ocp setup" "$entry" || host_dev_die "dist/index.js is not an OCP shim after setup"
  [[ ! -e "${dist}/index.ocp-original.js" ]] || host_dev_die "legacy index.ocp-original.js must not exist after setup"
  if [[ -f "$meta" ]]; then
    echo "host-dev: shim meta → $(tr '\n' ' ' <"$meta")"
  fi
  echo "host-dev: verified Option B shim for host=${host} under ${dist}"
  echo "host-dev: NOTE: MiMo/Kilo local mode share this provider checkout; hostHint is last setup wins."
  echo "  Runtime still detects mimo/kilo from argv/env (OPENCODE_COMPAT_HOST override). Re-run this"
  echo "  host's *-dev.sh local before testing if detection falls back to hostHint."
}

host_dev_link_cache_to_provider() {
  local module_dir="$1"
  local provider_path="$2"
  mkdir -p "$(dirname "$module_dir")"
  rm -rf "$module_dir"
  ln -sfn "$provider_path" "$module_dir"
  echo "host-dev: cache module → ${provider_path}"
}

host_dev_run_ocp_setup() {
  local ocp_cli="$1"
  local host="$2"
  local mode="$3"
  local packages_dir="$4"
  echo "host-dev: ocp setup --host ${host} --mode ${mode}"
  bun "$ocp_cli" setup --host "$host" --mode "$mode" --dir "$packages_dir"
}

host_dev_reinstall_plugin_npm() {
  local host_cli="$1"
  local plugin="$2"
  echo "host-dev: ${host_cli} plugin -g ${plugin}@latest -f (npm)"
  "$host_cli" plugin -g "${plugin}@latest" -f
}

host_dev_local() {
  local host="$1"
  local ocp_root ocp_cli provider_path plugin packages_dir pkg_root module_dir host_cli config_file
  ocp_root="$(host_dev_repo_root)"
  ocp_cli="$(host_dev_ocp_cli "$ocp_root")"
  [[ -f "$ocp_cli" ]] || host_dev_die "missing OCP CLI: $ocp_cli"
  provider_path="$(host_dev_default_provider_path "$ocp_root")"
  plugin="$(host_dev_plugin_name)"
  packages_dir="$(host_dev_cache_packages_dir "$host")"
  pkg_root="$(host_dev_plugin_cache_pkg "$packages_dir" "$plugin")"
  module_dir="$(host_dev_plugin_module_dir "$pkg_root" "$plugin")"
  host_cli="$(host_dev_resolve_host_cli "$host")"

  host_dev_clean_plugin_installs "$packages_dir" "$plugin"
  host_dev_reinstall_provider_dependencies "$provider_path"
  host_dev_link_cache_to_provider "$module_dir" "$provider_path"
  # Rebuild against the freshly installed real @opencode-ai/* deps, then wire facades.
  host_dev_refresh_provider_stock "$provider_path"
  host_dev_wire_provider_facades "$ocp_root" "$provider_path"
  host_dev_patch_config_local "$host" "$provider_path"
  host_dev_run_ocp_setup "$ocp_cli" "$host" file "$packages_dir"
  host_dev_verify_provider_shim "$host" "$provider_path"

  config_file="$(host_dev_config_file "$host")"
  echo ""
  echo "host-dev: ${host} is on LOCAL OCP + LOCAL ${plugin}"
  echo "  provider: ${provider_path}"
  echo "  config:   ${config_file}"
  echo "  verify:   ${host_cli} models | head"
  echo "  revert:   ${OCP_DEV_ROOT:-$(host_dev_repo_root)}/scripts/${host}-dev.sh npm"
}

host_dev_npm() {
  local host="$1"
  local ocp_root ocp_cli provider_path plugin packages_dir host_cli
  ocp_root="$(host_dev_repo_root)"
  ocp_cli="$(host_dev_ocp_cli "$ocp_root")"
  [[ -f "$ocp_cli" ]] || host_dev_die "missing OCP CLI: $ocp_cli"
  provider_path="$(host_dev_default_provider_path "$ocp_root")"
  plugin="$(host_dev_plugin_name)"
  packages_dir="$(host_dev_cache_packages_dir "$host")"
  host_cli="$(host_dev_resolve_host_cli "$host")"

  host_dev_clean_plugin_installs "$packages_dir" "$plugin"
  host_dev_reinstall_provider_dependencies "$provider_path"
  host_dev_refresh_provider_stock "$provider_path"
  host_dev_patch_config_npm "$host" "$plugin"
  host_dev_reinstall_plugin_npm "$host_cli" "$plugin"
  host_dev_patch_config_npm "$host" "$plugin"
  host_dev_run_ocp_setup "$ocp_cli" "$host" npm "$packages_dir"

  echo ""
  echo "host-dev: ${host} is on published npm OCP facades + npm ${plugin}"
  echo "  verify: ${host_cli} models | head"
}

host_dev_usage() {
  local name="$1"
  cat <<EOF
Usage: ${name} <local|npm>

  local   Wire host to this OCP checkout (file: facades) and a local provider clone.
          Deletes cached plugin installs and provider node_modules, reinstalls locked
          dependencies, writes the local path, rebuilds stock dist, then applies setup.
  npm     Deletes cached plugin installs and provider node_modules, rebuilds stock,
          writes and installs <plugin>@latest, then runs ocp setup --mode npm.

Environment:
  OCP_DEV_PROVIDER_PATH   Path to cursor-opencode-provider checkout
  OCP_DEV_PLUGIN          Plugin package name (default: cursor-opencode-provider)
  MIMOCODE_HOME / KILO_CONFIG_DIR / XDG_*  Host config & cache locations

EOF
}

host_dev_main() {
  local host="$1"
  shift
  local cmd="${1:-}"
  case "$cmd" in
    local | --local) host_dev_local "$host" ;;
    npm | --npm) host_dev_npm "$host" ;;
    -h | --help | help | "") host_dev_usage "${host}-dev.sh" ;;
    *) host_dev_die "unknown command: $cmd (expected local or npm)" ;;
  esac
}
