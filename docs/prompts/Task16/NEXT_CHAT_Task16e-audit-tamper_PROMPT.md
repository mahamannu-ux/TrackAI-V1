# Handoff prompt: Task16e-audit-tamper (audit seals in the Attesta ledger, signed audit export, auditor read-only database role), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Task16c (PR #63) and this prompt's docs PR are merged. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, and paste everything below the line. It can run alongside Muse's Task16f; the two touch different files.
> 3. Checkpoint: after its design note (§2.2) it sends you the seal and export formats, the estimate and two questions. Answer in plain words.
> 4. When it finishes, paste its review request to **Codex**. This is signing and tenant isolation, so it is security-critical and Muse alone is not enough. Push only after "ready to push".

---

You are **Claude**, building **Task16e-audit-tamper** (Task16 A16.4 + A16.7 + A16.10) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

The audit trail now has one contract and one writer, `recordAuditEvent()`, and an auditor read API (`/api/audit`, Task16c). It is append-only by trigger, but nothing proves that no row was deleted or changed. This session adds three things:
1. **Tamper evidence (A16.4):** periodic **audit seals**. Each is a signed Attesta statement over a contiguous window of audit rows, chained and anchored in the tenant's existing Attesta ledger. Then a verify report that recomputes every sealed row.
2. **A signed audit export (A16.7)** that an outsider can check.
3. **A read-only database role for auditor reads (A16.10).** The database itself refuses writes, and refuses rows from another tenant, on the auditor read path.

Task16 never builds a second chain or signer (`TASK16.md` D1–D2): everything signs, chains and anchors through Attesta (Task15). No web change: the console card comes in Task16f2.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles go in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task16e-audit-tamper`.
- **Handoff:** `docs/handoffs/Task16e-audit-tamper_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §5, §7, §9 items 3, 4, 10, 16–23, §10 AP-1, §12.4) and `CLAUDE.md`.
2. Send the founder one request for folder access: `~/AIProjects`, plus `~/dev/sushicorp` and `~/dev/agent-kit` read-only. Ask once for delete permission on `~/AIProjects`. Clone `main` from a bundle, run `npm ci` and `npm test` once, and install `postgresql-16-pgvector`.
3. Estimate in one line against T6. The plan says **about 0.2×**. If your estimate is above 0.25×, propose at the checkpoint that A16.10 moves to its own small session.

## 1. Read before writing
- **Audit:**
  - `docs/contracts/audit/` (README, `event-v1.schema.json`, `catalog.md`);
  - `apps/api/src/core/audit/` (`catalog.ts`, `record.ts`);
  - `apps/api/src/features/audit/` (`read-service.ts`, with the exact-text `occurred_at` rule; `audit.routes.ts`; `http.ts`);
  - `docs/handoffs/Task16b-audit-contract_HANDOFF.md` and `Task16c-audit-emitters-api_HANDOFF.md`.
- **Attesta (Task15), how to add a predicate type:**
  - `docs/contracts/attesta/period-report.md` and `apps/api/drizzle/0022_attesta_period_reports.sql`: the second predicate type, and the guard functions it replaced with `CREATE OR REPLACE`;
  - `docs/handoffs/Task15i4-attesta-period-report_HANDOFF.md`;
  - `features/attesta/ledger.ts` (`deriveStatementColumns`), `verify-chain.ts` (`checkStatement`), `period-report-service.ts` (job, lease, snapshot, signing, chaining in one transaction), `evidence-pack-service.ts` (pack sections, the DSSE pack signature), `merkle.ts`, `canonical.ts`, `trust-inventory.ts` (`inventorySignerResolver`), `worker.ts`;
  - `docs/contracts/attesta/evidence-pack.md`, `envelope.md`, `tables.md`, `trust.md`, `errors.md`.
- **Schema:** `core/db/schema.ts:572-586` (`security_audit_events`); `apps/api/drizzle/0003_lean_prima.sql:103-118` (the append-only trigger: `BEFORE UPDATE OR DELETE` only, no TRUNCATE guard).
- **Catalog:**
  - **AU-1 layer 4** (Postgres role `NOLOGIN`, SELECT only, entered with transaction-local `SET ROLE`): SushiCorp `0bd67a5:db/session.py`, `0bd67a5:db/migrations/versions/0006_identity.py`;
  - **EV-1** (hash chain);
  - **RP-1** (signed reports: a small statement names the document digest; `{count, records}`).

