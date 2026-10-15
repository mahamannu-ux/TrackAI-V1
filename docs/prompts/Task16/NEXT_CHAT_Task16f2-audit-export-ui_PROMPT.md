# Handoff prompt: Task16f2-audit-export-ui (verify and export in the Audit view, read-receipt toggle, offline audit-export verifier), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Task16e (PR #66), Task16f (PR #65) and this prompt's docs PR are merged. **Reusing the merged Task16f worktree is fine** (its branch is merged). In that OpenCode session, have Muse run:
>    `git fetch origin && git switch -c task/Task16f2-audit-export-ui origin/main && npm ci && pwd && git branch --show-current`
>    Muse then works in `~/AIProjects/TrackAI-wt/Task16f-audit-console` on branch `task/Task16f2-audit-export-ui`. A fresh worktree also works: `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task16f2-audit-export-ui && cd ~/AIProjects/TrackAI-wt/Task16f2-audit-export-ui && npm ci && opencode`.
> 2. Pick Muse Spark, keep permission prompts on, and paste everything below the line.
> 3. When it finishes, run IT-T16f2-01 (browser) and IT-T16f2-02 (offline verifier), then paste its review request to the **lead Claude chat**. Push only after "ready to push".

---

You are **Muse**, building **Task16f2-audit-export-ui** (Task16 A16.7 finishing work, plus the founder's notes from IT-T16f-01) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

Two pieces are already merged:
- **Task16e:** audit seals in the Attesta ledger, `GET /api/audit/verify`, and signed audit exports (`/api/audit/exports`).
- **Task16f:** the console's **Audit** view (`audit-workspace.tsx`).

This session finishes the auditor experience:
1. a **Tamper evidence and export** section in the Audit view;
2. read receipts (`audit.events.read`) **hidden by default** behind a visible toggle;
3. the **Attestation** workspace moved from Administration into the Audit view;
4. an **offline verifier** for the signed audit export.

**Every decision is made below.** No migration.

- **Worktree:** `~/AIProjects/TrackAI-wt/Task16f-audit-console` (reused) or `~/AIProjects/TrackAI-wt/Task16f2-audit-export-ui`; branch `task/Task16f2-audit-export-ui` either way. **Handoff:** `docs/handoffs/Task16f2-audit-export-ui_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §11, §12.4).
2. Check where you are: `pwd && git branch --show-current`. You must be in one of the worktrees above on `task/Task16f2-audit-export-ui`, branched from the latest `origin/main` (it contains `audit-seal.test.ts` and `export.md`); otherwise stop. Then set your identity for this worktree only: `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. Run `npm test` once. Estimate in one line against T6. The plan says **about 0.08×**.

## 1. Read
- `docs/handoffs/Task16e-audit-tamper_HANDOFF.md`, especially "Implemented interfaces" and "Integration notes (Task16f2 inputs)".
- `docs/handoffs/Task16f-audit-console_HANDOFF.md`, especially "Founder walkthrough note".
- `docs/contracts/audit/export.md` (the whole file; "What a verifier checks", steps 1–7, is your spec) and `export-v1.schema.json`. `docs/contracts/attesta/audit-seal.md` and its two schemas.
- `apps/api/src/features/audit/audit.routes.ts` (`/verify` at `:181`, `/exports` at `:211-260`), `read-service.ts` (`parseAuditListQuery`, the `allowed` set at `:167`, `canonical` at `:244`), `verify-service.ts`, `export-service.ts`.
- `apps/api/src/features/attesta/offline-verifier.ts` (`verifyEvidencePack`, its trust and anchor steps) and `attesta-verify-pack-cli.ts`: the pattern to follow.
- `apps/web/src/app/dashboard/audit-workspace.tsx`, `attesta-workspace.tsx`, `page.tsx` (`:195`, `:206`, `:628`), `apps/web/src/lib/api.ts` (the audit client).

## 2. Scope (approved)
### 2.1 Decisions
1. **API: an `exclude_action` filter on `GET /api/audit/events`.**
   - Repeatable, at most 20; each value must be a catalog action (the same check as `action`).
   - Add it to the `allowed` set and to the canonical filter string (so cursors bind it), and record `exclude_action` in the audited `filters` names.
   - The store adds `NOT IN (…)` after the tenant condition.
   - If a value appears in both `action` and `exclude_action`, answer `AUDIT_FILTER_INVALID`.
   - Unit tests in `audit-api.test.ts`: it filters, it binds the cursor, and the conflict is refused.
2. **Read receipts are hidden by default.**
   - The Audit view sends `exclude_action=audit.events.read` unless a toggle **"Show read receipts"** (off by default) is on.
   - Under the filters, a small note: "Read receipts (each search recorded in this trail) are hidden. They are still recorded."
   - The toggle is part of the applied filters, so Search applies it and Reset turns it off.
   - Nothing is deleted or skipped on the server: every read is still recorded, and the founder agreed the guarantee stays.
3. **The Audit view gets three sections,** as tabs at the top: **Trail** (today's view), **Tamper evidence and export** (new) and **Attestation** (moved).
   - The selected tab is kept in component state.
   - Only the Trail tab runs its opening search; the other tabs send no request until the person acts.
4. **Tamper evidence and export section:**
   - **Check the trail:**
     - "From" and "To" date-time inputs (default: the last 30 days) and a **Check** button.
     - The button calls `GET /api/audit/verify?from&to`. It is audited server-side, so it runs on click only.
     - **The verdict line:**

       | Condition | Text and colour |
       |---|---|
       | `ok` and `chain.ok` | "All sealed events match their seals." (green) |
       | `ok`, `chain.ok` false, no breaks | "Seals match, but signatures or anchors could not be checked." (amber) |
       | breaks exist | "Problems found." (rose) |

       Then the counts: seals checked; events "not sealed yet" from `unsealed_tail` (never called verified).
     - **Breaks** are listed as a table: kind in plain words ("event missing", "event changed", "event added after sealing", "seal chain broken", "seal statement problem"), the seal's window, and the row id when given. When `breaks_truncated` is set, say "Showing the first N problems."
     - **Problem errors** show the title and "Reference: <request_id>", as in the Trail tab.
   - **Signed export:**
     - "From" and "To" (default: the last 30 days; the server refuses more than 366 days, so show its error) and **Request export**.
     - The button sends `POST /api/audit/exports` with a fresh `Idempotency-Key` (`crypto.randomUUID()`) per click.
     - Then poll `GET /api/audit/exports/:id` **every 3 seconds while this tab is open and the job is `queued` or `running`**. Stop on `ready`, `failed`, leaving the tab, or 5 minutes. This poll reads job status only and writes no audit row (check the route).
     - On `ready`, show **Download signed export**. It calls `/content` and saves `{export, signature}` as `audit-export-<id>.json` (Blob download, as the Attesta pack download does).
     - On `failed`, show the job's `error_code` in plain words, with the code below.
     - Under the button: "An outsider checks this file offline with `npm run audit:verify-export`." (item 6).
   - Both admins and auditors see this section. The export POST is auditor-allowed by design (Task16e).
5. **Move Attestation:**
   - Render `<AttestaWorkspace repositories={repositories} />` in the Audit view's **Attestation** tab (pass `repositories` into `AuditWorkspace`).
   - Remove the `attestation` Administration section (`page.tsx:195`, `:206`, `:628`).
   - Nothing else in Administration changes in this session. Hiding Administration from auditors entirely, and the broader volume and UX simplification the founder asked for, go to **Task10** (recorded by the lead in `TASK16.md` §5); do not start them.
6. **Offline audit-export verifier** (new):
   - `apps/api/src/features/audit/offline-export-verifier.ts`, the pure function `verifyAuditExport(download, options)`, implementing `export.md` steps 1–7 **in order and to the letter**. Reuse the trust, signature and anchor helpers of `offline-verifier.ts` by importing its exported functions. Export any helper you need from it, with no behaviour change; that is the only edit allowed there.
   - **Report:** `{exit_code: 0|1|2, checks: [{id, status, detail_code}], breaks: [{kind, seal_digest, row_id?}], unsealed: {count}}`. The breaks use the verify report's kinds. Unsealed events are reported, never a pass and never a break.
   - **CLI:** `apps/api/src/features/audit/audit-verify-export-cli.ts`, as `npm run audit:verify-export -w apps/api -- --export <file> (--root-keyid sha256:… | --customer-pin <file>) [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--json]`, mirroring `attesta-verify-pack-cli.ts`:
     - prints codes and counts only, never event details or key material;
     - exits with the report's code;
     - an unreadable file exits 2 with a clear message.
   - **Unit tests** (`offline-export-verifier.test.ts`): build a valid export in memory with a test key (reuse the fixtures or helpers of Task16e's `audit-seal.test.ts`). Then:
     - one pass;
     - one failing check per step: a wrong payload type, a changed manifest, a section digest mismatch, a `rows_root` mismatch, a broken `previous`, a seal statement that does not match, and an event changed, missing, or added inside a sealed window;
     - pending anchors give exit 2.

### 2.2 Port from
Task15j's offline evidence-pack verifier (`offline-verifier.ts`, itself ported from SushiCorp EV-2 `offline_verify.py` @ `0bd67a5`). Reuse its functions; do not re-port. UI-1 rules as in Task16f.

### 2.3 Pre-approved files
- `apps/api/src/features/audit/`: `read-service.ts` and `audit.routes.ts` (item 1 only), `audit-api.test.ts`, and new `offline-export-verifier.ts`, `offline-export-verifier.test.ts`, `audit-verify-export-cli.ts`.
- `apps/api/src/features/attesta/offline-verifier.ts`: `export` keywords on existing helpers only.
- `apps/api/package.json`: register the new test file; the `audit:verify-export` script, in alphabetical position.
- `apps/web/src/app/dashboard/audit-workspace.tsx`, `page.tsx` (item 5), `apps/web/src/lib/api.ts`: the audit client gains `excludeActions` in `AuditFilters`, plus `verifyAuditTrail`, `requestAuditExport`, `getAuditExport` and `downloadAuditExport`.
- `docs/handoffs/Task16f2-audit-export-ui_HANDOFF.md`; `docs/plan/TASK16.md` (the A16.7 and A16.8 rows and your session row only); `docs/plan/STATUS_BOARD.md` (your registry rows and the remaining-plan actual only).

### 2.4 Never touch
- Migrations.
- `docs/contracts/` (the verifier implements `export.md`; if it is ambiguous, write the question for the lead).
- Other Attesta behaviour.
- Other Administration sections.

## 3. Working rules
- **Commits** `Task16f2-audit-export-ui: …`, staged with explicit `git add <path>`. Commit in this order:
  1. the `exclude_action` API change;
  2. the offline verifier and CLI;
  3. the web client;
  4. the Audit view tabs and sections, plus the Attestation move;
  5. the handoff.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **IT-T16f2-01** (founder browser). Use the Task16f stack from its handoff. Also run `npm run attesta:audit-seal -w apps/api -- --confirm` once after a few audit events exist, so there is a seal. Then:
  1. As an auditor, Trail hides read receipts until the toggle is on.
  2. Check gives the green verdict and a "not sealed yet" count.
  3. Request export goes ready, and Download saves the file.
  4. The Attestation tab works as before; Administration has no Attestation section.
  5. As an admin, the same.
  6. As a developer, no Audit view.
- **IT-T16f2-02** (offline, founder):
  - `npm run audit:verify-export -w apps/api -- --export audit-export-<id>.json --root-keyid <the pinned root keyid printed by attesta:keys>` exits 0 (or 2 with "anchors pending" when anchoring is not configured locally; say which).
  - A copy with one event's details edited exits 1 with `changed_row`.
- **Review:** re-read your full diff as a reviewer before the handoff.

## 4. Close-out
- Handoff under 50 lines, with both IT steps and Effort.
- Clean tree. Do not push.
- **Final reply** in the AGENTS.md §12.4 shape. The bash block contains, in order:
  - tests, the IT commands;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16f2-audit-export-ui --title "[Task16f2] Audit verify and export UI, offline export verifier" --body-file docs/handoffs/Task16f2-audit-export-ui_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task16f2-audit-export-ui`; and `gh pr merge task/Task16f2-audit-export-ui --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok.

  Then the review request in a `text` block.

## Lessons so far
- **Task16f (Muse):** requests on user action only, because reads are audited. Every state designed. That worked; keep it.
- **Task16e (Claude):** the verify report's `unsealed_tail` is "not sealed yet", never "verified". `chain.ok` false with no breaks means signatures or anchors could not be checked, not tampering.
- **Reviews:** the lead returns only must-fix items. Get the spec right the first time: follow `export.md` step by step.
