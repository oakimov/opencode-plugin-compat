#!/usr/bin/env bash
# oh-my-pi development entrypoint. Uses OMP's native plugin manager, not clone facades.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/pi-family-dev-common.sh
source "$ROOT/scripts/pi-family-dev-common.sh"

pi_family_dev_main omp "$@"
