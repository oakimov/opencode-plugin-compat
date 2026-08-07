#!/usr/bin/env bash
# MiMo local-dev entrypoint. Logic lives in scripts/host-dev-common.sh
# (`local` rebuilds provider stock + drops stale index.ocp-original.js before ocp setup).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OCP_DEV_ROOT="$ROOT"
# shellcheck source=scripts/host-dev-common.sh
source "$ROOT/scripts/host-dev-common.sh"

host_dev_main mimo "$@"
