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

# Rebuild stock provider dist and drop any prior Option B backup/runtime.
# Required because `ocp setup` reuses dist/index.ocp-original.js when present — a
# leftover backup from an older build would re-wrap stale entry code forever.
#
# IMPORTANT: call this while the provider still has its real `@opencode-ai/*`
# dependencies (before wiring OCP facades). Facade typings are not a full
# substitute for `@opencode-ai/plugin` during `tsc`.
host_dev_refresh_provider_stock() {
  local provider_path="$1"
  local dist="${provider_path}/dist"
  local entry="${dist}/index.js"
  local original="${dist}/index.ocp-original.js"

  if [[ -f "$entry" ]] && grep -q "generated by ocp setup" "$entry" 2>/dev/null; then
    if [[ ! -f "$original" ]]; then
      host_dev_die "shimmed ${entry} without index.ocp-original.js — cannot refresh stock entry"
    fi
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

  # Only discard the previous Option B backup after a successful stock rebuild,
  # so a failed build can still recover from index.ocp-original.js.
  if [[ -f "$original" || -f "${dist}/ocp-lm-runtime.js" || -f "${dist}/ocp-shim-meta.json" ]]; then
    rm -f "$original" "${dist}/ocp-lm-runtime.js" "${dist}/ocp-shim-meta.json"
    echo "host-dev: dropped prior provider shim backup/runtime under ${dist}"
  fi
  echo "host-dev: stock entry ready for ocp setup at ${entry}"
}

host_dev_verify_provider_shim() {
  local host="$1"
  local provider_path="$2"
  local dist="${provider_path}/dist"
  local entry="${dist}/index.js"
  local original="${dist}/index.ocp-original.js"
  local meta="${dist}/ocp-shim-meta.json"

  [[ -f "$entry" ]] || host_dev_die "missing shim entry after setup: ${entry}"
  [[ -f "$original" ]] || host_dev_die "missing stock backup after setup: ${original}"
  [[ -f "${dist}/ocp-lm-runtime.js" ]] || host_dev_die "missing ocp-lm-runtime.js after setup"
  grep -q "generated by ocp setup" "$entry" || host_dev_die "dist/index.js is not an OCP shim after setup"
  if grep -q "generated by ocp setup" "$original" 2>/dev/null; then
    host_dev_die "index.ocp-original.js looks shimmed — stock backup is wrong"
  fi
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
  # Rebuild against the provider's real @opencode-ai/* deps, then wire facades.
  # `ocp setup` reuses any present index.ocp-original.js, so refresh drops that
  # backup only after a successful stock rebuild.
  host_dev_unwire_provider_facades "$provider_path"
  host_dev_refresh_provider_stock "$provider_path"
  host_dev_wire_provider_facades "$ocp_root" "$provider_path"
  host_dev_run_ocp_setup "$ocp_cli" "$host" file "$packages_dir"
  host_dev_verify_provider_shim "$host" "$provider_path"
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
  # Prefer a fresh stock build over restoring a possibly stale ocp-original.
  if [[ -f "${provider_path}/dist/index.ocp-original.js" ]] || grep -q "generated by ocp setup" "${provider_path}/dist/index.js" 2>/dev/null; then
    host_dev_refresh_provider_stock "$provider_path"
  else
    host_dev_restore_provider_entry "$provider_path"
  fi
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
          Rebuilds provider dist, drops stale index.ocp-original.js, then ocp setup.
  npm     Restore host config backup, refresh local provider stock, reinstall plugin
          from npm, ocp setup --mode npm.

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