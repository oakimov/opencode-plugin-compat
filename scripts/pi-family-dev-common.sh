# Shared helpers for pi / oh-my-pi development wiring.
# Sourced by scripts/pi-dev.sh and scripts/omp-dev.sh — do not execute directly.

pi_family_dev_die() {
  echo "pi-family-dev: $*" >&2
  exit 1
}

pi_family_dev_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/.." && pwd
}

pi_family_dev_bridge_path() {
  local root="$1"
  echo "$root/packages/pi-bridge"
}

pi_family_dev_default_provider_path() {
  local ocp_root="$1"
  local sibling
  if [[ -n "${OCP_DEV_PROVIDER_PATH:-}" && -f "${OCP_DEV_PROVIDER_PATH}/package.json" ]]; then
    (cd "${OCP_DEV_PROVIDER_PATH}" && pwd)
    return 0
  fi
  sibling="$(dirname "$ocp_root")/cursor-opencode-provider"
  if [[ -f "$sibling/package.json" ]]; then
    (cd "$sibling" && pwd)
    return 0
  fi
  local fallback="${HOME}/Projects/cursor-opencode-provider"
  if [[ -f "$fallback/package.json" ]]; then
    (cd "$fallback" && pwd)
    return 0
  fi
  pi_family_dev_die "local provider not found; set OCP_DEV_PROVIDER_PATH to its checkout"
}

pi_family_dev_plugin_name() {
  echo "${OCP_DEV_PLUGIN:-cursor-opencode-provider}"
}

pi_family_dev_resolve_host_cli() {
  local host="$1"
  local fallback
  if command -v "$host" >/dev/null 2>&1; then
    command -v "$host"
    return 0
  fi
  case "$host" in
    pi) fallback="/opt/local/bin/pi" ;;
    omp) fallback="${HOME}/.bun/bin/omp" ;;
    *) pi_family_dev_die "unknown host: $host (expected pi or omp)" ;;
  esac
  if [[ -x "$fallback" ]]; then
    echo "$fallback"
    return 0
  fi
  pi_family_dev_die "$host CLI not found on PATH (tried $fallback)"
}

pi_family_dev_config_file() {
  local host="$1"
  if [[ -n "${PI_BRIDGE_CONFIG:-}" ]]; then
    echo "$PI_BRIDGE_CONFIG"
    return 0
  fi
  if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
    echo "${PI_CODING_AGENT_DIR}/pi-bridge.json"
    return 0
  fi
  case "$host" in
    pi) echo "${HOME}/.pi/agent/pi-bridge.json" ;;
    omp) echo "${HOME}/.omp/agent/pi-bridge.json" ;;
    *) pi_family_dev_die "unknown host: $host" ;;
  esac
}

pi_family_dev_assert_package_dir() {
  local dir="$1"
  local label="$2"
  if [[ -z "$dir" || "$dir" == "/" || "$dir" == "${HOME}" ]]; then
    pi_family_dev_die "refusing unsafe ${label} path: ${dir:-<empty>}"
  fi
  [[ -f "$dir/package.json" ]] || pi_family_dev_die "${label} package.json missing: $dir"
}

pi_family_dev_prepare_local() {
  local root="$1"
  local bridge="$2"
  local provider="$3"

  pi_family_dev_assert_package_dir "$bridge" "pi-bridge"
  pi_family_dev_assert_package_dir "$provider" "provider"
  command -v bun >/dev/null 2>&1 || pi_family_dev_die "bun is required for local mode"

  echo "pi-family-dev: installing locked OCP workspace dependencies"
  (cd "$root" && bun install --frozen-lockfile) || pi_family_dev_die "OCP dependency install failed"
  echo "pi-family-dev: building local pi-bridge"
  (cd "$bridge" && bun run build) || pi_family_dev_die "pi-bridge build failed"

  echo "pi-family-dev: installing local provider dependencies"
  if [[ -f "$provider/bun.lock" ]]; then
    (cd "$provider" && bun install --frozen-lockfile) || pi_family_dev_die "provider dependency install failed"
  elif [[ -f "$provider/package-lock.json" ]]; then
    command -v npm >/dev/null 2>&1 || pi_family_dev_die "npm is required by $provider/package-lock.json"
    (cd "$provider" && npm ci) || pi_family_dev_die "provider dependency install failed"
  else
    (cd "$provider" && bun install) || pi_family_dev_die "provider dependency install failed"
  fi
  echo "pi-family-dev: building local provider"
  (cd "$provider" && bun run build) || pi_family_dev_die "provider build failed"

  [[ -f "$bridge/dist/extension.js" ]] || pi_family_dev_die "pi-bridge shared entry missing after build"
  [[ -f "$bridge/dist/extension-pi.js" ]] || pi_family_dev_die "pi-bridge Pi entry missing after build"
  [[ -f "$bridge/dist/extension-omp.js" ]] || pi_family_dev_die "pi-bridge OMP entry missing after build"
  [[ -f "$provider/dist/index.js" ]] || pi_family_dev_die "provider entry missing after build"
}

