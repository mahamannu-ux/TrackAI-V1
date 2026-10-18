# Handoff prompt: Task20i-b-security-console (the Security screen: Findings, Coverage, Settings), Muse or another OpenCode/VS Code agent

> **Founder setup (agent: skip to "You are…"):**
> 1. Merge this prompt's docs PR, then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `make worktree M=Task20i-b-security-console && cd ~/AIProjects/TrackAI-wt/Task20i-b-security-console`, start the agent there, paste everything below the line.
> 3. Paste its review request to the **Task20 lead (Claude)**; push only after "ready to push". A browser walkthrough by the founder closes T20.11.

---

You are building **Task20i-b-security-console** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

The server can already show security data and change security settings: Task20i-a built `GET /api/admin/security/v2/{findings,findings/{id},coverage}` and Task20f built `GET`/`PUT /api/admin/security/settings` (rule switches, data settings, monitor mode, dry run then apply, publishes a signed rule bundle). This session builds the **Security screen** in the web console that calls them. **Web only: no API change.**

- **Repository:** TrackAI. **Worktree:** `~/AIProjects/TrackAI-wt/Task20i-b-security-console`, branch `task/Task20i-b-security-console`.
- **Handoff:** `docs/handoffs/Task20i-b-security-console_HANDOFF.md`. **Estimate:** about 0.15× T6.

## 0. Before anything else
1. Read `AGENTS.md` in full (rules 6, 7 and 9; §9 items 11 and 23), `docs/plan/TASK20.md` (T20.11, T20.12), and the handoffs `Task20i-a-security-reads_HANDOFF.md`, `Task20f-security-settings-signing_HANDOFF.md` and `Task19e-qa-questions-screen_HANDOFF.md`.
2. `pwd && git branch --show-current`; identity `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only. `npm ci`, then `npm run build -w apps/web` once.

## 1. Read before writing
- API shapes: `apps/api/src/features/security-findings/v2-read.ts` (exported types) and `v2-read.routes.ts` (problem codes); `apps/api/src/features/security/admin.routes.ts` and `service.ts` (settings view, plan and applied bodies, problem codes including the conflict code).
- Web: `apps/web/src/app/dashboard/questions-workspace.tsx` and `questions-presentation.tsx` (Task19e: the newest workspace; copy its badges, loading, error and empty states and its problem handling), `page.tsx` (navigation and the role guard), `apps/web/src/lib/api.ts`.

## 2. Scope (decisions made by the Task20 lead)
### 2.1 Layout
1. **A top-level view `Security`** for active `tenant_admin` and `tenant_auditor` members, with three tabs: **Findings**, **Coverage**, **Settings**. The tab is kept in the URL (`?view=security&tab=…`), the same way Task19e keeps `view=questions`.
2. A one-line banner on every tab: "Monitor mode: TrackAI observes and records; it does not block." Never use the words "blocked" or "prevented" anywhere on this screen (AGENTS.md rule 7).
3. Leave the old Administration → "Security findings" section (Task6.a) as it is.

### 2.2 Findings tab
1. Filters: period (7, 30, 90 days or custom), severity, category, rule, agent, machine, repository (the page's repository list plus "Machine-wide (not enrolled)"), generation. A table with time, severity, rule (id and title), agent, model, repository, machine; "Load more" uses `next_cursor`.
2. A row opens a side panel from `GET /findings/{id}`: the finding's fields, **"Enforcement decisions nearby"** and **"Indicators seen nearby on this machine (not linked to this finding)"**, exactly those labels. A null indicator value shows "Hidden (URL or email)".
3. Task6.a rows show "Older format" and their phase in words ("requested", "observed result").

### 2.3 Coverage tab
1. One row per machine: platform, Numbat version and wired agents, last status time, the four health layers, lease mode and expiry, bundle epoch, last acknowledgement.
2. Literal states are shown as words, never zero or blank: `unreported` → "Not reported", `no_lease` → "No lease", `not_acknowledged` → "Not acknowledged". A lease whose `expires_at` is in the past shows "Expired". A refusal shows its code as a plain sentence (one map for the nine refusal codes, for example `VERIFICATION_UNAVAILABLE` → "The machine could not check the signature; it stays off").
3. A health layer that is not healthy is shown with a word as well as a colour.

### 2.4 Settings tab
1. `GET` shows the 51 rules (id, title, category, severity, on/off, with the upstream value beside each changed one), the five data settings, the monitor mode and the current bundle (version, epoch, issued time).
2. **Auditors see it read-only, with no write controls at all** (UI-1). Administrators can change rules, severity, data settings and monitor mode in a local draft.
3. **Dry run first:** "Review changes" sends `PUT` with `dry_run: true` and shows the plan (what changes, whether a new bundle is published, whether the lease changes, whether it is too large). "Apply" is enabled only after a dry run of the same draft, asks for a reason (required), sends `dry_run: false`, then reloads. A conflict problem shows "Someone else changed the settings; reload and review again".
4. Each data setting has a one-line warning shown before enabling it, for example "Command previews: short, redacted previews of commands are stored; they are not shown in this console yet."

### 2.5 Shared rules
- Every request uses `apiFetch` (problems mapped to plain messages, `request_id` in small text). Show only what the API returns.
- No chart library, no new dependency.

### 2.6 Port from
- None: copy Task19e's component patterns in this repository; UI-1 (`docs/plan/REUSE_MAP.md`) until Task10's design system exists.

### 2.7 Pre-approved files
- new `apps/web/src/app/dashboard/security-workspace.tsx` (plus one or two more files in the same folder if it passes about 600 lines);
- `apps/web/src/lib/api.ts`: one new block at the end (types copied from the two API files, not imported; fetchers);
- `apps/web/src/app/dashboard/page.tsx`: the `View` type, one `navigation` entry with its role guard, one render line;
- your handoff and your rows in `docs/plan/TASK20.md` (T20.11) and `docs/plan/STATUS_BOARD.md`.

### 2.8 Never touch
- `apps/api/`, `docs/contracts/`, other workspaces, `package.json`.

## 3. Checks
- Gates: `npm run build -w apps/web`, `npm run typecheck`, `npm run lint`, `npm test`.
- A founder walkthrough in the handoff (non-blocking for the merge, it closes T20.11): seed data with `IT-T20i-01`'s live verify or the founder's dev setup, then as an admin: filter findings, open one, check the nearby labels; Coverage with at least one "Not reported" machine; Settings dry run then apply, and a second browser tab triggering the conflict message; as an auditor: Settings has no write controls.

## 4. Close-out
- Commits `Task20i-b: …` per stage (types and fetchers; Findings; Coverage; Settings; handoff).
- `git merge main` and rerun the gates right before the review request.
- Final reply in the AGENTS.md §12.4 shape, review request to the Task20 lead. Do not push, open a PR or merge.

## Lessons so far
- **Task19e:** keep the selection in the URL and never draw "not available" as zero; the review checks both first.
- **Task20i-a:** indicators are machine-level, not linked to a finding; the labels in §2.2 item 2 are the honest wording.
