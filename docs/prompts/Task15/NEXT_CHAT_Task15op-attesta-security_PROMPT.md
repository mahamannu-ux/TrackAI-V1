# Handoff prompt: Task15op-attesta-security (signed security-finding seals and the security period report), Claude cloud session or Codex

> **Founder setup (agent: skip to "You are…"):**
> 1. Merge `task/Task15op0-signer-payload-cap` (the signer cap, already built) and this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`. `main` must contain Task20d (migration `0025`) and, preferably, Task20f.
> 2. **Agent:**
>    - **Claude (preferred; Attesta is Claude's code), as a cloud session:**
>      ```bash
>      cd ~/AIProjects/TrackAI-v1 && claude --cloud "You are the Task15op session. Read docs/prompts/Task15/NEXT_CHAT_Task15op-attesta-security_PROMPT.md and follow everything below its line. Push only task/Task15op-attesta-security; never main; never open or merge a PR."
>      ```
>    - **Or Codex**, in Worktree mode, after `make worktree M=Task15op-attesta-security`, if Claude usage is short. The prompt works for either.
> 3. **Checkpoint 1** (design, before any migration): the agent sends the design note. Paste it to the Task20 lead (Claude, standing in for the Task15 and Task19 leads, founder 2026-10-18) and paste the answer back.
> 4. Review: Claude's branch goes to **Codex**; Codex's branch goes to the **Task20 lead (Claude)**. This is signing and ledger code: merge only after "ready to push".

---

You are building **Task15op-attesta-security** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. It combines the planned Task15o (A15.15) and Task15p (A15.16) into one session (founder, 2026-10-18).

Attesta signs, chains and anchors statements per tenant. It already signs four predicate types:
- commit provenance;
- period reports (Task15i4);
- audit seals (Task16e);
- and it ships evidence packs and an offline verifier.

Security findings are not signed on their own yet (gap G6). Task20 has since moved findings onto **Numbat** (`docs/plan/TASK20.md`). Numbat findings arrive through `POST /worker/security/v2/records` into `security_findings` (`record_generation = 'v2'`), and many have no repository (`not_enrolled`).

This session adds two statement types:
1. **Security-finding seals**: a signed statement over a contiguous window of a tenant's security-finding rows, so an auditor can prove the high and critical register for a period was not added to, changed or pruned (questions S1, S10, S11 and S12; gap G6).
2. **The security period report**: one signed set of figures per tenant and period (S7, S8, S9, S11, S12), built from the sealed rows.

It does **not** touch ingest (Task20d), the Endpoint, case bundles (S25, Numbat `case build`: deferred to phase 2, keep simple), the console, or the Q&A answers.

- **Branch:** `task/Task15op-attesta-security` from `main`. **Handoff:** `docs/handoffs/Task15op-attesta-security_HANDOFF.md`.
- **Cloud session only:**
  - you may push `task/Task15op-attesta-security`, and nothing else; never open or merge a PR;
  - install `postgresql-16-pgvector` for `scripts/it-db.sh` (CLAUDE.md);
  - keep the session lean: read the files named here, and run long suites once per stage.

## 0. Before anything else
1. Read `AGENTS.md` (and `CLAUDE.md` if you are Claude) in full, especially:
   - §1 rules 1, 6, 7 and 9; §2 "Names";
   - §5a; §7; §9 items 3, 4 and 16–23 (the SushiCorp-ported ledger gotchas);
   - §10; §12.
2. `git log --oneline -1`, then create the branch. Set `mahamannu-ux` / `mahamannu@gmail.com` for this repository only.
3. Run `npm ci` and `npm test`.
4. **Estimate:** one line against T6. The lead's estimate is **about 0.35×**. If it is above 0.4×, split at checkpoint 1: (a) finding seals; (b) the security period report.

## 1. Read before writing
- **Attesta's contracts:**
  - `docs/contracts/attesta/README.md`, `envelope.md`, `tables.md`, `errors.md`;
  - **`audit-seal.md`**, the pattern you follow for seals, with its schemas;
  - **`period-report.md`**, the pattern for the report, with its schemas;
  - `docs/contracts/attesta/fields.md:40` (G6).
- **Code:**
  - in `apps/api/src/features/attesta/`: `audit-seal-service.ts`, `attesta-audit-seal-cli.ts`, `period-report-service.ts`, `period-report-rules.ts`, `ledger.ts` (predicate types, guards, `ATTESTA_STATEMENT_MAX_SIGNED_BYTES`), `merkle.ts`, `canonical.ts`, `evidence-pack-service.ts`, `offline-verifier.ts`;
  - migrations `0022_attesta_period_reports.sql` and `0023_attesta_audit_seals.sql` (how a predicate type was added to the ledger guards).
- **Handoffs:** `docs/handoffs/Task15i4-attesta-period-report_HANDOFF.md`, `docs/handoffs/Task16e-audit-tamper_HANDOFF.md`.
- **The data:**
  - `apps/api/src/core/db/schema.ts`: `security_findings` (both generations; v2 columns), `security_enforcement_decisions`, `fleet_machine_states`;
  - `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md`.
- **Questions:**
  - `docs/contracts/qa/questions.md`, rows S1, S7–S12;
  - `docs/plan/TASK19.md` §3 and §4 (G6 is assigned here);
  - `docs/plan/TASK15.md` A15.15, A15.16 and §7 item 18.

## 2. Scope (approved; design details confirmed at checkpoint 1)
### 2.1 Decisions
1. **Seals instead of one statement per finding (lead's recommendation, confirmed by the founder at checkpoint 1).**
   - **What is new:** A15.15 planned a `finding_observed` outbox row per finding. Numbat findings often have no repository or commit, while Attesta's outbox and commit subjects require both, and one signature per finding would multiply signing at fleet volume. So Task15op seals **windows of finding rows** exactly as Task16e seals audit rows (RP-1 pattern).
   - **What a seal proves:** a deleted, changed or late-inserted finding row in a sealed window is detectable, which is what S1 asks for.
   - **The ingest path is unchanged:** no outbox and no change to Task20d's transaction.
2. **Seal document** `https://trackai.dev/attesta/security-findings-seal-document/v1`. It mirrors `audit-seal-document/v1`:
   - `tenant_id`;
   - `window {from, to}` over `received_at` (half-open, microsecond text). It uses `received_at`, not `occurred_at`, so a late upload falls into a later window rather than reopening a sealed one;
   - `previous` (the previous seal's digest);
   - `count`;
   - `rows [{id, digest}]` ordered by (`received_at`, `id`);
   - `rows_root`, the RFC 6962 root.

   The **row digest** is JCS over a fixed, metadata-only projection of the row:
   - id, generation, machine and repository ids, `repository_kind`;
   - `rule_id`, `rule_version`, category, severity;
   - agent, model, session;
   - `occurred_at`, `received_at`, `rule_pack_version`, `bundle_digest`, `lease_id`, `found_at_rest`;
   - for Task6.a rows: phase, timing and effect.

   It **never** includes previews or `security_finding_previews`.
3. **Seal statement.**
   - Subject `trackai:tenant/<uuid>/security-findings/<from>..<to>`, digest = SHA-256 of the document bytes.
   - Predicate type `https://trackai.dev/attesta/security-findings-seal/v1`, with fields as `audit-seal.md`'s predicate (without `rows`), plus `generations` (the counts per generation).
   - Envelope, ledger chain and anchoring exactly as `envelope.md` and `tables.md`. Signing is bounded by `ATTESTA_STATEMENT_MAX_SIGNED_BYTES`: cap a window at the number of rows that fits, and seal in chunks.
4. **Security period report** `https://trackai.dev/attesta/security-period-report/v1`, following `period-report.md`, with tenant scope (or one repository).
   - **Subject:** `trackai:tenant/<uuid>/security-period/<from>..<to>`.
   - **Inputs:** the seals covering the period (`seal_count`, and `seals_root` over their statement digests). Figures are computed only from sealed rows; a period with unsealed rows is refused with a safe code until it is sealed.
   - **Figures, integers only:**
     - findings by severity, category, rule, repository (with `not_enrolled`), agent, model (with `unknown`) and platform (from `fleet_machine_states`, or `unavailable`);
     - Task6.a requested and observed_result, and v2 unclassified (S11);
     - `denied_by_request` from enforcement decisions;
     - `blocked: {availability: "unavailable", reason: "monitor_only_observed"}`;
     - `rule_pack_versions` (distinct count).
   - **Coverage** (S2) is `unavailable`, `not_captured_yet` G7.
   - **Completeness** per figure, as `period-report.md` defines it.
5. **Ledger:** one migration (the next number) that:
   - extends the predicate-type guard and shape checks to the two new types, exactly as `0022` and `0023` did for theirs;
   - adds `attesta_security_finding_seals` and `attesta_security_period_reports` (the `attesta_audit_seals` columns and checks pattern, composite tenant foreign keys to `attesta_records`, RLS without browser policies, guard triggers `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`, append-only with TRUNCATE blocked).

   Contract files are added under `docs/contracts/attesta/` as **new** files: `security-findings-seal.md`, `security-period-report.md` and their schemas, plus additive `errors.md` codes. Existing frozen files stay unchanged, apart from additive rows in the `README.md` files table and `errors.md`, as Task15i4 and Task16e did.
6. **Jobs and CLI:**
   - `attesta:security-seal` seals every complete window up to now minus 10 minutes (late uploads still in flight), dry-run first, `--confirm`, with an audit event using the same action family as audit seals;
   - `attesta:security-report --from --to [--repository]` builds the report;
   - both are idempotent.
7. **Verification:**
   - extend `/api/attesta/verify` and the offline verifier so both new predicate types verify (signature, chain and anchor as today);
   - add a seal check that recomputes `rows_root` from the current rows and names `missing_row`, `changed_row` and `unsealed_row_in_sealed_window`, as audit seals do;
   - evidence packs include seals and reports for the requested period.

### 2.2 Port from
- **The audit seal** (Task16e) and **the period report** (Task15i4): copy their structure, tests and live-verify shape, and record "pattern: Task16e audit-seal / Task15i4 period-report (SushiCorp RP-1)".
- No new SushiCorp port.

### 2.3 Pre-approved files
- In `apps/api/src/features/attesta/`: new `security-seal-service.ts`, `security-report-service.ts`, their rules, CLIs and tests, `t15op-security-live-verify.ts`; and additive edits to `ledger.ts`, `verify-chain.ts` (or the verify module), `offline-verifier.ts`, `evidence-pack-service.ts`, `attesta.routes.ts`.
- `core/db/schema.ts` (the two tables only), one migration and its `meta/`.
- New contract files under `docs/contracts/attesta/`, plus additive `README.md` and `errors.md` rows.
- `apps/api/package.json` (scripts).
- `core/audit/catalog.ts` (additive actions only).
- The handoff; your own rows in `docs/plan/TASK15.md` (A15.15, A15.16, Task15op), `docs/plan/TASK19.md` (G6 row status only) and `docs/plan/STATUS_BOARD.md`.

### 2.4 Never touch
- `docs/contracts/security-v2/**`, `docs/contracts/task6/**`, other frozen contract text;
- merged migrations;
- `features/security-findings/**` (read only), `features/qa/**`, the web app, GitAI.

## 3. Working rules
- **Stages,** each committed (`Task15op: …`):
  1. **design note** (checkpoint 1): documents, subjects, row projection, windowing, report figures, migration outline, estimate;
  2. contracts and schemas, with fixtures;
  3. migration and ledger guards;
  4. seal service, CLI and verification;
  5. report service and CLI;
  6. verify, pack and offline-verifier support;
  7. the live verify;
  8. the handoff.
- **Tests,** in-process with the dev signer:
  - seal round trip;
  - each tamper class detected;
  - chunking at the 1 MiB bound;
  - report figures from synthetic rows of both generations;
  - `not_enrolled` and unknown buckets;
  - an unsealed period refused;
  - the offline verifier accepting both types;
  - Company A/B.
- **IT-T15op-01** (blocking for this merge): `scripts/it-db.sh npm run verify:t15op-security-live -w apps/api`. It seeds both generations, seals, reports, verifies, tampers (delete, update, late insert, done as table owner), runs the verify report again and checks Company A/B. Run it once, small.
- **Review:** an independent review (a subagent for Claude, `/review` for Codex) before the handoff.

## 4. Close-out
- **Handoff** under 100 lines. It names the predicate types, documents, CLIs and verify codes, what Task19 and A16.13b can use, the deferred case bundles (S25), and Effort.
- **Cloud:** push the branch. **Codex:** leave the tree clean, without pushing.
- **Final reply** in the AGENTS.md §12.4 shape. One numbered bash block:
  1. fetch or check out the branch;
  2. `npm ci && npm test`;
  3. IT-T15op-01;
  4. under `# after the cross-agent review`: `gh pr create --base main --head task/Task15op-attesta-security --title "[Task15op] Attesta security seals and period report" --body-file docs/handoffs/Task15op-attesta-security_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`, the preflight, and the merge.

  Then the review request in a `text` block.

## Lessons so far
- **Task16e (Claude):** sealing rows with a Merkle root and chained seals made tampering detectable without a second chain or signer; reuse it rather than inventing per-row signing.
- **Task15i4 (Claude):** a second predicate type needs the ledger guards replaced in one migration; dry-run it first.
- **Task20f (Claude):** signing caps are per signer; statements stay at 1 MiB (`ATTESTA_STATEMENT_MAX_SIGNED_BYTES`).
