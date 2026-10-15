# Handoff prompt: Task16f-audit-console (the auditor's own Audit area in the console), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Task16c (PR #63) and this prompt's docs PR are merged. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task16f-audit-console && cd ~/AIProjects/TrackAI-wt/Task16f-audit-console && npm ci && opencode`
> 2. Pick Muse Spark, keep permission prompts on, and paste everything below the line. It runs alongside Claude's Task16e; the two touch different files.
> 3. When it finishes, run IT-T16f-01 (a browser walkthrough; steps in its handoff), then paste its review request to the **lead Claude chat** (Task16). Push only after "ready to push".

---

You are **Muse**, building **Task16f-audit-console** (Task16 A16.8) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

Task16c merged the audit read API (`/api/audit`: events, one event, catalog). Every read there writes one `audit.events.read` row. This session builds the console's **Audit** area, separate from Administration: an auditor or administrator searches the trail, opens an event and reads it in plain words.

It also fixes a problem Task16c's change made visible. The dashboard refreshes every 15 seconds and calls `GET /api/admin/audit` each time (`page.tsx:672`, `:707`). That route is now audited, so every open dashboard writes an audit row every 15 seconds.

**The lead's design note is below: every decision is made.** API changes are none. The export and verify card comes in Task16f2, after Task16e.

- **Worktree:** `~/AIProjects/TrackAI-wt/Task16f-audit-console`, branch `task/Task16f-audit-console`. **Handoff:** `docs/handoffs/Task16f-audit-console_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 6, 7, 9; §4; §11; §12.4).
2. Check where you are: `pwd && git branch --show-current`. You must be in the worktree above on `task/Task16f-audit-console`; otherwise stop. Then set your identity for this worktree only: `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. Run `npm run check` once as a baseline. Estimate in one line against T6. The plan says **about 0.1×**.

## 1. Read
- `apps/api/src/features/audit/audit.routes.ts`, `read-service.ts` (query parameters, the response shapes, cursor rules) and `http.ts` (problem codes). `docs/contracts/audit/event-v1.schema.json`.
- `apps/web/src/app/dashboard/page.tsx`:
  - `View` and `navigation` at `:32-45`;
  - `AdminSection` and `adminNavigation` at `:194-207`;
  - the overview metric at `:554`;
  - the admin audit section at `:628`;
  - the refresh at `:657-707`.
- `apps/web/src/app/dashboard/attesta-workspace.tsx` (Task15k): the house style for a read-only workspace, with badges, problem errors and a request-id reference.
- `apps/web/src/lib/api.ts`: `apiFetch` (`:34`), and `attestaFetch` / `AttestaApiError` (`:683-740`), the RFC 7807 client pattern to copy.

## 2. Scope (approved)
### 2.1 Design note (lead, binding)
1. **Stop the audit polling.**
   - Remove `getAdminAudit()` from the dashboard's background refresh (`page.tsx:672`) and remove `audit` from `AdminResources` (`:189`).
   - Remove the Administration section `audit` ("Security audit", `:205` and `:628`) and the overview metric "Recent audit events" (`:554`).
   - In the overview, replace that metric with a link-styled `Metric` labelled "Audit trail" whose value is "Open Audit"; it switches the view to `audit`.
   - The legacy `GET /api/admin/audit` route stays in the API, unused by the web.
   - After this change, an open dashboard writes **no** audit row unless the person searches.
2. **A new top-level view `audit`, labelled "Audit".**
   - Add it to `View` and `navigation` after `administration`.
   - Show it only when `adminContext.membership.status === 'active'` (admin or auditor). Developers never see it.
   - Its side-label in the nav is "Trail".
   - It renders `<AuditWorkspace />` from a new `apps/web/src/app/dashboard/audit-workspace.tsx`.
   - The header filter input and the 15-second refresh do **not** apply to this view: hide the "Filter rows…" input for `audit` as it is hidden for `administration`.
3. **API client** in `lib/api.ts`, copying the Attesta pattern:
   - `AuditApiError(title, code, status, requestId)`;
   - `auditFetch<T>` (Bearer token as `apiFetch`, parses `application/problem+json` into `AuditApiError`);
   - types `AuditEvent` (exactly event-v1), `AuditCatalogAction`, `AuditCatalog`, `AuditEventPage {events, next_cursor, catalog_version}`;
   - functions:
     - `getAuditCatalog()`;
     - `listAuditEvents(filters: AuditFilters, cursor?: string)`, which builds `URLSearchParams` with a repeated `action` and omits empty values;
     - `AuditFilters = {actions: string[]; severity?: 'high'|'notice'|'info'; actorType?: string; actorId?: string; targetType?: string; targetId?: string; from?: string; to?: string}`.

   Do not add a client for `GET /events/:id`: the drawer uses the row already loaded, so opening an event writes no extra audit row.
