# Handoff prompt: Task19i-qa-walkthrough-and-status (T19.9 Playwright walkthrough and the question status page), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI project, link it to this Mac, and paste everything below the line. It works in its cloud workspace and hands commits back as a git bundle in `~/AIProjects/_bundles`.
> 3. Nothing to provide: the stack, users, GitHub PR data and Attesta evidence are all synthetic and seeded in the workspace. Never paste a secret into the chat.
> 4. At the end it gives you one command to run the same Playwright walkthrough on your Mac (that run makes IT-T19i-01 ✅).
> 5. Paste its review request to **Codex** (Claude's branches are cross-reviewed by Codex or Muse). Push only after "ready to push".

---

You are **Claude**, running **Task19i-qa-walkthrough-and-status** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Task19 delivers answers to the customer and auditor questions in `docs/plan/CUSTOMER_AUDITOR_QA.md` (20 code questions Q1–Q20, 26 security questions S1–S26). The live answers, the Questions screen and the auditor answers are merged (Task19a–19h, Task16h). The founder's T19.9 walkthrough (`docs/plan/TASK19_WALKTHROUGH.md`, 15 steps) ran on 2026-11-24/25 in the Task20j sitting: the security steps 8–13 and the security half of 14 ran on real Endpoint data (results in `docs/plan/TASK19.md` §8). Steps **1–7, 15 and the Q3 half of 14** were deferred because that database had no merged AI-assisted GitHub PR and no Attesta evidence. This session finishes them, makes the whole walkthrough repeatable, and turns the question document into the founder's single status page.

- **Repo:** `mahamannu-ux/TrackAI-V1`, cloned in your cloud workspace from `main`. **Branch:** `task/Task19i-qa-walkthrough-and-status`. **Handoff:** `docs/handoffs/Task19i-qa-walkthrough-and-status_HANDOFF.md`.
- **Estimate:** about 0.15× T6 (seeding and the auth stub are most of it). Say so in one line at the start; if it passes 0.2×, stop after part A and hand off.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §6, §9 items 3, 15, 22–23, §11, §12.3–12.5) and `CLAUDE.md` (bundles; never commit or create worktrees from the linked shell).
2. `npm ci && npm test` once as a baseline. Install `postgresql-16-pgvector` for `scripts/it-db.sh` local mode (`CLAUDE.md` "Effort"). Chromium is preinstalled for Playwright (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); do not run `playwright install` in the workspace. If the pinned `@playwright/test` version does not match the installed Chromium, launch with `executablePath: '/opt/pw-browsers/chromium'` rather than downloading.

