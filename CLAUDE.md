@AGENTS.md

# Claude specifics

`AGENTS.md` (imported above) is the rulebook; this file adds only what differs for Claude. Do not copy rules here: the two files must never drift.

## Cloud sessions and the founder's machine
- Claude runs in a cloud workspace. It reaches the founder's machine only when the chat is **linked** to it (the `mcp__remote-devices__*` tools). If the session needs the machine and they are missing, ask the founder to link the chat; do not guess.
- **Move commits with git bundles**, never by re-typing files: follow `~/dev/agent-kit/scripts/bundle.md`. Bundles go under `~/AIProjects/_bundles` and are removed afterwards. Request delete permission on `~/AIProjects` once per session, for the bundles.
- **Never create a worktree, commit or check out from the linked shell.** It runs as a different user, with `~/AIProjects` mounted at another path, so the git metadata it writes points at paths that do not exist for the founder, and other agents' worktrees can look prunable from there. The founder creates worktrees and fetches bundles; the linked shell is for reading and for writing bundles.
- **A `git fetch` from the linked shell leaves lock files** it cannot delete without delete permission. Prefer reading `origin/main` after the founder has pulled; if you must fetch, have delete permission first.
- Read the founder's repo from `main` (`git show main:<file>` or a bundle cloned into the workspace), so you never depend on what is checked out.

## Reviews
- The §12.3 independent review is a **review subagent** that has not seen the work being produced. Give it the spec, the handoff and the diff, and ask for must-fix and should-fix findings with `file:line`.
- Claude's own branches are cross-reviewed by Codex or Muse (§12.6); Claude reviews theirs in the TrackAI-Orchestrator chat.

## Effort
- Each turn re-reads the whole conversation, so cost grows faster than linearly with session length. Two short sessions cost less than one long one: say so when estimating.
- Never wait on a long sandbox run; hand volume runs to the founder (§12.3).
- The cloud workspace can run the unit tests, type checks, web build and `scripts/it-db.sh` in local mode (install `postgresql-16-pgvector` first); it has no Docker.