## 2. Scope
### 2.1 Lead decisions
1. **Audit seal, a new Attesta predicate type** `https://trackai.dev/attesta/audit-seal/v1`, contract additive under `docs/contracts/attesta/`:
   - `audit-seal.md`;
   - `predicate-audit-seal-v1.schema.json`;
   - `audit-seal-document-v1.schema.json`;
   - new `errors.md` codes only if needed.

   **The seal document** (RFC 8785 bytes, stored) has these fields:

   | Field | Content |
   |---|---|
   | `format` | the format identifier |
   | `tenant_id` | the tenant |
   | `window` | `{from, to}`: half-open, compared with `occurred_at`, both the exact microsecond text Task16c uses |
   | `previous` | the previous seal's document digest, or `null` for the tenant's first seal |
   | `catalog_version` | the audit catalog version |
   | `count` | the number of rows |
   | `rows` | `[{id, digest}]` in `(occurred_at, id)` order |
   | `rows_root` | the RFC 6962 root over the row digests (`merkle.ts`) |

   **A row digest** is `"sha256:" + hex(SHA-256(JCS(row)))`. `row` is the stored row as `event-v1` returns it, **without** the derived `severity` and `catalog_version`, with `occurred_at` as the exact text.

   **The statement:**
   - subject `trackai:tenant/<tenant UUID>/audit/<from>..<to>`, digest = the document's SHA-256;
   - `repository_id`, `statement_kind` and `subject_sha` are null.

   **Windows are contiguous:**
   - a new seal's `from` is the previous seal's `to`;
   - a tenant's first seal starts at its earliest row;
   - `to` ≤ database clock − 5 minutes, the same margin and reason as evidence packs (`evidence-pack.md`).

   So a deleted row changes a sealed `rows_root`, a row inserted late into a sealed window appears in no seal, and a missing seal breaks the `previous` chain.
2. **The ledger accepts the new type** in a **new migration** (check the next number; 0022 is the latest at this prompt):
   - `CREATE OR REPLACE` the guard functions, and drop and re-add the check constraint, as 0022 did. Never edit 0017 or 0022.
   - In the same migration:
     - add `BEFORE TRUNCATE` guards on `security_audit_events` (AGENTS.md §9 item 21: `SECURITY DEFINER`, fixed `search_path`);
     - create the `attesta_audit_seals` table: the job, lease and status of the 0022 style, `seal_document` text, `seal_digest`, the window, `previous_digest`, a composite FK to `attesta_records` once chained, RLS, composite tenant keys, an append-only guard after chaining;
     - create the role in item 6.
   - `ledger.ts` and `verify-chain.ts` accept the type. Every existing guard keeps holding for ai-provenance and period-report records byte for byte; prove it with the IT-T15d and IT-T15i4 regressions.
3. **Who seals and when:**
   - **Cadence:** one sealing pass per tenant, run by the Attesta worker loop and by a CLI `attesta:audit-seal` (dry run first, `--confirm`; AGENTS.md §9 item 10). A tenant gets a seal when it has unsealed rows older than 5 minutes **and** its last seal is at least an hour old, or once a day even with no rows (an empty window still proves "nothing happened").
   - **Reading:** in one repeatable-read snapshot.
   - **Signing:** with the tenant's statement key (`inventorySignerResolver`, `signVerified`). No network call inside the chain-lock transaction (§9 item 18).
   - **Storing:** chain and store the document in one transaction.
   - **Audit:** the sealing pass writes `audit.trail.sealed` (new action, item 7).
4. **Verify report:** `GET /api/audit/verify?from&to` (`audit.read`; AP-1; `no-store`).
   - For every seal overlapping the window, recompute each sealed row's digest from the current table and the `rows_root`, and check the `previous` links. Run Attesta's chain, signature and anchor check over the seal records' seq range, reusing the verify functions behind `/api/attesta/verify`.
   - Report:
     - `ok`;
     - `seals_checked`;
     - `breaks: [{kind: missing_row | changed_row | unsealed_row_in_sealed_window | broken_previous | statement_problem, seal, row_id?}]`;
     - `unsealed_tail: {from, count}` (rows newer than the last seal: "not sealed yet", never "verified").
   - Writes `audit.trail.verified`.
