#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap. .cursor/environment.json install is this
# file, so a build of main does not need this path to exist.
# Installs Bun and the workspace tools needed for isolated install/build/test.
# There is no OpenCode dual install and no live plugin path in this repository.

install_main() {
  set -euo pipefail
  export PYTHONDONTWRITEBYTECODE=1
  export DEBIAN_FRONTEND=noninteractive

  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" && "$(basename "$(dirname "${BASH_SOURCE[0]}")")" == "scripts" ]]; then
    ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  else
    ROOT="$(pwd)"
  fi
  cd "$ROOT"

  if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
    curl -fsSL https://bun.sh/install | bash
  fi
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  # Workspace build/typecheck scripts call bunx. Bun selects that entry point
  # from argv[0], and scripts/isolated-check.sh mounts it by this name.
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bunx

  if ! command -v zsh >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y zsh
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y openssl
  fi

  /usr/local/bin/bun install --frozen-lockfile
  /usr/local/bin/bun run build
  # Workspace packages emit under packages/*/dist.
  if ! ls "$ROOT"/packages/*/dist/*.js >/dev/null 2>&1; then
    echo "Missing packages/*/dist after build." >&2
    exit 1
  fi

  echo "Bun $(/usr/local/bin/bun --version)"
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_main "$@"
fi
