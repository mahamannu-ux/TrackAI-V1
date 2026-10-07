# Handoff prompt: dryrun-api-hygiene (two API hygiene fixes, plus a Muse hand-off), Codex as lead

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge PR #8 and the stage-2 docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Codex:** start a new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`), and paste everything below the line.
> 3. Codex ends with two things: its own review request, and a **"Paste to Muse:"** block plus the founder commands to start Muse. Start Muse as that block says. Muse ends with its own review request.
> 4. This is a dry run of the process: **no cross-agent reviews this time.** If both agents end with a correct review request and a handoff, the process works. Push and open both PRs, then merge.

---

You are **Codex**, leading the dry run **dryrun-api-hygiene** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. It is the first session under the new working agreement (agent-kit 0.1.0). It proves two things: that you can work in a named worktree and close out with a handoff, and that **you can lead a Task and hand a bounded piece to Muse** (AGENTS.md §12.8), as you will when Claude is not available. You built Task2–Task6, so you know this code.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Your worktree:** under `~/AIProjects/TrackAI-wt/`, branch `task/dryrun-api-hygiene`.
- **Your handoff:** `docs/handoffs/dryrun-api-hygiene_HANDOFF.md`. **Muse's prompt (you write it):** `docs/prompts/NEXT_CHAT_dryrun-web-dead-view_PROMPT.md`.

## 0. Before anything else
1. **Read `AGENTS.md` in full**, especially §1, §3, §4, §7, §8, §12.1, §12.4 (reply shape), §12.8 (Codex as lead), and `docs/plan/BUG_BACKLOG.md` rows B12–B14.
2. **Check location and identity:** `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`; if not, stop and tell the founder. If the branch is detached or `codex/...`, run `git switch -c task/dryrun-api-hygiene` now. Set `user.name mahamannu-ux` and `user.email mahamannu@gmail.com` for this worktree only.
3. **Toolchain:** `npm ci`, then `npm test` once as a baseline (150 pass expected).
4. **Estimate:** one line against T6. The plan says **about 0.01×** for your part.

## 1. Read before writing code
- `apps/api/src/index.ts` (mounts at lines 52–54, error handler at 77–90).
- How the existing tests drive the API in-process (`apps/api/src/features/security-findings/security-findings.test.ts`, `apps/api/src/features/evidence/evidence.test.ts`).
- `apps/web/src/app/dashboard/page.tsx` lines 32, 152–276, 277–310, 869 (only to write Muse's prompt; you do not edit it).
- `docs/templates/NEXT_CHAT_PROMPT_TEMPLATE.md` (for Muse's prompt).

## 2. Scope (approved by the founder)
### 2.1 Approved decisions
1. **B13, double machine authentication.** `/worker/evidence` requests pass `authenticateMachine` twice because `/worker` is mounted first. Fix so every worker request authenticates exactly once, with no change to which routes exist, their paths or their responses. Choose the smallest correct change (for example mount order, or authenticate once on `/worker` and drop the per-prefix duplicates) and say which in the handoff.
2. **B12, error details leak.** The global error handler must stop returning `err.message` to the client. Response stays `500` with body `{"error":"Internal Server Error"}` (no `details`), and keeps the existing CORS origin behaviour. Server-side logging stays, but must not print request bodies.
3. **Tests:** unit tests through the real Express app or the real middleware in-process: one proving a worker evidence request runs machine authentication once (count calls or `lastUsedAt` writes, whichever the existing harness supports), one proving a thrown error yields the 500 body without `details`. If `index.ts` cannot be imported in tests without side effects (it starts a listener), extract the app construction minimally (for example `createApp()` in a new `apps/api/src/app.ts`, with `index.ts` only listening) and say so.
4. **Muse hand-off (B14).** Write `docs/prompts/NEXT_CHAT_dryrun-web-dead-view_PROMPT.md` from the template for Muse. Muse removes the orphaned `'evidence'` view in `apps/web/src/app/dashboard/page.tsx`: the `'evidence'` member of `View`, the `EvidenceExplorer` component, its render line, and the "Deferred raw analytics" placeholder section in `DetailDrawer`, plus any helper or import left unused by that removal. Nothing else changes; the strings asserted by `security-findings.test.ts` (around lines 647–652) stay. **Every decision upfront** (Muse gets no decision round): exact lines and identifiers, the branch `task/dryrun-web-dead-view` from `main`, the founder's `make worktree M=dryrun-web-dead-view` setup, the gates (`npm run check`), pre-approved files (only `page.tsx`, its handoff, `docs/plan/STATUS_BOARD.md`), the never-touch list, the effort estimate (about 0.01× T6), and the close-out shape. "Port from": none, because it is a deletion.

### 2.2 Port from
None: no catalogued component is involved (two hygiene fixes and a deletion).

### 2.3 Pre-approved files
- `apps/api/src/index.ts`, a new `apps/api/src/app.ts` if you extract the app, the middleware file only if the fix needs it (`apps/api/src/core/middleware/machine-auth.ts`), a new test file `apps/api/src/core/app.test.ts` (or similar) and its registration in `apps/api/package.json`'s `test` script.
- `docs/prompts/NEXT_CHAT_dryrun-web-dead-view_PROMPT.md`, `docs/handoffs/dryrun-api-hygiene_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (your row and the remaining plan), `docs/plan/BUG_BACKLOG.md` (mark B12, B13 fixed by your branch).

### 2.4 Never touch
- `docs/contracts/`, merged migrations, `apps/web/` (Muse's piece), any other route or service. If the work needs one, **stop and describe it**.

## 3. Working rules
- **Commits** prefixed `dryrun-api-hygiene: …`, explicit `git add <path>`; interfaces (app extraction) first, then each fix with its test, then the Muse prompt, then the handoff. `npm run lint`, `npm run typecheck` and `npm run check` clean.
- **Integration:** none needed; say "none" in the handoff.
- **Review:** one independent review (a fresh thread or `/review`) before the handoff, per AGENTS.md §12.3. The cross-agent review is skipped for this dry run.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 60 lines**, with Effort.
- `docs/plan/STATUS_BOARD.md`: add rows for `dryrun-api-hygiene` (you) and `dryrun-web-dead-view` (Muse, not started); remaining-plan actual for yours.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape: the effort line; decisions; one bash block (unit tests, then under `# after the independent review` your push and `gh pr create --base main --head task/dryrun-api-hygiene --title "[dryrun-api-hygiene] API hygiene fixes" --body-file docs/handoffs/dryrun-api-hygiene_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`); your review request in a `text` block; then a **"Paste to Muse:"** block containing Muse's prompt text (everything below its line), preceded by the founder commands to start Muse from Muse's prompt.

## Lessons so far
- **adopt-agent-kit (Claude):** project-specific rules drafted without the author's knowledge took three review rounds; you are the authority on this code, so state facts from it, not from memory.
- **Task2–Task6 (Codex):** keep your wave and evidence discipline, but inside one short named session with its own handoff and estimate.
