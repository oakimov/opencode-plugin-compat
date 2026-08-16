# Shared helpers for MiMo / Kilo local-dev wiring (OCP checkout + local consumer plugin).
# Sourced by scripts/mimo-dev.sh and scripts/kilo-dev.sh — do not execute directly.
#
# Local mode is NON-DESTRUCTIVE to the provider checkout: every host gets a
# private instrumented copy under the dev state dir and the host config points
# at that. The stock checkout is read-only here, so native OpenCode — which
# reads the same tree — keeps working, and two clones can be wired at once.
# See tasks/plans/multi-host-local-dev-isolation.md.

# shellcheck source=scripts/ocp-dev-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ocp-dev-common.sh"

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
  # Explicit override wins over discovery. This used to be checked *after* the
  # sibling checkout, so OCP_DEV_PROVIDER_PATH was silently ignored whenever a
  # sibling existed — contradicting TESTING.md and making it impossible to
  # point a dev run at any other checkout.
  if [[ -n "${OCP_DEV_PROVIDER_PATH:-}" ]]; then
    if [[ -d "${OCP_DEV_PROVIDER_PATH}/dist" ]]; then
      echo "${OCP_DEV_PROVIDER_PATH}"
      return 0
    fi
    host_dev_die "OCP_DEV_PROVIDER_PATH is set but has no dist/: ${OCP_DEV_PROVIDER_PATH}"
  fi
  sibling="$(dirname "$ocp_root")/cursor-opencode-provider"
  if [[ -d "$sibling/dist" ]]; then
    echo "$sibling"
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

# Rebuild the out-of-box provider dist, then remove generated OCP artifacts.
# Rebuild/reinstall is the only stock source of truth; OCP never restores a
# captured entry backup.
#
# Restore-only: `clean-test-state.sh` and `ocp-dev.sh repair-stock` call this to
# undo a checkout dirtied by an older in-place script. Local wiring must NOT —
# it shares this tree with native OpenCode. See host_dev_ensure_stock_build.
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
  shift 4
  echo "host-dev: ocp setup --host ${host} --mode ${mode} $*"
  bun "$ocp_cli" setup --host "$host" --mode "$mode" --dir "$packages_dir" "$@"
}