4. **Layout of `AuditWorkspace`,** one column, top to bottom:
   - **Banner:** a calm note, slate and not amber.
     - For an auditor: "Read-only auditor access. Each search you run here is itself recorded in the audit trail."
     - For an admin: "Each search you run here is itself recorded in the audit trail."
     - No write control appears anywhere in this view (UI-1: hidden, not disabled).
   - **Filters,** in a form:

     | Filter | Control |
     |---|---|
     | Time | "From" and "To" `datetime-local` inputs, converted with `new Date(value).toISOString()` (UTC, `Z`). "To" must be after "From"; otherwise an inline message, and no request is sent |
     | Severity | A segmented control: All, High, Notice, Info |
     | Actions | A multi-select of **emitted** actions from the catalog, grouped by `owner`, at most 20 (a counter shows "n of 20") |
     | Actor | A type select (Any plus the six actor types, with plain labels: admin, auditor, signed-in user, operator, machine, service) and an "Actor id" text input |
     | Target | A type select (Any plus the distinct `target_type` values of the catalog) and a "Target id" text input |

     Buttons: **Search** (primary) and **Reset**.
   - **When requests run:** a request is sent only on Search and on Load more, never on each keystroke, because every search is audited. Opening the view runs **one** search with no filters (the latest 50).
   - **Results,** a table with these columns:
     - Time: local time; the `title` attribute shows the exact UTC `occurred_at`;
     - Severity: a badge, `high` rose, `notice` amber, `info` slate;
     - Action: monospace;
     - Actor: the plain type label plus the id, truncated to 12 characters with the full id in `title`;
     - Target: the type plus the id, truncated the same way.

     Clicking a row opens the drawer. Below the table, **Load more** appears when `next_cursor` is set; it appends the next page with the same filters. A new Search replaces the list and clears the cursor.
   - **States, each designed:**

     | State | What it shows |
     |---|---|
     | Loading | A skeleton |
     | Empty | "No audit events match these filters." |
     | Error | The problem's title, then "Reference: <request_id>" in small text. 403 is "Audit access needs an administrator or auditor membership." 400 `AUDIT_CURSOR_INVALID` restarts the search from page one with a short note |
5. **The event drawer** is a right-hand panel. Opening another event replaces it rather than stacking; Escape and a close button dismiss it, and focus returns to the row. It shows:
   - the action and its severity badge;
   - the catalog owner;
   - "When" (local time and exact UTC);
   - "Who" (actor type label and full id);
   - "What it acted on" (target type and full id).
   - **Details** as a definition list: one row per key. Arrays are comma-separated; nested objects become an indented definition list; `null` shows "none".
   - A collapsed `<details>` labelled "Technical view" with the raw JSON of the event.
   - A "Copy event id" button (clipboard only).
   - The footer reads "Catalog version N".

   Details never contain raw content (the contract guarantees it), so the drawer can show every key.
6. **Wording:** plain words, short labels, no status symbols in the UI. Say "recorded", never "verified": verification comes with Task16f2.

### 2.2 Port from
SushiCorp catalog **UI-1** (console design rules):
- replace, never accumulate;
- every state designed;
- plain words;
- the auditor sees a calm banner and no write controls, hidden and not disabled.

Read for reference: `git -C ~/dev/sushicorp show 0bd67a5:docs/prompts/NEXT_CHAT_UI2b_PROMPT.md` (§2, the UX rules) and `0bd67a5:console/web/src/components/ui.tsx` (read-only). Port the rules, not the code. Note in the handoff that UI-1's "the URL is the state" is deferred to Task10's information architecture: this dashboard has no URL routing per view today.

### 2.3 Pre-approved files
- `apps/web/src/app/dashboard/audit-workspace.tsx` (new).
- `apps/web/src/app/dashboard/page.tsx`: items 1 and 2 only.
- `apps/web/src/lib/api.ts`: the audit client in item 3, and removing `getAdminAudit`'s use (keep the function if anything else imports it; otherwise delete it with its type).
- `docs/handoffs/Task16f-audit-console_HANDOFF.md`; `docs/plan/TASK16.md` (the A16.8 row and your session row only); `docs/plan/STATUS_BOARD.md` (your registry row and the remaining-plan actual only).

### 2.4 Never touch
- `apps/api/` (no API change).
- Other dashboard workspaces.
- The design tokens in `globals.css`.

If the design needs an API change, **stop and write the question for the lead**.

## 3. Working rules
- **Commits** `Task16f-audit-console: …`, staged with explicit `git add <path>`. Commit in this order:
  1. the polling fix;
  2. the API client;
  3. the workspace;
  4. the drawer;
  5. the handoff.
- `npm run lint`, `npm run typecheck` and `npm run check` (including the web build) must be clean. The web app has no unit tests; do not add a test framework.
- **IT-T16f-01** (founder-live, in a browser). Write the exact steps in the handoff:
  1. As an **auditor**:
     - the Audit view appears with the auditor banner and no write control;
     - one search lists events, with a filter by severity and by action;
     - Load more appends;
     - the drawer opens and shows the details in plain words;
     - Escape closes it.
  2. As an **admin**: the same, with the admin banner. Administration no longer has a "Security audit" section, and the overview has the "Audit trail" link.
  3. As a **developer** (no membership): no Audit item in the navigation.
  4. **No polling:** with the dashboard open on any view for 60 seconds, the browser's Network tab shows no `/api/admin/audit` and no `/api/audit/events` request unless Search is pressed. Each Search adds exactly one `audit.events.read` row, visible as the newest event on the next search.
- **Review:** re-read your full diff as a reviewer before the handoff.

## 4. Close-out
- Handoff under 50 lines, with the IT-T16f-01 steps, what was removed from Administration, and Effort.
- Clean tree. Do not push.
- **Final reply** in the AGENTS.md §12.4 shape. The bash block contains, in order:
  - `npm run check`, then how to start the web and API for IT-T16f-01 (the repository's existing dev commands);
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16f-audit-console --title "[Task16f] Audit console" --body-file docs/handoffs/Task16f-audit-console_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task16f-audit-console`; and `gh pr merge task/Task16f-audit-console --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok.

  Then the review request for the lead in a `text` block.

## Lessons so far
- **Task16c (Muse):** the store/route split and the exact-text cursor worked. Keep the client equally strict: send only the parameters the API accepts, because unknown ones are a 400.
- **Task15k (Muse):** the console card says "recorded" or "signed" as database facts; only a verify action may say "verified".
- Cite `file:line` in the handoff for every removal from `page.tsx`.
