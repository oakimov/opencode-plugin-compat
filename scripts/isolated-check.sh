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
# After typecheck, the harness-owned contracts scripts/review-*-contracts.mjs
# run read-only against the archived subject (BOUNDARY, CATALOG, ZCODE). Each
# also runs on the merge base of the head and the pull request's base, in the
# same secret-free boundary. A contract diagnostic that already fails there is
# pre-existing: it is logged and does not fail this run.
#
# Exit 0 when install, build, typecheck, unit tests, and every contract
# failure the pull request introduces pass. Exit 1 when a check the pull
# request introduces fails, 2 when the invocation or the isolation mechanism
# is unusable, and 128 plus the signal number when TERM, INT, HUP, or QUIT
# cancels a check. A cancelled check waits for the boundary to stop before it
# removes the archive. SIGKILL of this script cannot be forwarded and can
# leave the boundary running.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/isolate-run.sh
source "$ROOT/scripts/isolate-run.sh"

worktree=""
base_tree=""
base_ready=0
base_attempted=0
compare_dir=""
check_fetched=""
check_new=0
check_preexisting=0
check_blocking=""
isolate_home=""
isolate_tmp=""
isolate_contracts=""
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
  if [[ -n "$base_tree" ]]; then
    rm -rf "$base_tree"
    base_tree=""
  fi
  if [[ -n "$compare_dir" ]]; then
    rm -rf "$compare_dir"
    compare_dir=""
  fi
  if [[ -n "$isolate_contracts" ]]; then
    rm -rf "$isolate_contracts"
    isolate_contracts=""
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

# Private, read-only copies of this checkout's contract scripts. The subject's
# own scripts/ cannot replace a check it is judged by.
check_contract_scripts() {
  local file
  if [[ -z "$isolate_contracts" ]]; then
    isolate_contracts="$(mktemp -d "${TMPDIR:-/tmp}/ocp-review-contracts.XXXXXX")"
    for file in review-boundary-contracts.mjs review-catalog-contracts.mjs review-zcode-contracts.mjs; do
      cp "$ROOT/scripts/$file" "$isolate_contracts/$file" || return 2
    done
  fi
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
  local -a contracts=()
  # check_main creates the copy under its EXIT trap; a direct caller has none.
  [[ -z "$isolate_contracts" ]] || contracts=(--ro-bind "$isolate_contracts:/opt/harness/scripts")
  check_signal=""
  check_child=""
  trap 'check_note_signal TERM' TERM
  trap 'check_note_signal INT' INT
  trap 'check_note_signal HUP' HUP
  trap 'check_note_signal QUIT' QUIT
  "$ROOT/scripts/isolate-run.sh" --src "${ISOLATE_SRC:-$PWD}" \
    --tool bun --tool bunx --tool node --tool git --tool python3 \
    ${contracts[@]+"${contracts[@]}"} -- "$@" <&0 &
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

check_note_blocking() {
  local label="$1"
  case ",${check_blocking}," in
    *",${label},"*) ;;
    *) check_blocking="${check_blocking:+$check_blocking,}${label}" ;;
  esac
}

check_pr_base_sha() {
  local slug sha
  if [[ -z "$origin_slug" ]]; then
    check_origin_slug || return 1
  fi
  slug="$origin_slug"
  sha="$(gh pr view "$pr" --repo "$slug" --json baseRefOid --jq .baseRefOid 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

# Archive the merge base and install plus build it in the same secret-free
# boundary as the head. A failure here cannot prove a head failure is old.
check_prepare_base() {
  local head="$1" base_sha merge code=0
  if [[ "$base_attempted" -eq 1 ]]; then
    [[ "$base_ready" -eq 1 ]]
    return
  fi
  base_attempted=1
  base_ready=0
  if [[ ! "$head" =~ ^[0-9a-f]{40}$ ]]; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if ! base_sha="$(check_pr_base_sha)"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if ! git -C "$ROOT" fetch --no-tags origin "$base_sha"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  merge="$(git -C "$ROOT" merge-base "$head" FETCH_HEAD 2>/dev/null || true)"
  if [[ ! "$merge" =~ ^[0-9a-f]{40}$ ]]; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  echo "Base commit: $merge"
  base_tree="$(mktemp -d "${TMPDIR:-/tmp}/ocp-pr-base-${pr}.XXXXXX")"
  if ! git -C "$ROOT" archive "$merge" | tar -x -C "$base_tree"; then
    echo "BASE_TREE=unavailable"
    return 1
  fi
  if [[ -e "$base_tree/.git" ]]; then
    echo "The merge base contains git metadata. It cannot classify contract failures." >&2
    echo "BASE_TREE=unavailable"
    return 1
  fi
  set +e
  CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated bun install --frozen-lockfile --ignore-scripts
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    echo "BASE_BUILD=failed exit=${code}"
    echo "BASE_TREE=unavailable"
    return 1
  fi
  set +e
  CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated bun run build
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    echo "BASE_BUILD=failed exit=${code}"
    echo "BASE_TREE=unavailable"
    return 1
  fi
  echo "BASE_TREE=prepared commit=${merge}"
  base_ready=1
  return 0
}

# A failure signature is the contract line that names the case and its
# detail, so identical counts on different cases cannot look inherited.
check_write_signatures() {
  local source="$1" dest="$2"
  : >"$dest"
  [[ -f "$source" ]] || return 0
  awk '
    /^[A-Z_]+_CONTRACT=[^[:space:]]+:failed([[:space:]]|$)/ { print $0; next }
    /^error:/ || /^Error:/ { print $0; next }
  ' "$source" | LC_ALL=C sort -u >"$dest"
}

# An early exit can leave a known failure in the log without running the rest
# of the contract. Require its final result and the corresponding process code.
check_contract_completed() {
  local label="$1" log="$2" code="$3" status
  case "$code" in
    0) status=passed ;;
    1) status=failed ;;
    *) return 1 ;;
  esac
  awk -v expected="REVIEW_CONTRACT_COMPLETE=${label}:${status}" '
    NF { last = $0 }
    /^REVIEW_CONTRACT_COMPLETE=/ { records++ }
    END { exit !(records == 1 && last == expected) }
  ' "$log"
}

