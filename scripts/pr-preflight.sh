#!/usr/bin/env bash
# Pre-merge check for one branch (AGENTS.md §9 item 22). Run from the main checkout, after
# `git pull --ff-only` on main and before `gh pr merge`:
#
#   scripts/pr-preflight.sh task/<name>            # base defaults to main
#   scripts/pr-preflight.sh task/<name> main
#
# It never changes the branch, main or your working tree. It:
#   1. fetches origin (main and the branch);
#   2. checks the open PR for the branch targets the base (a stacked PR merged into another
#      branch never reaches main: PR #42);
#   3. checks the pushed branch is the local branch (nothing unpushed, nothing newer upstream);
#   4. trial-merges origin/<base> into the branch in a throwaway detached worktree and lists
#      conflicted files, then removes the worktree;
#   5. says whether the branch is behind the base (tests ran on an older base).
# Exit 0: safe to merge. Exit 1: fix first (printed). Exit 2: usage or environment problem.
set -uo pipefail

branch="${1:-}"
base="${2:-main}"
if [[ -z "$branch" ]]; then
  echo "usage: scripts/pr-preflight.sh <branch> [base]" >&2
  exit 2
fi
top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "preflight: run inside the repository" >&2; exit 2; }
cd "$top" || exit 2

problems=0
say() { printf '%s\n' "$*"; }
bad() { printf 'FIX FIRST: %s\n' "$*"; problems=$((problems + 1)); }

# 1. fetch
if ! git fetch --quiet origin "$base" "$branch" 2>/dev/null; then
  if ! git fetch --quiet origin "$base"; then
    echo "preflight: cannot fetch origin/$base" >&2
    exit 2
  fi
  bad "origin/$branch does not exist: push the branch first (git push -u origin $branch)"
fi

# 2. the PR targets the base
if command -v gh >/dev/null 2>&1; then
  pr_line="$(gh pr list --head "$branch" --state open --json number,baseRefName \
    --jq '.[0] | select(.) | "\(.number) \(.baseRefName)"' 2>/dev/null || true)"
  if [[ -z "$pr_line" ]]; then
    say "note: no open PR for $branch yet (create it with --base $base)"
  else
    pr_number="${pr_line%% *}"
    pr_base="${pr_line#* }"
    if [[ "$pr_base" != "$base" ]]; then
      bad "PR #$pr_number targets '$pr_base', not '$base' (stacked PR). Fix: gh pr edit $pr_number --base $base"
    else
      say "ok: PR #$pr_number targets $base"
    fi
  fi
else
  say "note: gh not found; PR base not checked"
fi

remote_ref="refs/remotes/origin/$branch"
if git show-ref --verify --quiet "$remote_ref"; then
  # 3. local branch vs pushed branch
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    local_sha="$(git rev-parse "refs/heads/$branch")"
    remote_sha="$(git rev-parse "$remote_ref")"
    if [[ "$local_sha" != "$remote_sha" ]]; then
      if git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
        bad "local $branch has commits not pushed: git push origin $branch"
      else
        bad "origin/$branch has commits your local branch lacks (or they diverged): compare before merging"
      fi
    fi
  fi

  # 4. trial merge in a throwaway worktree (main checkout and branch worktrees untouched)
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pr-preflight.XXXXXX")"
  cleanup() {
    git worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"
    git worktree prune >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  if ! git worktree add --quiet --detach "$tmp" "$remote_ref" >/dev/null 2>&1; then
    echo "preflight: could not create a temporary worktree" >&2
    exit 2
  fi
  if git -C "$tmp" -c user.name=preflight -c user.email=preflight@invalid \
      merge --no-commit --no-ff --quiet "origin/$base" >/dev/null 2>&1; then
    say "ok: origin/$branch merges cleanly with origin/$base"
  else
    conflicted="$(git -C "$tmp" diff --name-only --diff-filter=U)"
    if [[ -z "$conflicted" ]]; then
      bad "trial merge failed without a conflict list (run it by hand)"
    else
      bad "merge conflicts with origin/$base in:"
      printf '    %s\n' $conflicted
      say "  Fix (paste to the session's agent, in its worktree): git merge main; resolve; rerun the gates; commit 'merge main'."
      say "  Shared ledger files (STATUS_BOARD.md, TASK*.md, package.json scripts): keep main's lines and re-apply only this session's own lines."
    fi
  fi
  git -C "$tmp" merge --abort >/dev/null 2>&1 || true

  # 5. behind the base?
  behind="$(git rev-list --count "$remote_ref..origin/$base")"
  if [[ "$behind" != "0" ]]; then
    shared="$(comm -12 \
      <(git diff --name-only "$(git merge-base "$remote_ref" "origin/$base")" "origin/$base" | sort) \
      <(git diff --name-only "$(git merge-base "$remote_ref" "origin/$base")" "$remote_ref" | sort))"
    if [[ -n "$shared" ]]; then
      say "note: $branch is $behind commit(s) behind $base and both changed:"
      printf '    %s\n' $shared
      say "  If any of these is code (not a ledger doc), merge main into the branch and rerun the tests before merging."
    else
      say "note: $branch is $behind commit(s) behind $base; no file changed on both sides"
    fi
  fi
fi

if [[ "$problems" -gt 0 ]]; then
  say "preflight: $problems problem(s): do not merge yet"
  exit 1
fi
say "preflight: ok to merge $branch into $base"
exit 0
