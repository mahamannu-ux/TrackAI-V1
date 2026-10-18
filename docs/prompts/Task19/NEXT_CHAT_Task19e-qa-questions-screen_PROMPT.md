# Handoff prompt: Task19e-qa-questions-screen (the admin and auditor Questions screen), Muse or DeepSeek

> **Founder setup (agent: skip to "You are…"):**
> 1. Merge this prompt's docs PR, then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `make worktree M=Task19e-qa-questions-screen && cd ~/AIProjects/TrackAI-wt/Task19e-qa-questions-screen && opencode`. Pick DeepSeek (or Muse Spark), keep permission prompts on, paste everything below the line.
> 3. Runs alongside Task20i-a (API-only). Task20i-b (the security console) starts after this merges, because both touch the dashboard navigation and `apps/web/src/lib/api.ts`. Review: the Task20 lead (Claude), standing in for the Task19 lead; push only after "ready to push".

---

You are building **Task19e-qa-questions-screen** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task19 built a fixed catalogue of customer and auditor questions ("how much of this repository's code was written by AI?", "which rules fire most?") and an API that answers each one in a frozen envelope: figures, an honest availability (`recorded`, `partial`, `unavailable`) with reasons, breakdowns, an optional previous period, wording codes and drill-down items. Task19b and Task19c registered the live answers. This session builds the **Questions screen** in the web console. **Web only: no API change.**

- **Repository:** TrackAI. **Worktree:** `~/AIProjects/TrackAI-wt/Task19e-qa-questions-screen`, branch `task/Task19e-qa-questions-screen`.
- **Handoff:** `docs/handoffs/Task19e-qa-questions-screen_HANDOFF.md`. **Estimate:** about 0.12× T6.

## 0. Before anything else
1. Read `AGENTS.md` in full (rules 6, 7 and 9; §9 item 23; §10), `docs/plan/TASK19.md` (T19.5, D2 and §3.1), and the handoffs `docs/handoffs/Task19b-qa-live-code_HANDOFF.md` and `docs/handoffs/Task19c-qa-live-security_HANDOFF.md`.
2. `pwd && git branch --show-current`; identity `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only. `npm ci`, then `npm run build -w apps/web` once as the baseline.

## 1. Read before writing
- `docs/contracts/qa/`: `README.md`, `api.md` (routes, parameters, problems; auditors are refused `kind=live`), `questions.md`, `answer-v1.schema.json` (every value type and field you must render), `fixtures/` (render each one while building).
- `apps/web/src/app/dashboard/page.tsx` (the `navigation` list, `View` type and render switch), `fleet-workspace.tsx` (the model for a workspace component: its `Badge`, loading, error and empty states), `apps/web/src/lib/api.ts` (`apiFetch` and the security comment at its top).

## 2. Scope (decisions made by the lead)
### 2.1 Layout
1. **A top-level view `Questions`**, shown to active `tenant_admin` and `tenant_auditor` members (the same guard as `Audit`). Two columns: the question list on the left, the answer on the right; stacked on narrow screens.
2. **Question list:** `GET /api/qa/questions`, grouped by family (code questions, then security), in rank order, each showing its id, its text and the kinds it offers. A search box filters the list in the browser. On selection, `GET /api/qa/questions/{id}` gives `answers[].built` and `open_gaps`; a kind not built shows "Not built yet" with its gaps, and is never called.
3. **Controls** above the answer: kind (only offered and built kinds; for an auditor `live` is shown disabled with "Live answers are for administrators"), period (7, 30 and 90 days, or a custom from/to), scope (tenant, a repository from the page's existing `repositories` list, a pull request, or a commit SHA, limited to the question's `scopes`), and breakdown (the question's `dimensions`, default none). The selection is kept in the URL query string so a link reopens the same answer.
4. **No-surveillance defaults:** the breakdown defaults to none, and a person-level dimension (contributor or user, if any exists) is never preselected and carries the note "Shows individuals; use for coaching, not ranking".

### 2.2 Rendering the envelope
1. **Availability first:** a badge per answer and per figure. `unavailable` shows "Not available" with its reasons, **never a 0 or an empty chart**; `partial` shows the value with "Partial" and its reasons.
2. **Reasons and gaps:** every reason code maps to one plain sentence in a single map in the component (unknown codes show the code itself); a gap id links to its title from `/api/qa/questions/{id}`'s `open_gaps`.
3. **Values:** render every value type in `answer-v1.schema.json` (count, ratio, share, duration, or whatever the schema defines), with units. A ratio shows both numerator and denominator.
4. **Breakdowns:** a sorted horizontal bar list built with plain CSS (no chart library, no new dependency), with the key's label (repository names from the page's list; `unknown` as "Unknown").
5. **Previous period:** when `previous` is present, show the previous value and the change.
6. **Wording codes:** each maps to one sentence shown under the answer, for example `monitor_only_observed` → "Observed in monitor mode; nothing was blocked." and `session_link_partial` → "Links between sessions and findings are partial." Keep the map beside the reason map.
7. **Drill-down:** list the envelope's `drilldown` items (label and scope). "Load more" calls `/drilldown` with the same parameters only when the envelope has items; a `501 QA_DRILLDOWN_NOT_BUILT` hides the button.
8. **Signed and verifiable answers:** show the kind clearly. If the schema carries an evidence or statement reference, link it to the existing Attesta view; otherwise show nothing extra.
9. **Problems:** each RFC 7807 code from `api.md` maps to a plain message; show the `request_id` in small text for support.
10. **Metadata only:** the screen shows only what the envelope carries; never fetch anything else to "enrich" it.

### 2.3 Port from
- None: the component follows `fleet-workspace.tsx` in this repository. UI-1 (`docs/plan/REUSE_MAP.md`) is the rule set until Task10's design system exists: an auditor sees no write controls (this screen has none), visible keyboard focus, labelled inputs, and colour never the only signal (always a word with the badge colour).

### 2.4 Pre-approved files
- new `apps/web/src/app/dashboard/questions-workspace.tsx` (split it into a second file in the same folder if it passes about 600 lines);
- `apps/web/src/lib/api.ts`: one new block at the end with the Q&A types (copied from `apps/api/src/features/qa/types.ts`, not imported) and three fetchers;
- `apps/web/src/app/dashboard/page.tsx`: the `View` type, one `navigation` entry, one render line;
- your handoff and your rows in `docs/plan/TASK19.md` (T19.5) and `docs/plan/STATUS_BOARD.md`.

### 2.5 Never touch
- `apps/api/`, `docs/contracts/`, other workspaces, `package.json` (no new dependency).

## 3. Checks
- The web app has no unit tests. Gates: `npm run build -w apps/web`, `npm run typecheck`, `npm run lint`, `npm test` (unchanged).
- Write a founder walkthrough (non-blocking for the merge; it is T19.9's first step) in the handoff: start the API and web with the founder's usual dev commands, then as an admin open S7, S12 and the top three code questions and check a `partial` and an `unavailable` answer; as an auditor check that `live` is disabled. Include the expected screens in one line each.

## 4. Close-out
- Commits `Task19e: …` per stage (types and fetchers; list and controls; envelope rendering; handoff).
- Before the review request: `git merge main` and rerun the gates.
- Final reply in the AGENTS.md §12.4 shape, review request addressed to the Task20 lead. Do not push, open a PR or merge.

## Lessons so far
- **Task19c:** the frozen contract wins over the prompt; if this prompt and `answer-v1.schema.json` disagree, follow the schema and record the deviation.
- **Honest states:** `unavailable` is never drawn as zero (AGENTS.md rule 7). This is the first thing the review checks.