# Upsert only the selected provider. Other provider entries and all optional
# fields on the selected entry survive local/npm switching.
pi_family_dev_patch_config() {
  local config_file="$1"
  local package_specifier="$2"
  local plugin="$3"
  command -v bun >/dev/null 2>&1 || pi_family_dev_die "bun is required to patch pi-bridge config"

  bun - "$config_file" "$package_specifier" "$plugin" <<'BUN'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const [configPath, packageSpecifier, pluginName] = process.argv.slice(2)

let raw = "{}"
let mode = 0o600
if (existsSync(configPath)) {
  raw = readFileSync(configPath, "utf8")
  mode = statSync(configPath).mode & 0o777
} else {
  mkdirSync(dirname(configPath), { recursive: true })
}

const data = JSON.parse(raw)
if (data.providers !== undefined && !Array.isArray(data.providers)) {
  throw new Error(`pi-family-dev: ${configPath} has a non-array "providers" field`)
}
const providers = data.providers ?? []

function installedPackageName(specifier) {
  if (specifier === pluginName) return pluginName
  let candidate
  try {
    candidate = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier
  } catch {
    return undefined
  }
  if (!candidate.startsWith("/")) return undefined
  candidate = resolve(candidate)
  for (let depth = 0; depth < 5; depth += 1) {
    const packageJson = join(candidate, "package.json")
    if (existsSync(packageJson)) {
      try {
        return JSON.parse(readFileSync(packageJson, "utf8")).name
      } catch {
        return undefined
      }
    }
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return undefined
}

const matching = []
for (let index = 0; index < providers.length; index += 1) {
  const entry = providers[index]
  if (entry && typeof entry === "object") {
    const currentSpecifier = typeof entry.package === "string" ? entry.package : entry.packageSpecifier
    if (typeof currentSpecifier === "string" && installedPackageName(currentSpecifier) === pluginName) matching.push(index)
  }
}

if (matching.length === 0) {
  providers.push({ package: packageSpecifier })
} else {
  const first = matching[0]
  const replacement = { ...providers[first], package: packageSpecifier }
  delete replacement.packageSpecifier
  providers[first] = replacement
  for (let index = matching.length - 1; index >= 1; index -= 1) providers.splice(matching[index], 1)
}
data.providers = providers

const temporary = `${configPath}.tmp-${process.pid}`
writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode })
chmodSync(temporary, mode)
renameSync(temporary, configPath)
console.log(`pi-family-dev: wrote ${packageSpecifier} into ${configPath}`)
BUN
}

# A checkout is resolved from its real path, outside the host CLI's package
# tree. Link the one host-provided runtime peer into that checkout so the
# bridge's lazy dynamic import is deterministic on both hosts.
pi_family_dev_link_host_ai() {
  local host="$1"
  local host_cli="$2"
  local bridge="$3"
  local ai_package cli_real nested hoisted source target
  case "$host" in
    pi) ai_package="@earendil-works/pi-ai" ;;
    omp) ai_package="@oh-my-pi/pi-ai" ;;
    *) pi_family_dev_die "unknown host: $host" ;;
  esac

  cli_real="$(bun -e 'import { realpathSync } from "node:fs"; console.log(realpathSync(process.argv[1]))' "$host_cli")"
  nested="$(dirname "$cli_real")/../node_modules/${ai_package}"
  hoisted="$(dirname "$cli_real")/../../../${ai_package}"
  if [[ -f "$nested/package.json" ]]; then
    source="$(cd "$nested" && pwd -P)"
  elif [[ -f "$hoisted/package.json" ]]; then
    source="$(cd "$hoisted" && pwd -P)"
  else
    pi_family_dev_die "cannot locate ${ai_package} beside host CLI ${cli_real}"
  fi

  target="${bridge}/node_modules/${ai_package}"
  mkdir -p "$(dirname "$target")"
  if [[ -d "$target" && ! -L "$target" && -f "$target/package.json" ]]; then
    echo "pi-family-dev: ${ai_package} already resolves inside local pi-bridge"
    return 0
  fi
  if [[ -e "$target" && ! -L "$target" ]]; then
    pi_family_dev_die "refusing to replace non-package host peer target: $target"
  fi
  if [[ -L "$target" ]]; then rm -f "$target"; fi
  ln -s "$source" "$target"
  echo "pi-family-dev: ${ai_package} → host runtime ${source}"
}

pi_family_dev_pi_remove_if_present() {
  local host_cli="$1"
  local source="$2"
  local output
  if output="$("$host_cli" remove "$source" 2>&1)"; then
    [[ -n "$output" ]] && echo "$output"
    return 0
  fi
  if [[ "$output" == *"No matching package found"* ]]; then
    return 0
  fi
  echo "$output" >&2
  pi_family_dev_die "failed to remove Pi package source: $source"
}

pi_family_dev_omp_remove_if_present() {
  local host_cli="$1"
  local package_name="$2"
  local installed
  installed="$("$host_cli" plugin list --json 2>/dev/null)" || pi_family_dev_die "failed to list OMP plugins"
  if [[ "$installed" == *"\"${package_name}\""* ]]; then
    "$host_cli" plugin uninstall "$package_name"
  fi
}