5. **Signed audit export:** `POST /api/audit/exports` (`Idempotency-Key`, 202), `GET /api/audit/exports/:id`, `GET /api/audit/exports/:id/content`. The job, lease and replay pattern is the one evidence packs use.
   - **The content** is `{export, signature}`.
   - **The export** (JCS) contains:
     - `manifest`: format `https://trackai.dev/audit/export/v1`, export id, tenant, scope `{from, to}`, `generated_at`, `counts`, `sections` digests;
     - `events`: the window's rows as stored (without derived fields);
     - `seals`: the seal documents covering the window;
     - `seal_evidence`: the seal statements with their envelopes, ledger records and anchors, plus the trust documents. Use the exact section shapes of `evidence-pack-v1`, reusing its builders, but **only for the seal records**. Completeness comes from the contiguous `previous`-linked seals, not from the whole chain.
   - **The signature:** a DSSE envelope over `{manifest, export_digest}`, payload type `application/vnd.trackai.audit-export+json` (distinct from packs and statements), signed with the tenant's active statement key. Not chained; the pack-signature rule.
   - Writes `audit.export.requested` and `audit.export.downloaded`.
   - **Offline verifier support** for this format is **Task16f2** (Muse), not this session: write the verification steps in `docs/contracts/audit/export.md` precisely enough for that.
6. **Auditor read-only role (AU-1 layer 4),** a `NOLOGIN` role `trackai_audit_reader`:
   - **Grants:** `SELECT` only, on `security_audit_events` and `attesta_audit_seals`. Granted to the API's role, so the API can `SET LOCAL ROLE`.
   - **Policies:** `USING (tenant_id = current_setting('trackai.tenant_id', true)::uuid)` for that role. The API role still bypasses RLS (AGENTS.md §9 item 3); this role does not.
   - **Read path:** `pgAuditStore` and the legacy admin audit list run their select under `set_config('trackai.tenant_id', <tenant>, true)` and `SET LOCAL ROLE trackai_audit_reader`, then `RESET ROLE` before the same transaction writes `audit.events.read`. The verify report's reads do the same.
   - **Proof:**
     - under the role, an `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` fails;
     - a select with **no** tenant predicate returns only the configured tenant's rows;
     - a missing setting returns nothing.
   - **Other auditor reads** (Attesta reads, security findings) adopt the helper later: add a row for that to `docs/plan/BUG_BACKLOG.md`.
   - **Supabase:** say in the handoff whether creating a role from a migration needs anything on hosted Supabase.
7. **New audit actions** (additive; bump `AUDIT_CATALOG_VERSION` to 2; regenerate `catalog.md`):

   | Action | Severity | Actor | Details |
   |---|---|---|---|
   | `audit.trail.sealed` | info | `service` or `system_operator` | `window_from`, `window_to`, `count`, `seal_digest`, `request_id` |
   | `audit.trail.verified` | info | admin or auditor | `from`, `to`, `ok`, `seals_checked`, `break_count`, `request_id` |
   | `audit.export.requested` | info | admin or auditor | `scope_from`, `scope_to`, `replayed`, `request_id` |
   | `audit.export.downloaded` | info | admin or auditor | `scope_from`, `scope_to`, `export_digest`, `counts`, `request_id` |

   Names and keys follow the v1 naming rule (snake_case).
8. **Sweep:** the new routes join `auditRouter`'s table in `auditor-sweep.test.ts`. The export POST goes in `AUDITOR_ALLOWED_WRITES` with its reason ("creates an audited export job; changes no audit row").

### 2.2 Design checkpoint (stop once)
Before the migration, send the founder:
- the seal document and export formats, each with one synthetic example;
- the cadence (item 3);
- the estimate;
- two questions, each with your recommendation:
  1. **Should the first seal of an existing tenant cover all its history at once,** or start at the deploy time? *Recommendation:* all history, because the rows are already append-only.
  2. **Should the export window be limited** (for example 1 year per export)? *Recommendation:* yes, 1 year, with the job refusing more, like the packs' bounds.

### 2.3 Port from
- SushiCorp **AU-1** layer 4 (`db/session.py`, migration `0006_identity.py` @ `0bd67a5`). Port the role, the transaction-local `SET ROLE` and its tests.
- **RP-1** (a document named by digest in a small statement), as already translated by Task15i4.
- **EV-1** is reused through Attesta, not re-ported.

Record the provenance and the deviations: Postgres RLS policies for the role, which SushiCorp did not use (TN-1).

### 2.4 Pre-approved files
- The new migration with its `meta/` snapshot.
- `core/db/schema.ts`: the `attesta_audit_seals` table only.
- `features/attesta/`:
  - `ledger.ts`, `verify-chain.ts`, `worker.ts` (the sealing pass);
  - a new `audit-seal-service.ts`, a new `attesta-audit-seal-cli.ts`;
  - the shared section builders in `evidence-pack-service.ts`, exported for reuse, with no behaviour change.