## 1. Read before writing code
- `docs/plan/TASK19_WALKTHROUGH.md` (every step's expected result is your assertion list) and `docs/plan/TASK19.md` §3 and §8.
- `docs/plan/CUSTOMER_AUDITOR_QA.md` in full.
- Seeding you can reuse: `apps/api/src/features/qa/task19b-qa-live-verify.ts`, `task19g-qa-live-verify.ts`, `task19h-qa-live-verify.ts`, `features/qa/auditor/task16h-auditor-qa-live-verify.ts`, `features/attesta/t15i4-period-report-live-verify.ts`, `features/attesta/t15op-b-security-report-live-verify.ts` (development signer, statements, anchors, period reports).
- Local sign-in: `apps/api/src/features/evidence/task5-acceptance-auth.ts` (a JWKS/JWT stub for the browser, refuses to run outside an ephemeral database).
- The Questions screen: `apps/web/src/app/dashboard/questions-workspace.tsx` and `apps/web/src/lib/api.ts`.

## 2. Scope
### 2.1 Part A: the repeatable T19.9 walkthrough (Playwright)
1. **One seed command** for a throwaway database (`scripts/it-db.sh`): Company A and Company B, each with an admin and an auditor; for Company A a GitHub repository with a **merged AI-assisted PR** (commits with Git AI notes, a known model, production deployment), Endpoint security data (findings across severities, an inventory, day-one scan summaries, permission requests **with at least one approved and one denied decision** in the stored shape), Attesta statements built and anchored with the development signer, and one period report covering the seeded period; for Company B its own small, distinct data. Synthetic only: no real content, no secrets in fixtures.
2. **A local sign-in stub** for the four users, extended from `task5-acceptance-auth.ts` as a copy under `features/qa/testing/` (record the provenance). Same safety guard: it refuses a non-ephemeral database.
3. **A Playwright spec covering all 15 steps** against the real API and the real web app started in-process or as local processes: each step's assertion is the walkthrough's expected result (figures, labels such as "This information is not being captured yet.", unavailable states never shown as zero, the auditor's missing live kinds and the API 403 `QA_KIND_NOT_ALLOWED`, Company B's 404 `QA_SCOPE_NOT_FOUND` for Company A's repository id). Steps 8–14 also run here on seeded data, so the whole walkthrough becomes one regression; their founder-live results from 2026-11-24/25 stay recorded separately.
4. **One command** for the founder to run the same thing on the Mac (`npm run e2e:task19-walkthrough`, which wraps `scripts/it-db.sh`). Register it as **IT-T19i-01**: agent-run 🟡 in your workspace, ✅ only after the founder's run.
5. Product defects found by the walkthrough: fix only if the fix is under about 30 lines with a regression test, inside Task19's files; otherwise record it with `file:line` for the Task19 lead.

### 2.2 Part B: `docs/plan/CUSTOMER_AUDITOR_QA.md` becomes the status page
The founder wants to open this one document and know where every question stands. Rewrite it in place (keep the `Q` and `S` ids and the existing links working):
1. **At the top, a summary:** counts of questions by status for each answer kind (Live, Verifiable, Signed), and a short "what changed since last update" line with the date.
2. **Two tables, code (Q1–Q20) and security (S1–S26), sorted by rank.** Columns: **Rank** (keep the existing customer ranks; S19–S26 keep the founder's 2026-10-19 ranking, placed in one consistent order with S1–S18 and stated how), **Id**, **Question** (one line), **Auditor** (yes/no), **Live**, **Verifiable**, **Signed** (each ✅ working and verified, 🟡 partial or verified only by an agent, ⬜ not built, n/a by design), **Evidence** (the IT id, T19.9 step and date that proved it), **What is left and why** (the gap id and owner, or "phase 2 by design"), **Owner**.
3. **Status rule:** ✅ only with founder-run or live evidence (AGENTS.md §11); 🟡 for agent-only or partial; ⬜ not built. Use the founder's T19.9 results (TASK19 §8), the integration registry (`docs/plan/STATUS_BOARD.md`), and your Part A run. Known facts to carry over: S7, S19, S20 live ✅ (T19.9 steps 8–10); S26 live 🟡 — requests are counted, but approvals and denials are not observable on the hook-only paths for Claude Code and Codex (their final decisions need OTLP); record that as a gap with Task20/Task13 as owner. IT-T19a-01, IT-T19c-01 and IT-T19f-01 passed in the founder's 2026-11-25 sweep (Task20j handoff).
4. **Move, don't delete:** the interview, decisions and historical sections go under an "Archive" heading at the end, unchanged.
5. **Keep it in sync:** replace TASK19 §3's status cells with a pointer to this page, so the two can never drift. Add a one-line rule at the top of the page: Task19 sessions and the Task20 lead update the rows they change, in the same PR.

### 2.3 Port from
- **Local auth:** a copy of `task5-acceptance-auth.ts` (provenance: TrackAI Task5 acceptance auth at `main`); keep its ephemeral-database guard.
- **Seeding:** the Task19b/19g/19h, Task16h and Task15i4/15op-b live-verify seeds; reuse their helpers rather than writing new insert paths.
- Nothing from the agent-kit catalog or SushiCorp applies: this is test scaffolding and documentation.

### 2.4 Pre-approved files
- new `apps/api/src/features/qa/testing/` (seed, auth stub, helpers);
- new `apps/web/e2e/` (the spec) and `apps/web/playwright.config.ts`;
- `package.json`, `package-lock.json` and `apps/web/package.json` for `@playwright/test` (dev dependency only) and the `e2e:task19-walkthrough` script, in alphabetical position;
- `docs/plan/CUSTOMER_AUDITOR_QA.md`, `docs/plan/TASK19.md` (§3 pointer, §6 own row, §8 results), `docs/plan/TASK19_WALKTHROUGH.md` (corrections only), `docs/plan/STATUS_BOARD.md` (own rows; also record IT-T19a-01, IT-T19c-01 and IT-T19f-01 as founder-passed 2026-11-25), the handoff.

### 2.5 Never touch
The frozen paths (AGENTS.md §1), migrations, `docs/contracts/`, other Tasks' source files, the founder's kept databases on his Mac (55432, 55436). If the work needs one, stop and describe it.

## 3. Working rules
- Commits `Task19i: …`, at each stage: seed and auth, then the spec, then the status page, then the handoff. `npm run lint`, `npm run typecheck` and `npm run check` clean.
- One independent review by a review subagent before the handoff (CLAUDE.md "Reviews"), given this prompt, the walkthrough and the diff.
- Hand commits back as a bundle in `~/AIProjects/_bundles`; never push.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 120 lines, with Integration test impact and Effort.
- **Final reply** in the AGENTS.md §12.4 shape, plus **a short colour-coded table in the chat** (the same ✅/🟡/⬜ per question and kind, code and security, grouped by status) so the founder sees the result without opening the page.
- Numbered founder steps; one bash block: fetch the bundle, run `npm run e2e:task19-walkthrough`, then under `# after the cross-agent review` the push, `gh pr create … --head task/Task19i-qa-walkthrough-and-status`, `scripts/pr-preflight.sh`, the merge.

## Lessons so far
- **Task19h (Claude):** answers must say "unavailable" with the reason, never zero; keep live and auditor kinds separate.
- **Task20j (Codex + founder):** the S7 breakdown only appeared after a web fix found in the browser: assert what the screen shows, not just the API.
- **Task20i-a (Claude):** fixtures dated in the past age out of default 30-day windows; pass explicit periods or pin the clock.
