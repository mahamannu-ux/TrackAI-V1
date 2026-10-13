# Handoff prompt: Task15i4-attesta-period-report (the signed `period_report` statement, reports in evidence packs), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Task15i3 is merged. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line.
> 3. Checkpoint: after its design note (step 2.2) it sends you the figure table and one question; answer in plain words.
> 4. When it finishes, paste its review request to **Codex** (or Muse with the attack-style request). Push only after "ready to push". This is the last Claude build session of A15.9.

---

You are **Claude**, building **Task15i4-attesta-period-report** (A15.9, part 3) for **TrackAI**, an AI code provenance product built on a fork of Git AI. Attesta signs, chains and anchors one statement per commit, merged PR and deployment. The evidence API is merged, with evidence packs and key-validity windows. This session adds the founder's **one signed figure**: "what share of repository X was AI-assisted between `from` and `to`, and prove it". It is a `period_report` statement:
- its subject is a report document;
- its figures are computed **only from signed statements**;
- it is chained and anchored like any statement;
- evidence packs then carry the report document.

No console (A15.11), no offline-verifier changes (Muse's A15.10 treats `reports` as not checkable until this merges), no per-developer figures, ever.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles go in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task15i4-attesta-period-report`.
- **Handoff:** `docs/handoffs/Task15i4-attesta-period-report_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 6–8, §4, §5, §7, §9 items 3, 4, 8, 16–21, §12.4) and `CLAUDE.md`.
2. Send the founder one request for folder access: `~/AIProjects`, plus `~/dev/sushicorp` and `~/dev/agent-kit` read-only. Ask once for delete permission on `~/AIProjects`. Clone `main` from a bundle, run `npm ci` and `npm test` once, and install `postgresql-16-pgvector`.
3. Estimate in one line against T6. The plan says **about 0.2×**. Above 0.25×, propose moving "reports in packs" (item 6) to a follow-up.

## 1. Read before writing
- **Binding:**
  - `docs/contracts/attesta/period-report.md`: the whole file; it fixes subject, predicate fields, figures, basis points and the rules.
  - `README.md`: availability, numbers, privacy, versioning, "Other levels".
  - `envelope.md`, `tables.md`: `record_kind`, typed columns null for a report.
  - `evidence-pack.md`: `reports` is reserved here.
  - `fields.md`: which predicate fields carry lines, tools, models.
  - `errors.md`.
- **Handoffs:** `Task15i2-attesta-evidence-packs_HANDOFF.md` and `Task15i3-attesta-verify-keys-resume_HANDOFF.md` (the job, lease and idempotency pattern to reuse); `Task15h` (builder, signing steps); `Task15d` (ledger guards).
- **Code** (`apps/api/src/features/attesta/`):
  - `ledger.ts`: `deriveStatementColumns` refuses any other predicate type today.
  - `apps/api/drizzle/0017_attesta_ledger.sql`: the check constraint and the guard functions that pin ai-provenance.
  - `verify-chain.ts`: `checkStatement`.
  - `builder.ts`, `worker.ts`: how a statement is signed and chained.
  - `evidence-pack-service.ts`: the job, the lease, `buildPack`, `reports`.
  - `merkle.ts`, `canonical.ts`, `contract-rules.ts`.
- **Catalog:** RP-1 (signed reports: a small statement names the digest; `{count, records}` per figure).

## 2. Scope
### 2.1 Lead decisions
1. **Contract (additive, lead-approved):**
   - New `docs/contracts/attesta/predicate-period-report-v1.schema.json`: Draft 7, closed objects, integers only, basis points 0–10000, the availability wrapper of README.md.
   - New `period-report-document-v1.schema.json`: the report document, RFC 8785; per figure the statement digests it summed and each statement's contribution (RP-1 `{count, records}`).
   - New `period-report.md` sections: the exact figure table (§2.2) and the rules.
   - `evidence-pack.md` and its schema: `reports` items become `{report_document, statement_digest}`. Lift `maxItems: 0`; that is additive for verifiers.
   - `errors.md`: new codes only if needed (builder and API sections).
2. **Ledger, second predicate type (migration `0022`, verify the number):**
   - Replace the 0017 check constraint and guard functions in a **new** migration: `CREATE OR REPLACE` the functions, drop and re-add the constraint. Never edit 0017.
   - A `period_report` record has `predicate_type` = `https://trackai.dev/attesta/period-report/v1`, `statement_kind` and `subject_sha` null, `outbox_subject_id` null, and `repository_id` from the subject name.
   - Every 0017 guard keeps holding for ai-provenance records byte for byte; prove it with the IT-T15d regression.
   - `ledger.ts` `deriveStatementColumns` accepts both types; `verify-chain.ts` checks both.
3. **The report:**
   - Read in one repeatable-read snapshot: the repository's signed ai-provenance statements with `recorded_at` in [`from`, `to`], plus the tenant chain range around them (the same boundary rule as packs). Build them from the **stored statement bytes** only, never from Task2 tables.
   - `as_of` comes from the database clock. `statements_root` is the RFC 6962 root over the included digests in `seq` order.
   - `previous` lists earlier reports for the same scope.
   - Validate the snapshot against the schema and the rules, sign with the tenant's statement key (`inventorySignerResolver`, `signVerified`), and chain in one ledger transaction, with no network call inside it.
   - Store the report document (table below) in the same transaction as the record.
   - Regenerating the same scope over the same chain gives byte-identical document bytes.
4. **Table `attesta_period_reports`** (same migration):
   - The job row in the `attesta_evidence_packs` style: idempotency key, scope, status only moving forward, lease, `error_code`.
   - Plus `report_document` (text, JCS), `report_digest`, and the `record_id` composite FK to `attesta_records` once chained.
   - RLS, composite keys, `withTenant`, guards in the 0020 style.
5. **Routes** (`attesta.routes.ts`, under `attesta.export`):
   - `POST /api/attesta/period-reports`: body `{repository_id, from, to}`, `Idempotency-Key` required, 202.
   - `GET /api/attesta/period-reports/{id}`: status, digest, `statement_digest` when chained.
   - `GET /api/attesta/period-reports/{id}/document`: the document, `no-store`, audited.
   - Add each route to the AU-1 sweep lists. Another tenant's id gets the same 404 as an unknown one.
6. **Reports in packs:** `buildPack` includes, for each in-scope `period_report` record in the segment, `{report_document, statement_digest}`. The oracle checks that the document's SHA-256 equals the statement's subject digest and that each figure recomputes from the pack's own statements.

### 2.2 Design checkpoint (stop once)
Send the founder:
- **The figure table:** for each v1 figure, the exact predicate fields it sums, its availability rule (a figure built on any `partial` or `unavailable` input says so in `completeness`), and one synthetic example. Task2 owns the metric semantics (AGENTS.md rule 8), so sum the signed fields; never redefine them.
- **The estimate.**
- **One question, with your recommendation:** does a commit that appears in several statements (observed, then merged) count once by subject sha, or per statement? Recommendation: once, by its latest statement in range, so "lines changed" never double-counts.

Continue on his answer.

### 2.3 Port from
SushiCorp @ `0bd67a5`:
- `services/reporting/{models,signing,report}.py`: the RP-1 statement, regeneration byte-identical, generation time never in the body.
- `tests/unit/reporting/test_reporting_integrity.py`: port first.
- `MODULE_S4-reporting_HANDOFF.md`.

Translate: an in-toto statement in DSSE instead of a JCS signature; figures in basis points.

### 2.4 Pre-approved files
- **Contract:** the contract files in item 1.
- **Database:** `apps/api/src/core/db/schema.ts` (the one table) and one new migration with its `meta/` snapshot.
- **Attesta code** (`apps/api/src/features/attesta/`), each with its tests:
  - `ledger.ts` (second type only), `verify-chain.ts` (second type only), `attesta.routes.ts`, `evidence-pack-service.ts` (item 6 only), `testing/evidence-pack-oracle.ts`;
  - new `period-report-service.ts`, `period-report-rules.ts`, `t15i4-period-report-live-verify.ts`.
- `apps/api/package.json` (scripts only).
- **Docs:** the handoff, `STATUS_BOARD.md`, `TASK15.md` (A15.9 status; A15.9 ✅ once merged and founder-run).

### 2.5 Never touch
Merged migrations `0000`–`0021`; `builder.ts`, `worker.ts`, `outbox.ts`, `trust-*.ts`, `anchor-*.ts`; the ai-provenance schemas and fixtures; Task2 files; `core/operations`, `core/middleware`, `app.ts`, `apps/web/`, dependencies.

## 3. Working rules
- **Commits:** `Task15i4-attesta-period-report: …`, in this order: ported tests; contract; migration; ledger and verify; report service; routes; packs; live test; handoff.
- **Unit tests:**
  - Regeneration byte-identical; no generation time in the body.
  - Each figure recomputed by an independent check from the document, and from the pack.
  - `partial` and `unavailable` inputs counted in `completeness`.
  - Basis points round-trip.
  - A tampered document, statement or figure is detected.
  - The 0017 guards still refuse every ai-provenance attack.
  - A/B isolation on the routes.
  - The raw-content scan, and no per-developer field anywhere.
- **Live:** `scripts/it-db.sh npm run verify:task15i4-period-report-live -w apps/api`.
  - `IT-T15i4-01`: builder statements → report → chained and anchored → `/verify` ok → pack with the report → the oracle recomputes the figures.
  - `IT-T15i4-02`: Company A/B.
  - `IT-T15i4-03`: idempotency, 409, and the guards on the new table and the replaced 0017 functions.
  - Run the IT-T15d, IT-T15i2 and IT-T15i3 regressions too.
- **Review:** one review subagent before the handoff. Ask it first: "can a report claim a figure its statements do not support, or leave a statement out?", then "does any 0017 guard accept something it refused before?".

## 4. Close-out
- **Handoff:** under 80 lines.
- **Tracking:** A15.9 ✅ once merged and founder-run; status board and registry rows.
- **Delivery:** bundle; PR.
- **Final reply:** in the §12.4 shape, with an attack-style review request in a `text` block.

## Lessons so far
- **Task15i2 (Claude):** review the test oracle as hard as the product. Treat every unsigned value in a document as attacker-controlled.
- **Task15i2 (founder):** cross-reviews find issues when the request lists attacks with reproductions.
- **SushiCorp S4:** determinism broke on the clock source and on counting live rows. Use stored bytes and the database clock only.
- **Task15d (Claude):** guard triggers run as the calling role. Test every guard as the API role and as an RLS-bound role.