# Build the stock dist only when it is missing. Unlike the old
# refresh-provider-stock path this never reinstalls dependencies and never
# deletes anything: the checkout is shared with native OpenCode, so a dev run
# for one host must not rebuild the world underneath it. Use
# `ocp-dev.sh repair-stock` when a genuine restore is wanted.
host_dev_ensure_stock_build() {
  local provider_path="$1"
  local entry="${provider_path}/dist/index.js"

  if [[ -f "$entry" ]]; then
    echo "host-dev: stock dist present (left untouched): ${entry}"
    return 0
  fi

  echo "host-dev: stock dist missing — building once in ${provider_path}"
  (
    cd "$provider_path"
    if command -v bun >/dev/null 2>&1; then bun run build; else npm run build; fi
  ) || host_dev_die "provider build failed in ${provider_path}"
  [[ -f "$entry" ]] || host_dev_die "provider entry missing after build: ${entry}"
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
  local wrapper wrapper_entry
  ocp_root="$(host_dev_repo_root)"
  ocp_cli="$(host_dev_ocp_cli "$ocp_root")"
  [[ -f "$ocp_cli" ]] || host_dev_die "missing OCP CLI: $ocp_cli"
  provider_path="$(host_dev_default_provider_path "$ocp_root")"
  plugin="$(host_dev_plugin_name)"
  packages_dir="$(host_dev_cache_packages_dir "$host")"
  pkg_root="$(host_dev_plugin_cache_pkg "$packages_dir" "$plugin")"
  module_dir="$(host_dev_plugin_module_dir "$pkg_root" "$plugin")"
  host_cli="$(host_dev_resolve_host_cli "$host")"
  config_file="$(host_dev_config_file "$host")"
  wrapper="$(ocp_dev_wrapper_dir "$host")"
  wrapper_entry="${wrapper}/dist/index.js"

  # Refuse to build on top of a checkout an older script already shimmed.
  ocp_dev_assert_stock_clean "$provider_path"
  host_dev_ensure_stock_build "$provider_path"

  # Host package cache is per-host, so cleaning it affects no one else.
  host_dev_clean_plugin_installs "$packages_dir" "$plugin"

  # Private instrumented copy — the stock checkout is never written.
  ocp_dev_build_wrapper "$host" "$provider_path" "$ocp_root"
  host_dev_link_cache_to_provider "$module_dir" "$wrapper"

  ocp_dev_apply_slot "$host" "$config_file" local \
    "$wrapper_entry" "file://${wrapper_entry}" "$provider_path" "$wrapper"

  # Facade overrides land in this host's own package cache AND — because the
  # config now names the wrapper — inside the wrapper's node_modules. That is
  # what we want in local mode: it exercises this checkout's facade code, which
  # is the whole point of --mode file. It is safe only because the wrapper's
  # node_modules is a real directory of per-package symlinks; were it a symlink
  # to the stock node_modules, this step would rewrite the shared checkout.
  host_dev_run_ocp_setup "$ocp_cli" "$host" file "$packages_dir"

  ocp_dev_assert_stock_clean "$provider_path"

  echo ""
  echo "host-dev: ${host} is on LOCAL OCP + LOCAL ${plugin}"
  echo "  wrapper:  ${wrapper_entry}"
  echo "  stock:    ${provider_path}  (untouched)"
  echo "  config:   ${config_file}"
  echo "  verify:   ${host_cli} models | head"
  echo "  status:   ${ocp_root}/scripts/ocp-dev.sh status"
  echo "  revert:   ${ocp_root}/scripts/ocp-dev.sh revert ${host}"
}

host_dev_npm() {
  local host="$1"
  local ocp_root ocp_cli provider_path plugin packages_dir host_cli config_file
  ocp_root="$(host_dev_repo_root)"
  ocp_cli="$(host_dev_ocp_cli "$ocp_root")"
  [[ -f "$ocp_cli" ]] || host_dev_die "missing OCP CLI: $ocp_cli"
  provider_path="$(host_dev_default_provider_path "$ocp_root")"
  plugin="$(host_dev_plugin_name)"
  packages_dir="$(host_dev_cache_packages_dir "$host")"
  host_cli="$(host_dev_resolve_host_cli "$host")"
  config_file="$(host_dev_config_file "$host")"

  # npm mode installs from the registry into this host's own package cache and
  # does not use the local checkout at all. The old reinstall/rebuild here was
  # really a repair for the damage local mode used to do; local mode no longer
  # touches the checkout, so the repair belongs in `ocp-dev.sh repair-stock`.
  host_dev_clean_plugin_installs "$packages_dir" "$plugin"

  # Writing the npm slot evicts whatever local mode recorded, so switching
  # modes cannot leave two provider entries in `plugin`.
  ocp_dev_apply_slot "$host" "$config_file" npm \
    "${plugin}@latest" "$plugin" "$provider_path" ""

  host_dev_reinstall_plugin_npm "$host_cli" "$plugin"
  host_dev_run_ocp_setup "$ocp_cli" "$host" npm "$packages_dir"

  # Local wrapper state is now stale; drop it so `status` does not imply the
  # host is still on a wrapper it no longer loads.
  local wrapper
  wrapper="$(ocp_dev_wrapper_dir "$host")"
  if [[ -d "$wrapper" ]]; then
    ocp_dev_assert_managed_path "$wrapper"
    rm -rf "$wrapper"
    echo "host-dev: removed stale local wrapper ${wrapper}"
  fi

  echo ""
  echo "host-dev: ${host} is on published npm OCP facades + npm ${plugin}"
  echo "  stock:  ${provider_path}  (untouched)"
  echo "  verify: ${host_cli} models | head"
  echo "  status: ${ocp_root}/scripts/ocp-dev.sh status"
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
