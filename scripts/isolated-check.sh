#!/usr/bin/env bash
# Run a contributor tree's install, build, typecheck, unit tests, and
# architecture checks where the command cannot see reviewer files. This is
# not the review.
#
#   scripts/isolated-check.sh <pr-number|https://github.com/owner/repo/pull/N>
#
# The pull request is fetched and copied with git archive of that commit id,
# not the moving FETCH_HEAD name. There is no linked worktree and no parent
# git directory. scripts/isolate-run.sh runs the
# commands. A URL whose owner or repository is not this checkout's origin is
# refused before fetch.
#
# There is no --live path. Interactive stock-host acceptance stays a manual
# evidence requirement outside this boundary.
#
# Exit 0 when the checks pass, 1 when a check fails, 2 when the invocation
# or the isolation mechanism is unusable, and 128 plus the signal number when
# TERM, INT, HUP, or QUIT cancels a check. A cancelled check waits for the
# boundary to stop before it removes the archive.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/isolate-run.sh
source "$ROOT/scripts/isolate-run.sh"

worktree=""
isolate_home=""
isolate_tmp=""
pr=""
pr_slug=""
origin_slug=""

check_cleanup() {
  cd "$ROOT" 2>/dev/null || true
  if [[ -n "$worktree" ]]; then
    rm -rf "$worktree"
    worktree=""
  fi
  if [[ -n "$isolate_home" ]]; then
    rm -rf "$isolate_home"
    isolate_home=""
  fi
  if [[ -n "$isolate_tmp" ]]; then
    rm -rf "$isolate_tmp"
    isolate_tmp=""
  fi
}

usage() {
  echo "Usage: scripts/isolated-check.sh <pr-number|pr-url>" >&2
  exit 2
}

check_origin_slug() {
  local url slug
  url="$(git -C "$ROOT" remote get-url origin)"
  slug="$(isolate_github_slug "$url")" || return 1
  origin_slug="$slug"
}

