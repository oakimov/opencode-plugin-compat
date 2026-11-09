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
  # Non-interactive bash skips the installer's ~/.bashrc PATH edit, and the
  # isolate-run PATH is /opt/tools:/usr/bin:/bin:/usr/sbin. /usr/local/bin is
  # not on that PATH, and a symlink from there into $HOME is not mounted.
  # Copy the binary into /usr/bin, which both search, and point bunx at it.
  # Workspace build/typecheck scripts call bunx; Bun selects that entry from argv[0].
  sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/bin/bun
  sudo ln -sfn bun /usr/bin/bunx
  sudo ln -sfn /usr/bin/bun /usr/local/bin/bun
  sudo ln -sfn /usr/bin/bun /usr/local/bin/bunx

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