- `docs/contracts/attesta/`: the three new files above, plus additive `errors.md` lines.
- `docs/contracts/audit/`: a new `export.md`, a new `export-v1.schema.json`, and additive README lines.
- `core/audit/catalog.ts` (item 7) and the regenerated `catalog.md`.
- `features/audit/`: new routes in `audit.routes.ts`, a new `export-service.ts` and `verify-service.ts`, the role in `read-service.ts`.
- `core/security/admin-resource-service.ts` (the role on the legacy list); `core/security/auditor-sweep.test.ts`.
- `apps/api/package.json`: test registration, the `attesta:audit-seal` script, `verify:task16e-*` scripts, all in alphabetical position.
- `docs/plan/BUG_BACKLOG.md` (one row); `docs/plan/TASK16.md` (A16.4, A16.7 and A16.10 rows and your session row); `docs/plan/STATUS_BOARD.md` (registry rows and the remaining-plan actual); the handoff.

### 2.5 Never touch
- Merged migrations, and existing contract text (additive lines only).
- `apps/web/` (Task16f / 16f2).
- Any existing audit action or details key.
- The Attesta statement, period-report and pack formats, except exporting shared builders.

## 3. Working rules
- **Commits** `Task16e-audit-tamper: …`, interfaces first.
- **Gates:** `npm run lint`, `npm run typecheck`, `npm run check` clean; `drizzle-kit check` clean; the migration dry-run first (§9 item 4).
- **Unit tests, without a database:**
  - row digest vectors (including microsecond text and nested details);
  - document determinism (same rows, same bytes);
  - every break kind detected from in-memory fixtures;
  - the export's sections and signature checked against a test key;
  - catalog additions;
  - the sweep.
- **Integration tests** through `scripts/it-db.sh`, each run once in your sandbox:
  - **IT-T16e-01, seal and verify:**
    - seal a window;
    - as the database owner on the throwaway database, disable the guard trigger and delete one row, then change one row's details, then insert one row back-dated into the sealed window;
    - verify reports exactly those three breaks;
    - `TRUNCATE` is refused while the guard is on;
    - empty and contiguous windows chain.
  - **IT-T16e-02, export:** request, replay and download; the signature verifies with the trust layer; the sections' digests match; Company B cannot fetch A's export (same 404).
  - **IT-T16e-03, role:**
    - under `trackai_audit_reader`, every write is refused;
    - a select with no predicate returns only the configured tenant's rows, and nothing without the setting;
    - the audit read API and the legacy list still pass IT-T16c-01 with the role in place.
  - **Regressions:** IT-T15d, IT-T15i2, IT-T15i4 and IT-T16c-01 (name their exact `verify:*` scripts in the handoff).
- **Review:** one independent review subagent before the handoff (give it this prompt, the two Task16 handoffs and the diff), then Codex's cross-review.

## 4. Close-out
- Handoff under 80 lines. It must name:
  - the new predicate type, tables, routes and codes;
  - the founder's checkpoint answers;
  - the Task16f2 inputs: export verification steps, and the verify report shape for the console card;
  - the Supabase role note;
  - Integration test impact;
  - **Effort**.
- `docs/plan/STATUS_BOARD.md`: your registry rows and the remaining-plan actual only. The lead updates the Task16 row.
- Clean tree. Do **not** push.
- **Final reply** in the AGENTS.md §12.4 shape. The bash block contains, in order:
  - fetch the bundle, `npm ci`, `npm test`, the three IT commands and the regressions;
  - under `# after the cross-agent review`: push; `gh pr create --base main --head task/Task16e-audit-tamper --title "[Task16e] Audit seals, signed export, auditor DB role" --body-file docs/handoffs/Task16e-audit-tamper_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task16e-audit-tamper`; and `gh pr merge task/Task16e-audit-tamper --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok.

  Then the review request for Codex in a `text` block.

## Lessons so far
- **Task16b/16c:** audit names and keys are frozen (migration 0021's trigger reads them); new actions are additive and bump the catalog version. `occurred_at` holds microseconds: never round-trip it through a JS `Date`. The only-writer test means every new audit write goes through `recordAuditEvent()`.
- **Task15i4 (Claude):** adding a predicate type means replacing guard functions in a new migration and proving that every older guard still holds byte for byte. Plan for that test time.
- Cite `file:line` for every fact you encode.
