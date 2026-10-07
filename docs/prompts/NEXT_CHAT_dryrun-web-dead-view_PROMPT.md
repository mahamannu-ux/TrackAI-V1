# Handoff prompt: dryrun-web-dead-view (remove the orphaned dashboard evidence view), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the `dryrun-api-hygiene` PR, which contains this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. Run `cd ~/AIProjects/TrackAI-v1 && make worktree M=dryrun-web-dead-view && cd ~/AIProjects/TrackAI-wt/dryrun-web-dead-view && npm ci && opencode`; pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply `continue` if it stops.
> 3. This is a process dry run. Muse must finish with its handoff and review request, but the founder will not run a cross-agent review this time.
> 4. After Muse finishes, check that its handoff and review request have the required shape. Push and open the PR only after that process check.

---

You are **Muse**, building **dryrun-web-dead-view** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Codex's preceding dry-run session fixes two API hygiene bugs and hands you the independent B14 deletion. Remove only the unreachable legacy dashboard view and placeholder; do not change the live Evidence Workspace, API contracts, or security-findings UI.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/dryrun-web-dead-view`, branch `task/dryrun-web-dead-view`.
- **Handoff:** `docs/handoffs/dryrun-web-dead-view_HANDOFF.md`.

## 0. Before anything else
1. **Read `AGENTS.md` in full**, especially §1, §3, §4, §7, §8, §12.1, §12.3 and the §12.4 reply shape.
2. **Check location and identity:** `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/dryrun-web-dead-view` on `task/dryrun-web-dead-view` from current `main`; otherwise stop and tell the founder. Set `user.name` to `mahamannu-ux` and `user.email` to `mahamannu@gmail.com` for this worktree only (or pass both with `git -c` on every commit if worktree-local config is unavailable).
3. Run `npm test` once as the baseline after the founder's `npm ci`.
4. **Estimate:** one line against T6. The plan says **about 0.01× T6**; this is one bounded deletion and should not be split.

## 1. Read before writing code
- `docs/plan/BUG_BACKLOG.md` row B14 and `docs/plan/STATUS_BOARD.md` remaining-plan row `dryrun-web-dead-view`.
- `apps/web/src/app/dashboard/page.tsx`: `View` at line 32; `EvidenceExplorer` at lines 152–275; `DetailDrawer` and its placeholder near line 304; the dead render near line 869. Re-resolve line numbers after edits; identifiers are authoritative.
- `apps/api/src/features/security-findings/security-findings.test.ts` around lines 647–652. Read only: every asserted dashboard string must remain.
- `docs/templates/HANDOFF_TEMPLATE.md`.

## 2. Scope (approved by the founder)
### 2.1 Approved decisions
1. Remove the `'evidence'` member from `View`.
2. Delete the complete `EvidenceExplorer` component.
3. Delete the `view === 'evidence'` render expression.
4. Delete the `Deferred raw analytics` placeholder section from `DetailDrawer`.
5. Remove only imports or helpers that become unused because of those deletions. Keep `EvidenceWorkspace` and its imports, every live view, API behavior, layout, and copy unchanged.
6. Preserve the dashboard strings asserted by `security-findings.test.ts`, including `Security findings`, `Monitor only`, `TrackAI did not block this action`, `loadSecurityFindings`, `Refresh findings`, `Contact your administrator if you need access`, `Support details`, `Account identifier (not a secret)`, the verified OpenCode route, and the unverified-platform notice.

### 2.2 Port from
- **None:** B14 is deletion of unreachable UI and placeholders; no catalogued component or SushiCorp design is involved.

### 2.3 Pre-approved files
- `apps/web/src/app/dashboard/page.tsx`
- `docs/handoffs/dryrun-web-dead-view_HANDOFF.md`
- `docs/plan/STATUS_BOARD.md` (your task row and remaining-plan actual only)

### 2.4 Never touch
- `docs/contracts/`, `apps/api/drizzle/`, any API or GitAI file, `apps/web/src/lib/`, `apps/web/src/app/dashboard/evidence-workspace.tsx`, package manifests, tests, `docs/plan/BUG_BACKLOG.md`, or any other route, component, tracker, prompt, or handoff. If the work needs one, **stop and describe it**; do not work around it.

## 3. Working rules
- **Commits:** prefix every commit `dryrun-web-dead-view: …`; explicitly `git add` only the pre-approved paths. Commit the deletion first, then the status/handoff close-out.
- **Tests:** run `npm run check`. It must retain the existing 152-test API suite after Codex's merged change, type-check both apps, lint, validate Drizzle metadata, and build the web app. Do not add tests or change asserted security-finding strings.
- **Integration:** none needed; say `none` in the handoff.
- **Review:** re-read the full diff as an independent reviewer before the handoff, per AGENTS.md §12.3, and record the result. The cross-agent review is deliberately skipped for this dry run, but still produce the review-request block so the process shape can be checked.

## 4. Close-out
- Write `docs/handoffs/dryrun-web-dead-view_HANDOFF.md` from `docs/templates/HANDOFF_TEMPLATE.md`, **under 60 lines**, naming the exact deletions, unchanged Evidence Workspace and Task6 strings, no integration need, and **Effort**.
- In `docs/plan/STATUS_BOARD.md`, add/update the `dryrun-web-dead-view` Task-status row and fill its remaining-plan actual. Do not update another session's row.
- Leave a clean tree. Do **not** push, open a PR or merge.
- Final reply in the AGENTS.md §12.4 shape: the effort line; behavior/scope decisions; exactly one `bash` block beginning with `cd ~/AIProjects/TrackAI-wt/dryrun-web-dead-view`, then `npm run check`, then under `# after the dry-run process check` the push and `gh pr create --base main --head task/dryrun-web-dead-view --title "[dryrun-web-dead-view] Remove dead evidence view" --body-file docs/handoffs/dryrun-web-dead-view_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; then exactly one `text` review request naming branch, final commit, session, Task5/B14, checkout path, and passed gates.

## Lessons so far
- **Task2–Task6 (Codex):** keep small commits and explicit evidence gates, but close this as one short named session with its own estimate and handoff.
- **adopt-agent-kit (Claude):** state facts from the code, not assumptions; every session gets a handoff, and ownership is by concern and file.