# A case the completed base check passed must not disappear on the head: a
# skipped probe is not a pass when the base established the capability.
check_lost_contract_feature() {
  local base="$1" head="$2" lost
  lost="$(awk '
    FNR == NR {
      if (match($0, /^[A-Z_]+_CONTRACT=[^[:space:]]+:passed$/)) { sub(/:passed$/, ""); passed[$0] = 1 }
      next
    }
    match($0, /^[A-Z_]+_CONTRACT=[^[:space:]]+:skipped/) {
      key = $1; sub(/:skipped.*/, "", key)
      if (key in passed) print key ":failed capability disappeared"
    }
  ' "$base" "$head")"
  [[ -n "$lost" ]] || return 1
  printf '%s\n' "$lost"
}

check_print_signatures() {
  local prefix="$1" file="$2" line
  if [[ ! -s "$file" ]]; then
    echo "${prefix}=none"
    return 0
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    echo "${prefix}=${line}"
  done <"$file"
}

check_log_status() {
  local label="$1" code="$2"
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
  elif [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
  else
    echo "${label}=failed exit=${code}"
  fi
}

# Run one harness contract on the archived head and, when the merge base
# prepared, on that base. Both runs are secret-free. Only a head failure that
# is not already on the base fails this run.
check_contract_pair() {
  local label="$1"
  shift
  local head_log base_log head_code=0 base_code=0 head_sigs base_sigs new_sigs old_sigs lost_feature
  check_prepare_base "$check_fetched" || true
  mkdir -p "$compare_dir"
  head_log="$compare_dir/${label}.head"
  base_log="$compare_dir/${label}.base"
  head_sigs="$compare_dir/${label}.head.sig"
  base_sigs="$compare_dir/${label}.base.sig"
  new_sigs="$compare_dir/${label}.new"
  old_sigs="$compare_dir/${label}.old"
  set +e
  CHECK_TREE=head ISOLATE_SRC="${worktree:-$PWD}" check_run_isolated "$@" >"$head_log" 2>&1
  head_code=$?
  set -e
  echo "${label}_HEAD_BEGIN"
  cat "$head_log"
  echo "${label}_HEAD_END"
  if [[ "$head_code" -eq 2 ]]; then
    echo "${label}=unavailable"
    check_note_blocking "$label"
    return 2
  fi
  base_code=2
  if [[ "$base_ready" -eq 1 ]]; then
    set +e
    CHECK_TREE=base ISOLATE_SRC="$base_tree" check_run_isolated "$@" >"$base_log" 2>&1
    base_code=$?
    set -e
    echo "${label}_BASE_BEGIN"
    cat "$base_log"
    echo "${label}_BASE_END"
  fi
  if ! check_contract_completed "$label" "$head_log" "$head_code"; then
    echo "${label}_HEAD=incomplete exit=${head_code}"
    echo "${label}=failed exit=${head_code}"
    echo "${label}_NEW=unclassified"
    check_new=$((check_new + 1))
    check_note_blocking "$label"
    return 1
  fi
  if [[ "$base_ready" -eq 1 ]] && check_contract_completed "$label" "$base_log" "$base_code" &&
     lost_feature="$(check_lost_contract_feature "$base_log" "$head_log")"; then
    echo "${label}=failed exit=${head_code}"
    while IFS= read -r line; do echo "${label}_NEW=${line}"; done <<<"$lost_feature"
    check_new=$((check_new + 1))
    check_note_blocking "$label"
    return 1
  fi
  if [[ "$head_code" -eq 0 ]]; then
    echo "${label}=passed"
    if [[ "$base_ready" -eq 1 ]]; then
      check_log_status "${label}_BASE" "$base_code"
    else
      echo "${label}_BASE=unavailable"
    fi
    return 0
  fi
  check_write_signatures "$head_log" "$head_sigs"
  if [[ "$base_ready" -eq 1 && "$base_code" -eq 1 ]] &&
     check_contract_completed "$label" "$base_log" "$base_code"; then
    check_write_signatures "$base_log" "$base_sigs"
    LC_ALL=C comm -13 "$base_sigs" "$head_sigs" >"$new_sigs"
    LC_ALL=C comm -12 "$base_sigs" "$head_sigs" >"$old_sigs"
  else
    : >"$base_sigs"
    cp "$head_sigs" "$new_sigs"
    : >"$old_sigs"
  fi
  echo "${label}_HEAD=failed exit=${head_code}"
  if [[ "$base_ready" -ne 1 || "$base_code" -eq 2 ]]; then
    echo "${label}_BASE=unavailable"
  else
    check_log_status "${label}_BASE" "$base_code"
  fi
  # A nonzero result with no diagnostic is not proof that the base failed the
  # same way. An empty new-signature file is pre-existing only when the head
  # actually named its failures and each of those names is on the base.
  if [[ -s "$head_sigs" && ! -s "$new_sigs" ]]; then
    echo "${label}=pre-existing exit=${head_code}"
    check_print_signatures "${label}_NEW" "$new_sigs"
    check_print_signatures "${label}_PREEXISTING" "$old_sigs"
    check_preexisting=$((check_preexisting + 1))
    return 0
  fi
  echo "${label}=failed exit=${head_code}"
  if [[ -s "$head_sigs" ]]; then
    check_print_signatures "${label}_NEW" "$new_sigs"
    check_print_signatures "${label}_PREEXISTING" "$old_sigs"
  else
    echo "${label}_NEW=unclassified"
    echo "${label}_PREEXISTING=none"
  fi
  check_new=$((check_new + 1))
  check_note_blocking "$label"
  return 1
}

check_step() {
  local label="$1" code=0
  shift
  case "$label" in
    *_CONTRACTS)
      set +e
      check_contract_pair "$label" "$@"
      code=$?
      set -e
      return "$code"
      ;;
  esac
  set +e
  CHECK_TREE=head ISOLATE_SRC="${worktree:-$PWD}" check_run_isolated "$@"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    echo "${label}=passed"
    return 0
  fi
  if [[ "$code" -eq 2 ]]; then
    echo "${label}=unavailable"
    check_note_blocking "$label"
    return 2
  fi
  echo "${label}=failed exit=${code}"
  check_note_blocking "$label"
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
  if ! check_contract_scripts; then
    echo "Cannot copy the harness contract scripts." >&2
    exit 2
  fi
  git fetch --no-tags origin "pull/${pr}/head"
  local fetched
  fetched="$(git -C "$ROOT" rev-parse --verify FETCH_HEAD)"
  check_fetched="$fetched"
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
  compare_dir="$(mktemp -d "${TMPDIR:-/tmp}/ocp-pr-compare-${pr}.XXXXXX")"
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
      # These checks are independent once the subject builds. Preserve every
      # new failure while still collecting the other contracts and unit
      # results. An unavailable boundary stops immediately.
      local phase=0 step
      for step in \
        "BOUNDARY_CONTRACTS bun /opt/harness/scripts/review-boundary-contracts.mjs /src" \
        "CATALOG_CONTRACTS bun /opt/harness/scripts/review-catalog-contracts.mjs /src" \
        "ZCODE_CONTRACTS bun /opt/harness/scripts/review-zcode-contracts.mjs /src" \
        "UNIT_TESTS bun test ./test"; do
        [[ "$checks" -ne 2 ]] || break
        phase=0
        # shellcheck disable=SC2086 # each entry is a fixed word list
        check_step $step || phase=$?
        if [[ "$phase" -gt "$checks" ]]; then checks="$phase"; fi
      done
    fi
    if [[ "$checks" -eq 2 ]]; then
      echo "ISOLATION=unavailable"
      exit 2
    fi
  fi

  echo "CHECK_SUMMARY pr=${pr} checks=${checks} new_contracts=${check_new} preexisting_contracts=${check_preexisting} blocking=${check_blocking:-none}"
  if [[ "$checks" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_main "$@"
fi