# Sets pr from a pull number or a canonical GitHub pull URL.
# A URL must name this checkout's origin. Returns 1 for anything else.
check_parse_target() {
  local input="$1" owner repo
  pr=""
  pr_slug=""
  if [[ "$input" =~ ^[0-9]+$ ]]; then
    pr="$input"
    return 0
  fi
  if [[ "$input" =~ ^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+)([/?#].*)?$ ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    pr="${BASH_REMATCH[3]}"
    pr_slug="${owner}/${repo}"
    check_origin_slug || return 1
    if [[ "$pr_slug" != "$origin_slug" ]]; then
      echo "Refusing ${pr_slug}; this checkout's origin is ${origin_slug}." >&2
      return 1
    fi
    return 0
  fi
  return 1
}

check_begin_sandbox() {
  if [[ -z "$isolate_home" ]]; then
    isolate_home="$(mktemp -d "${TMPDIR:-/tmp}/ocp-pr-home.XXXXXX")"
  fi
  if [[ -z "$isolate_tmp" ]]; then
    isolate_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ocp-pr-tmp.XXXXXX")"
  fi
}

check_child=""
check_signal=""

# Record the first cancellation signal and ask isolate-run.sh to stop. A
# background job cannot trap INT or QUIT, so the request is always TERM.
check_note_signal() {
  [[ -n "$check_signal" ]] || check_signal="$1"
  [[ -z "$check_child" ]] || kill -s TERM "$check_child" 2>/dev/null || true
}

# Run a command inside the filesystem and process boundary. The root and
# package build/typecheck scripts call bunx, so it is mounted beside bun;
# isolate-run.sh binds each tool under its requested name, which bun uses to
# select its bunx entry point.
#
# isolate-run.sh runs in the background so that TERM, INT, HUP, or QUIT sent
# only to this shell is passed on, and this shell waits until the boundary
# has stopped. Only then does the cancelled check exit with 128 plus the
# signal number, and its EXIT trap remove the archive. isolate-run.sh, not
# this shell, kills a boundary that ignores the request.
check_run_isolated() {
  local status
  check_signal=""
  check_child=""
  trap 'check_note_signal TERM' TERM
  trap 'check_note_signal INT' INT
  trap 'check_note_signal HUP' HUP
  trap 'check_note_signal QUIT' QUIT
  "$ROOT/scripts/isolate-run.sh" --src "${ISOLATE_SRC:-$PWD}" \
    --tool bun --tool bunx --tool node --tool git --tool python3 -- "$@" <&0 &
  check_child=$!
  [[ -z "$check_signal" ]] || kill -s TERM "$check_child" 2>/dev/null || true
  while :; do
    wait "$check_child"
    status=$?
    kill -0 "$check_child" 2>/dev/null || break
  done
  check_child=""
  trap - TERM INT HUP QUIT
  if [[ -n "$check_signal" ]]; then
    echo "Check cancelled by SIG${check_signal}." >&2
    exit $((128 + $(kill -l "$check_signal")))
  fi
  return "$status"
}

check_step() {
  local label="$1"
  shift
  local code=0
  set +e
  check_run_isolated "$@"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
    return 0
  fi
  if [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
    return 2
  fi
  echo "${label}=failed exit=${code}"
  return 1
}

check_main() {
  cd "$ROOT"
  local target="" arg
  for arg in "$@"; do
    case "$arg" in
      --live)
        echo "This repository has no --live isolated check. Interactive stock-host acceptance is manual." >&2
        usage
        ;;
      --help|-h) usage ;;
      -*) usage ;;
      *)
        [[ -z "$target" ]] || usage
        target="$arg"
        ;;
    esac
  done
  [[ -n "$target" ]] || usage
  check_parse_target "$target" || usage

  trap check_cleanup EXIT
  git fetch --no-tags origin "pull/${pr}/head"
  local fetched
  fetched="$(git -C "$ROOT" rev-parse --verify FETCH_HEAD)"
  echo "Check commit: $fetched"
  if [[ -n "${CURSOR_REVIEW_TRUST_SHA:-}" ]]; then
    if [[ ! "${CURSOR_REVIEW_TRUST_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "CURSOR_REVIEW_TRUST_SHA must be 40 lowercase hex characters." >&2
      exit 2
    fi
    if [[ "${CURSOR_REVIEW_TRUST_SHA}" != "$fetched" ]]; then
      echo "Fetched ${fetched}, not the trusted ${CURSOR_REVIEW_TRUST_SHA}. Refusing to archive or run it." >&2
      exit 2
    fi
  fi
  worktree="$(mktemp -d "${TMPDIR:-/tmp}/ocp-pr-check-${pr}.XXXXXX")"
  # Archive the recorded commit. FETCH_HEAD can move while git archive runs.
  git -C "$ROOT" archive "$fetched" | tar -x -C "$worktree"
  if [[ -e "$worktree/.git" ]]; then
    echo "The fetched tree contains git metadata. Refusing to run it." >&2
    exit 2
  fi
  cd "$worktree"

  echo "Check root: $worktree"
  echo "Pull request: $pr"
  local checks=0
  check_step INSTALL bun install --frozen-lockfile --ignore-scripts || checks=$?
  if [[ "$checks" -eq 2 ]]; then
    echo "ISOLATION=unavailable"
    exit 2
  fi
  if [[ "$checks" -eq 0 ]]; then
    check_step BUILD bun run build || checks=$?
    if [[ "$checks" -eq 0 ]]; then
      check_step TYPECHECK bun run typecheck || checks=$?
    fi
    if [[ "$checks" -eq 0 ]]; then
      check_step UNIT_TESTS bun test ./test || checks=$?
    fi
    if [[ "$checks" -eq 0 ]]; then
      check_step ARCHITECTURE bun test ./test/architecture.test.ts || checks=$?
    fi
    if [[ "$checks" -eq 2 ]]; then
      echo "ISOLATION=unavailable"
      exit 2
    fi
  fi

  echo "CHECK_SUMMARY pr=${pr} checks=${checks}"
  if [[ "$checks" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_main "$@"
fi
