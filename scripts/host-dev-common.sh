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
      for name in opencode.json opencode.jsonc kilo.json kilo.jsonc config.json; do
        if [[ -f "$dir/$name" ]]; then
          echo "$dir/$name"
          return 0
        fi
      done
      echo "$dir/opencode.json"
      ;;
  esac
}

host_dev_state_dir() {
  local host="$1"
  echo "$(host_dev_config_dir "$host")/.ocp-dev"
}

host_dev_backup_file() {
  echo "$(host_dev_state_dir "$1")/host-config.backup.json"
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

host_dev_backup_config_if_needed() {
  local host="$1"
  local config_file backup state_dir
  config_file="$(host_dev_config_file "$host")"
  backup="$(host_dev_backup_file "$host")"
  state_dir="$(host_dev_state_dir "$host")"
  mkdir -p "$state_dir"
  if [[ ! -f "$backup" && -f "$config_file" ]]; then
    cp "$config_file" "$backup"
    echo "host-dev: backed up $(basename "$config_file") → $backup"
  fi
}

host_dev_restore_config() {
  local host="$1"
  local config_file backup
  config_file="$(host_dev_config_file "$host")"
  backup="$(host_dev_backup_file "$host")"
  if [[ ! -f "$backup" ]]; then
    host_dev_die "no backup at $backup — cannot restore npm config"
  fi
  cp "$backup" "$config_file"
  echo "host-dev: restored $(basename "$config_file") from backup"
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
  bun - "$config_file" "$entry" <<'BUN'
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const [configPath, entryPath] = process.argv.slice(2)

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

host_dev_unwire_provider_facades() {
  local provider_path="$1"
  local ai_dir="${provider_path}/node_modules/@opencode-ai"
  if [[ -L "${ai_dir}/plugin" || -L "${ai_dir}/sdk" ]]; then
    rm -rf "$ai_dir"
    echo "host-dev: removed facade symlinks under ${provider_path}"
    if [[ -f "${provider_path}/bun.lock" || -f "${provider_path}/package-lock.json" ]]; then
      (cd "$provider_path" && (command -v bun >/dev/null && bun install || npm install --ignore-scripts)) || true
    fi
  fi
}

host_dev_restore_provider_entry() {
  local provider_path="$1"
  local dist="${provider_path}/dist"
  local original="${dist}/index.ocp-original.js"
  if [[ ! -f "$original" ]]; then
    return 0
  fi
  mv -f "$original" "${dist}/index.js"
  rm -f "${dist}/ocp-lm-runtime.js" "${dist}/ocp-shim-meta.json" 2>/dev/null || true
  echo "host-dev: restored stock provider dist/index.js from index.ocp-original.js"
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

host_dev_ensure_plugin_installed() {
  local host_cli="$1"
  local plugin="$2"
  echo "host-dev: ${host_cli} plugin -g ${plugin}"
  "$host_cli" plugin -g "$plugin"
}

host_dev_reinstall_plugin_npm() {
  local host_cli="$1"
  local plugin="$2"
  echo "host-dev: ${host_cli} plugin -g ${plugin} -f (npm)"
  "$host_cli" plugin -g "$plugin" -f
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

  host_dev_backup_config_if_needed "$host"
  host_dev_ensure_plugin_installed "$host_cli" "$plugin"
  host_dev_link_cache_to_provider "$module_dir" "$provider_path"
  host_dev_wire_provider_facades "$ocp_root" "$provider_path"
  host_dev_run_ocp_setup "$ocp_cli" "$host" file "$packages_dir"
  host_dev_patch_config_local "$host" "$provider_path"

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
  local ocp_root ocp_cli provider_path plugin packages_dir module_dir host_cli
  ocp_root="$(host_dev_repo_root)"
  ocp_cli="$(host_dev_ocp_cli "$ocp_root")"
  [[ -f "$ocp_cli" ]] || host_dev_die "missing OCP CLI: $ocp_cli"
  provider_path="$(host_dev_default_provider_path "$ocp_root")"
  plugin="$(host_dev_plugin_name)"
  packages_dir="$(host_dev_cache_packages_dir "$host")"
  module_dir="$(host_dev_plugin_module_dir "$(host_dev_plugin_cache_pkg "$packages_dir" "$plugin")" "$plugin")"
  host_cli="$(host_dev_resolve_host_cli "$host")"

  host_dev_restore_config "$host"
  host_dev_restore_provider_entry "$provider_path"
  host_dev_unwire_provider_facades "$provider_path"
  rm -rf "$module_dir"
  host_dev_reinstall_plugin_npm "$host_cli" "$plugin"
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
  npm     Restore host config backup, reinstall plugin from npm, ocp setup --mode npm.

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