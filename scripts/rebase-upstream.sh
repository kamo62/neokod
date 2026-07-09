#!/usr/bin/env bash
#
# rebase-upstream.sh — rebase this fork's current org/* branch onto the
# latest upstream T3 Code release, then verify the fork still builds.
#
# What it does, in order:
#   1. Refuses to run against tracked working tree changes or a non-fork branch.
#   2. Fetches the `upstream` remote (tags + branches).
#   3. Picks a rebase target: an explicit `--target <ref>` when provided,
#      otherwise the highest non-nightly `vX.Y.Z` tag reachable from
#      `upstream/main`, falling back to `upstream/main` itself when no such
#      tag exists.
#   4. Records a safety ref (a plain branch, nothing destructive) pointing
#      at the pre-rebase HEAD.
#   5. Runs `git rebase <target>`.
#      - On conflict: stops, lists every conflicting file, cross-references
#        each one against FORK.md (the conflict map — see that file for
#        what each fork-owned edit looks like and why it's there), and
#        exits non-zero. It never force-resolves, never runs
#        `git rebase --abort` on the user's behalf, and never pushes.
#        Resolve by hand and run `git rebase --continue`, or bail out with
#        `git rebase --abort` — both are left to the operator.
#      - On success: runs `vp check` and `vp run typecheck` (via the
#        repo-local ./node_modules/.bin/vp) and reports the result.
#
# Usage: scripts/rebase-upstream.sh [--target <ref>]
#
#   --target <ref>   Rebase onto this exact ref (e.g. upstream/main or a tag)
#                    instead of auto-detecting the latest release tag.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORK_MANIFEST="FORK.md"
UPSTREAM_REMOTE="upstream"
VP="$REPO_ROOT/node_modules/.bin/vp"

TARGET_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { printf '\nERROR: --target requires a ref argument.\n' >&2; exit 1; }
      TARGET_OVERRIDE="$2"
      shift 2
      ;;
    --target=*)
      TARGET_OVERRIDE="${1#--target=}"
      shift
      ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; /^set -euo/d'
      exit 0
      ;;
    *)
      printf '\nERROR: unknown argument: %s (see --help)\n' "$1" >&2
      exit 1
      ;;
  esac
done

log() { printf '\n==> %s\n' "$1"; }
fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required."
[[ -x "$VP" ]] || fail "repo-local vp not found at $VP. Run the package install first (pnpm install)."

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "Tracked working tree changes are present. Commit or stash them before rebasing."
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != org/* ]]; then
  fail "Expected to be on an org/* fork branch (currently on '$CURRENT_BRANCH'). Refusing to rebase a branch that doesn't look like a fork branch."
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  fail "No '$UPSTREAM_REMOTE' remote configured. Add it with: git remote add $UPSTREAM_REMOTE <upstream-url>"
fi

log "Fetching $UPSTREAM_REMOTE (tags + branches)..."
git fetch "$UPSTREAM_REMOTE" --tags --prune

if [[ -n "$TARGET_OVERRIDE" ]]; then
  git rev-parse --verify --quiet "$TARGET_OVERRIDE^{commit}" >/dev/null \
    || fail "--target '$TARGET_OVERRIDE' is not a resolvable ref (did you fetch it?)."
  REBASE_TARGET="$TARGET_OVERRIDE"
  log "Rebase target: $REBASE_TARGET (explicit --target)"
else
  log "Resolving the latest upstream release..."
  # Prefer the highest non-nightly vX.Y.Z tag reachable from upstream/main.
  # Nightlies are not curated release points, so they're excluded even
  # though they're the most common tag on this repo day-to-day.
  LATEST_TAG="$(git tag -l 'v*' --merged "$UPSTREAM_REMOTE/main" 2>/dev/null | grep -v -- '-nightly' | sort -V | tail -n1)" || true

  if [[ -n "${LATEST_TAG:-}" ]]; then
    REBASE_TARGET="$LATEST_TAG"
    log "Rebase target: tag $REBASE_TARGET"
  else
    REBASE_TARGET="$UPSTREAM_REMOTE/main"
    log "No non-nightly release tag found reachable from $UPSTREAM_REMOTE/main; falling back to $REBASE_TARGET"
  fi
fi

BACKUP_BRANCH="pre-rebase-$(echo "$CURRENT_BRANCH" | tr '/' '-')-$(date +%Y%m%d%H%M%S)"
log "Recording a safety ref: $BACKUP_BRANCH (nothing is force-pushed or discarded)"
git branch "$BACKUP_BRANCH" HEAD

log "Rebasing $CURRENT_BRANCH onto $REBASE_TARGET..."
if ! git rebase "$REBASE_TARGET"; then
  echo
  echo "----------------------------------------------------------------"
  echo "Rebase stopped with conflicts. Nothing was force-resolved."
  echo
  echo "Conflicting files:"
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  echo "$CONFLICTS" | sed 's/^/  - /'
  echo
  echo "Cross-referencing against $FORK_MANIFEST..."
  if [[ -f "$FORK_MANIFEST" ]]; then
    while IFS= read -r conflicted_file; do
      [[ -z "$conflicted_file" ]] && continue
      if grep -qF "$conflicted_file" "$FORK_MANIFEST"; then
        echo "  [in FORK.md] $conflicted_file — a known fork edit; see $FORK_MANIFEST for the expected shape of the change and reapply it on top of upstream's version."
      else
        echo "  [NOT in FORK.md] $conflicted_file — unexpected. Either FORK.md is stale, or upstream touched a file we didn't know we'd modified. Investigate before resolving."
      fi
    done <<<"$CONFLICTS"
  else
    echo "  ($FORK_MANIFEST not found at repo root — cannot cross-reference conflicts.)"
  fi
  echo
  echo "Next steps (both left to you — this script does neither automatically):"
  echo "  - Resolve conflicts, 'git add' the files, then: git rebase --continue"
  echo "  - Or give up on this attempt: git rebase --abort"
  echo
  echo "Pre-rebase safety ref: $BACKUP_BRANCH"
  echo "  (delete once you no longer need it: git branch -D $BACKUP_BRANCH)"
  echo "----------------------------------------------------------------"
  exit 1
fi

log "Rebase completed cleanly onto $REBASE_TARGET."

log "Running format/lint/type checks (vp check)..."
if ! "$VP" check; then
  fail "vp check failed after a clean rebase. The rebase itself succeeded (see $BACKUP_BRANCH for the pre-rebase state if you need to compare); fix the reported errors on $CURRENT_BRANCH before merging or pushing."
fi

log "Running typecheck (vp run typecheck)..."
if ! "$VP" run typecheck; then
  fail "Typecheck failed after a clean rebase. The rebase itself succeeded (see $BACKUP_BRANCH for the pre-rebase state if you need to compare); fix the reported errors on $CURRENT_BRANCH before merging or pushing."
fi

log "Rebase onto $REBASE_TARGET verified: vp check and typecheck are green."
log "Safety ref for the pre-rebase state: $BACKUP_BRANCH (delete it once you're confident: git branch -D $BACKUP_BRANCH)"
