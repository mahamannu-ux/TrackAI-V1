# Cross-agent review procedure (AGENTS.md §12.6)

**How a review starts.** The author's final reply ends with a review request (AGENTS.md §12.4 item 5), for example:

```text
Review `task/<name>` at `<sha>` (session <name>, Tasks <IDs>), following docs/agents/CROSS_REVIEW_PROMPT.md.
```

The founder pastes that request, and nothing else, to the reviewer:
- **A Claude branch:** a fresh Codex thread (Local mode on `~/AIProjects/TrackAI-v1`), or Muse in OpenCode in a review worktree.
- **A non-Claude branch:** the standing **TrackAI-Orchestrator** Claude chat.
- **A Muse branch handed out by a Codex lead** (AGENTS.md §12.8): that Codex thread.
- **A GitAI branch:** the same pairing; the repository is `~/AIProjects/git-ai` (GitHub `mahamannu-ux/git-ai`), the base is `origin/main` (the fork, never `upstream/main`), and the gates are `task test`, `task build`, `task lint` plus GitAI's own `AGENTS.md`.

The reviewer reads this file from `~/AIProjects/TrackAI-v1`; the copy on `main` is authoritative. **One-time bootstrap exception (`docs/adopt-agent-kit` only):** this file did not exist on `main` yet, so that review used the copy on the branch, and the session prompt was the founder's setup brief in the orchestrator chat (summarized in `docs/handoffs/adopt-agent-kit_HANDOFF.md`) rather than a file in `docs/prompts/`. Nothing is attached, and this file is never edited per review. The procedure is the same whichever agent reviews.

---

You are reviewing another agent's finished work on **TrackAI** (`~/AIProjects/TrackAI-v1`, GitHub `mahamannu-ux/TrackAI-V1`). You are **read-only**: do not commit, rebase or edit files on that branch. Your output goes to the founder, who pastes it back to the author.

1. **Get the code.**
   - **Claude (cloud):** in the linked shell, where `~/AIProjects` is mounted under `$HOME/mnt/<folder>`, run `git -C "$HOME/mnt/<folder>/<repo>" bundle create "$HOME/mnt/<folder>/_bundles/review.bundle" main..<branch>` (also bundle `main` if your workspace has no clone), stage `~/AIProjects/_bundles/review.bundle` into your workspace, clone and check out. Remove the bundle afterwards (`~/dev/agent-kit/scripts/bundle.md`).
   - **Codex, Muse or another local agent:** `git diff main...<branch>` in the main checkout, read-only. Run tests in a throwaway **detached** worktree, after `npm ci` in it, (the branch is usually checked out in the author's worktree, and git refuses to check out a branch twice): `git worktree add --detach ~/AIProjects/TrackAI-wt/review-<name> <sha>`, with its own environment. Remove it afterwards with `git worktree remove`.
2. **Read:**
   - `AGENTS.md`, especially §1, §2, §4, §5a, §7, §9 and §12;
   - the session's prompt `docs/prompts/NEXT_CHAT_<name>_PROMPT.md`;
   - its handoff `docs/handoffs/<name>_HANDOFF.md`;
   - the Task spec in `docs/plan/STATUS_BOARD.md`, and the handoffs of the Tasks it builds on.
3. **Check, in this order**, citing `file:line` for every finding:
   1. **Rules.**
      - No change under the frozen paths (AGENTS.md §1) unless the prompt pre-approved it.
      - Files only in the Task's directories plus what the prompt pre-approved; nothing outside `~/AIProjects`.
      - No imports across Task boundaries except the ones the prompt allows.
      - No secrets in code, fixtures, docs or logs; no new reads of configuration that the project's gotchas forbid.
      - Commits authored `mahamannu-ux <mahamannu@gmail.com>` with `<ID>: …` messages (docs-only sessions: `<session name>: …`, AGENTS.md §3); explicit staging (no build output, no dependency folders committed).
      - Nothing pushed or merged by the agent.
   2. **Scope.** Everything the prompt asked for is there, and nothing it put out of scope.
   3. **Correctness against the contracts it consumes** (routes, error shapes, paging, events described in upstream handoffs). Pay most attention to authentication, tenant isolation, the read-only role, idempotency and retries, and anything that must write nothing.
   4. **Reuse.** If the work touches a concern in `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md`: it was ported, not reinvented (or the founder approved a fresh build); the source's invariants and test vectors survived; provenance (`ported from <project> <unit> @ <commit>`) and every deviation are recorded in the code and the handoff.
   5. **Gates.** Run `npm test`, `npm run lint`, `npm run typecheck` and `npm run check`, and report the numbers. Do **not** run long or volume integration tests; check that the proposed ones exist, are marked as integration tests, and would prove what the handoff claims.
   6. **Paperwork.**
      - The handoff follows `HANDOFF_TEMPLATE.md`, with status symbols, Integration test impact and FOUNDER markers.
      - The status board and integration test registry rows are updated.
      - The final reply has the §12.4 shape.
      - **Effort:** the handoff has estimate and actual against the benchmark; if the actual is over 1.25× the estimate, the causes are named and the remaining-plan actual is filled in.
4. **Reply in this shape, and nothing else:**
   - **Verdict:** `ready to push` or `fix first`, with one sentence of why.
   - **Fixes for the author:** a numbered list, most important first. Each item gives the problem, `file:line`, and the expected change, written to be pasted back to the author as is. Write "none" if there are none.
   - **Notes for the founder:** at most three lines (for example a decision the author made that he should confirm).
   - **One bash block** with what the founder runs next: after `fix first`, only a comment saying to paste the fixes to the author; after `ready to push`, the author's push and `gh pr create --head <branch>` lines.

Keep it to about 0.1× of the benchmark: read the diff, run the gates, report. Do not redesign. Finding nothing is a valid outcome.
