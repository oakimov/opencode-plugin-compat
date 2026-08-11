#!/usr/bin/env bash
# Pi development entrypoint. Uses Pi's native package manager, not clone facades.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/pi-family-dev-common.sh
source "$ROOT/scripts/pi-family-dev-common.sh"

pi_family_dev_main pi "$@"
