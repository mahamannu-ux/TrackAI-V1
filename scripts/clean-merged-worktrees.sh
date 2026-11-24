#!/usr/bin/env bash
# Remove TrackAI and GitAI worktrees whose work is already on origin/main.
# Default is a dry run that changes nothing; pass --apply to remove.
# Safety: never touches KEEP entries or the main checkouts; skips any worktree
# with uncommitted or untracked (non-ignored) files; uses `git worktree remove`
# without --force, so git itself refuses anything unclean. Branches are kept.
set -euo pipefail

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
REPOS=("$HOME/AIProjects/TrackAI-v1" "$HOME/AIProjects/git-ai")
KEEP=(
  Task9f-macos-conformance-gitai      # Task9f, active
  Task9f-offline-delivery-fix         # Task9f: 2 doc commits not on main
  Task20j-acceptance                  # Task20j: the week's API runs from here
)
# Branches merged by squash (their commits are not ancestors of main, but the
# content is on main). Checked by the Task20 lead on 2026-10-22.
SQUASH_MERGED=(task/Task19c-qa-live-security)

contains() { local x="$1"; shift; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }

removed=0; kept=0; skipped=0
for repo in "${REPOS[@]}"; do
  echo "== $repo"
  git -C "$repo" fetch --quiet origin main
  main_wt="$(git -C "$repo" rev-parse --show-toplevel)"
  while IFS=$'\t' read -r wt branch; do
    [ "$wt" = "$main_wt" ] && continue
    name="$(basename "$wt")"
    if contains "$name" "${KEEP[@]}"; then echo "  keep     $name"; kept=$((kept+1)); continue; fi
    if [ ! -d "$wt" ]; then echo "  missing  $name (will be pruned)"; continue; fi
    if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
      echo "  SKIP     $name: uncommitted or untracked files"; skipped=$((skipped+1)); continue
    fi
    if [ "$branch" != "(detached)" ] && ! git -C "$repo" merge-base --is-ancestor "$branch" origin/main \
       && ! contains "$branch" "${SQUASH_MERGED[@]}"; then
      echo "  SKIP     $name: $branch has commits not on origin/main"; skipped=$((skipped+1)); continue
    fi
    size="$(du -sh "$wt" 2>/dev/null | cut -f1)"
    if [ "$APPLY" = 1 ]; then
      if git -C "$repo" worktree remove "$wt"; then echo "  removed  $name ($size)"; removed=$((removed+1))
      else echo "  FAILED   $name: git refused (left in place)"; skipped=$((skipped+1)); fi
    else
      echo "  would remove $name ($size)"; removed=$((removed+1))
    fi
  done < <(git -C "$repo" worktree list --porcelain | awk '
    /^worktree /{w=substr($0,10)} /^branch /{b=substr($0,8); sub("refs/heads/","",b)}
    /^detached/{b="(detached)"} /^$/{if(w)print w"\t"b; w="";b=""} END{if(w)print w"\t"b}')
  [ "$APPLY" = 1 ] && git -C "$repo" worktree prune
done
echo
if [ "$APPLY" = 1 ]; then echo "removed=$removed kept=$kept skipped=$skipped"
else echo "dry run: would remove=$removed kept=$kept skipped=$skipped. Rerun with --apply."; fi