pi_family_dev_install_local() {
  local host="$1"
  local host_cli="$2"
  local bridge="$3"
  local provider="$4"
  local plugin="$5"

  pi_family_dev_link_host_ai "$host" "$host_cli" "$bridge"

  case "$host" in
    pi)
      pi_family_dev_pi_remove_if_present "$host_cli" "npm:@opencode-compat/pi-bridge"
      pi_family_dev_pi_remove_if_present "$host_cli" "npm:${plugin}"
      "$host_cli" install "$bridge"
      ;;
    omp)
      pi_family_dev_omp_remove_if_present "$host_cli" "@opencode-compat/pi-bridge"
      pi_family_dev_omp_remove_if_present "$host_cli" "$plugin"
      "$host_cli" plugin install "$bridge"
      ;;
    *) pi_family_dev_die "unknown host: $host" ;;
  esac

  pi_family_dev_patch_config "$(pi_family_dev_config_file "$host")" "$provider/dist/index.js" "$plugin"
}

pi_family_dev_install_npm() {
  local host="$1"
  local host_cli="$2"
  local bridge="$3"
  local plugin="$4"
  local bridge_version="${OCP_DEV_BRIDGE_VERSION:-latest}"
  local plugin_version="${OCP_DEV_PLUGIN_VERSION:-latest}"

  case "$host" in
    pi)
      pi_family_dev_pi_remove_if_present "$host_cli" "$bridge"
      "$host_cli" install "npm:@opencode-compat/pi-bridge@${bridge_version}"
      "$host_cli" install "npm:${plugin}@${plugin_version}"
      ;;
    omp)
      pi_family_dev_omp_remove_if_present "$host_cli" "@opencode-compat/pi-bridge"
      pi_family_dev_omp_remove_if_present "$host_cli" "$plugin"
      "$host_cli" plugin install "@opencode-compat/pi-bridge@${bridge_version}" --force
      "$host_cli" plugin install "${plugin}@${plugin_version}" --force
      ;;
    *) pi_family_dev_die "unknown host: $host" ;;
  esac

  # Import specifiers do not include npm versions; the host package manager owns
  # the pin while the bridge loads the installed package by its bare name.
  pi_family_dev_patch_config "$(pi_family_dev_config_file "$host")" "$plugin" "$plugin"
}

pi_family_dev_usage() {
  local name="$1"
  cat <<EOF
Usage: ${name} <local|npm>

  local   Build this pi-bridge checkout and a local provider checkout, register
          the bridge through the host's native installer, and point pi-bridge.json
          at the provider's absolute dist/index.js.
  npm     Install the published pi-bridge and provider packages, then point
          pi-bridge.json at the provider's bare npm package name.

Environment:
  OCP_DEV_PROVIDER_PATH     Local provider checkout (default: sibling or ~/Projects)
  OCP_DEV_PLUGIN            Provider npm name (default: cursor-opencode-provider)
  OCP_DEV_BRIDGE_VERSION    npm bridge version (default: latest)
  OCP_DEV_PLUGIN_VERSION    npm provider version (default: latest)
  PI_BRIDGE_CONFIG          Explicit pi-bridge.json path
  PI_CODING_AGENT_DIR       Host agent dir used when PI_BRIDGE_CONFIG is unset

EOF
}

pi_family_dev_main() {
  local host="$1"
  shift
  local command="${1:-}"
  case "$command" in
    -h | --help | help | "")
      pi_family_dev_usage "${host}-dev.sh"
      return 0
      ;;
    local | --local | npm | --npm) ;;
    *) pi_family_dev_die "unknown command: $command (expected local or npm)" ;;
  esac

  local root bridge provider plugin host_cli config_file mode mode_label
  root="$(pi_family_dev_repo_root)"
  bridge="$(pi_family_dev_bridge_path "$root")"
  plugin="$(pi_family_dev_plugin_name)"
  host_cli="$(pi_family_dev_resolve_host_cli "$host")"
  config_file="$(pi_family_dev_config_file "$host")"
  mode="${command#--}"

  pi_family_dev_assert_package_dir "$bridge" "pi-bridge"
  if [[ "$mode" == "local" ]]; then
    provider="$(pi_family_dev_default_provider_path "$root")"
    pi_family_dev_assert_package_dir "$provider" "provider"
    pi_family_dev_prepare_local "$root" "$bridge" "$provider"
    pi_family_dev_install_local "$host" "$host_cli" "$bridge" "$provider" "$plugin"
  else
    pi_family_dev_install_npm "$host" "$host_cli" "$bridge" "$plugin"
  fi

  if [[ "$mode" == "local" ]]; then mode_label="LOCAL"; else mode_label="NPM"; fi
  echo ""
  echo "pi-family-dev: ${host} is on ${mode_label} pi-bridge + ${mode_label} ${plugin}"
  echo "  config: ${config_file}"
  echo "  verify: restart ${host}, then open its model picker"
  echo "  switch: ${root}/scripts/${host}-dev.sh $([[ "$mode" == "local" ]] && echo npm || echo local)"
}
