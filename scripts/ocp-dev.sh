#!/usr/bin/env bash
# Wire or restore OCP + cursor-opencode-provider on stock hosts.
# Logic lives in scripts/ocp-dev/*.ts — this file is the only shell entrypoint.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OCP_DEV_ROOT="$ROOT"
exec bun "$ROOT/scripts/ocp-dev/cli.ts" "$@"
