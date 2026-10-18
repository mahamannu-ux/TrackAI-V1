# Handoff prompt: Task15op-b-attesta-security-report (the signed security period report), Claude cloud session

> **Founder setup (agent: skip to "You are…"):**
> 1. Task15op-a is merged (PR #86). This prompt reaches `main` through `task/Task15op-attesta-security` (docs-only follow-up). The session was started from that branch on 2026-10-18 by the Task15op-a session.
> 2. **Agent:** Claude, as a cloud session:
>    ```bash
>    cd ~/AIProjects/TrackAI-v1 && claude --cloud "You are the Task15op-b session. Read docs/prompts/Task15/NEXT_CHAT_Task15op-b-attesta-security-report_PROMPT.md and follow everything below its line. Push only task/Task15op-b-attesta-security-report; never main; never open or merge a PR."
>    ```
> 3. **No checkpoint:** every design decision is made below. The session stops and asks only if the frozen contract or migration 0027 turns out to be insufficient (see §2.4).
> 4. **Review:** Claude's branch goes to **Codex** (§12.6). This is signing and ledger code: merge only after "ready to push" (or the founder's explicit skip).

---

You are building **Task15op-b-attesta-security-report** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. It is part b of Task15op (A15.16). The founder split Task15op at checkpoint 1 on 2026-10-18.

**Task15op-a (merged, PR #86) already delivered:**
- **Seals:** security-finding seals (`docs/contracts/attesta/security-findings-seal.md`, `features/attesta/security-seal-service.ts`). A seal is a signed statement over a contiguous window of a tenant's `security_findings` rows (Task6.a and Numbat v2) by `received_at`. It comes with:
  - `attesta:security-seal`;
  - `GET /api/attesta/security-seals/verify`.
- **The report's frozen contract:** `docs/contracts/attesta/security-period-report.md`, `predicate-security-period-report-v1.schema.json` and `security-period-report-document-v1.schema.json`.
- **Ledger support for the report (migration 0027):**
  - the predicate type `https://trackai.dev/attesta/security-period-report/v1`;
  - its chain-guard arm and the `deriveStatementColumns` support (`SECURITY_PERIOD_REPORT_PREDICATE_TYPE` in `ledger.ts`; tenant scope `repository_id` null, or one repository);
  - the append-only table `attesta_security_period_reports` with its insert guard;
  - the offline verifier's acceptance of the type.

**This session builds the report itself:** one signed set of security figures per tenant (or repository) and period, computed **only from sealed, verified rows**. It answers questions S7, S8, S9, S11 and S12 (`docs/contracts/qa/questions.md`).

- **Branch:** `task/Task15op-b-attesta-security-report` from `main`, or from `origin/task/Task15op-attesta-security` while this prompt has not reached `main` (that branch is `main` plus this prompt and status updates). **Handoff:** `docs/handoffs/Task15op-b-attesta-security-report_HANDOFF.md`.
- **Cloud session only:**
  - you may push `task/Task15op-b-attesta-security-report`, and nothing else; never open or merge a PR;
  - install `postgresql-16-pgvector` for `scripts/it-db.sh` (CLAUDE.md);
  - keep the session lean: read the files named here, and run long suites once per stage.
- **Estimate:** about **0.18× T6**. Say so in one line at the start. If you see it above 0.25×, say why before building.

## 0. Before anything else
1. Read `AGENTS.md` (and `CLAUDE.md`) in full, especially:
   - §1 rules 1, 6, 7 and 9;
   - §5a, §7, §9 items 3 and 16–23, §10, §12.
2. `git log --oneline -1` on `main`, then create the branch. Set `mahamannu-ux` / `mahamannu@gmail.com` for this repository only.
3. Run `npm ci` and `npm test`: all green on `main` at the time of writing.

## 1. Read before writing
- **Contracts:**
  - `docs/contracts/attesta/security-period-report.md`: the design, binding. You add detail (rules SR1–SR9, the decision digest); you never contradict it;
  - its two schemas;
  - `security-findings-seal.md`;
  - `period-report.md`: rules P1–P10, the pattern;
  - `envelope.md`, `tables.md`, `errors.md`;
  - `fields.md` "Numbers, strings and privacy" (the token rule and the `sha256:` fallback).
- **Code:**
  - `features/attesta/security-seal-service.ts`: `readSecurityRows`, `checkSecuritySealRows`, `readSecurityVerifySnapshot`, `assembleSecurityVerifyReport`, `compareSecurityRows`, `nextMicrosecond`, `SecuritySealError`;
  - `period-report-service.ts` and `period-report-rules.ts`: `digestsRoot`, the document/predicate split, `buildReportStatement`, the chain-transaction pattern;
  - `ledger.ts` (`chainStatement`, `statementSigningLimit`);
  - `attesta-security-seal-cli.ts` (CLI pattern);
  - `attesta.routes.ts` (`handle`, `exportAuth`, `sendJson`, the route sweep in `attesta-api.test.ts`);
  - `t15op-security-live-verify.ts`: the world setup, `reportStatement` and `chainReport`, which already chain report statements.
- **Data:** `core/db/schema.ts`:
  - `securityFindings`;
  - `securityEnforcementDecisions`;
  - `fleetMachineStates` (`platform`: `macos` | `windows` | null; current state only);
  - `attestaSecurityPeriodReports`.
- **Handoffs:**
  - `docs/handoffs/Task15op-attesta-security_HANDOFF.md`;
  - `docs/handoffs/Task15i4-attesta-period-report_HANDOFF.md`.

## 2. Scope (decided; no checkpoint)

### 2.1 The builder (`security-report-service.ts`, `security-report-rules.ts`)

**Request**
- `{tenantId, repositoryId | null, from, to}`: RFC 3339 UTC with milliseconds, half-open `[from, to)` over `received_at`.
- `from` < `to`; `to` ≤ database clock − 10 minutes; at most 366 days. Otherwise refused as invalid input.
- A repository must be the tenant's: another tenant's repository and an unknown one get the same refusal.

**Coverage, read in one repeatable-read, read-only snapshot**
1. The tenant's latest seal must have `window_to` ≥ `to`, comparing the microsecond text against `to` padded with `000`. Otherwise refuse with `ATTESTA_SECURITY_PERIOD_NOT_SEALED`.
2. If the tenant has no seal at all, the report is also `ATTESTA_SECURITY_PERIOD_NOT_SEALED`.
3. The **covering seals** are those whose window overlaps `[from, to)`. For each one, check its stored document (`parseSecuritySealDocument`), its rows (`checkSecuritySealRows`) and its `previous` links (`checkSealLinks`, with the predecessor read as in `readSecurityVerifySnapshot`). Also check for rows received before the tenant's first seal within the period.
4. Any break, or a covering seal whose statement problem shows, refuses with `ATTESTA_SECURITY_SEAL_BROKEN`. The Attesta signature and anchor check is not repeated here; `/api/attesta/verify` covers it.
5. Reuse the seal service's functions. Never copy them.

**Counted rows**
- The intact sealed rows with `from` ≤ `received_at` < `to`, filtered to the repository for repository scope.
- `inputs.row_count` and `inputs.rows_root` are taken over their **seal row digests**, in (`received_at`, `id`) order.
- `seals` in the document: `{seq, statement_digest, seal_digest, window}` in window order. `inputs.seals_root` is over their statement digests.

**Figures** (exactly the contract table)
- **Bucket keys:**
  - `repository_id`, with `not_enrolled` for v2 rows without one;
  - `agent_family` for Task6.a, `source_agent` for v2;
  - `model` for v2, with null and every Task6.a row going to `unknown`.
- **Model values:** a value that fails the token pattern `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` becomes `sha256:<hex of its UTF-8>`, and the figure becomes `partial` / `values_hashed_unrepresentable`.
- **`by_platform`:**
  - Task6.a rows use the sealed `operating_system`.
  - v2 rows use `fleet_machine_states.platform` read in the same snapshot. A missing row or a null platform goes to the `unavailable` bucket.
  - The figure is `partial` / `current_machine_state` whenever any v2 row contributes.
  - The document lists `machine_platforms [{machine_id, platform}]`, sorted by `machine_id`, for the v2 machines only, with no counts.
- **`outcomes`:** Task6.a `phase` (`requested`, `observed_result`, `partial`, `unavailable`); every v2 row is `v2_unclassified`.
- **`denied_by_request`:**
  - **Counts:** rows of `security_enforcement_decisions` for the tenant with `decision = 'deny'` and `received_at` in the period. Tenant scope only; for repository scope it is `unavailable` / `not_applicable` with `decisions: []`.
  - **Availability:** `partial` / `not_sealed` whenever a decision exists. `recorded` 0 when none do.
  - **Digest:** a **decision digest** = `"sha256:" + hex(SHA-256(JCS(projection)))`. The projection is every column of the decision row except `tenant_id`, verbatim, with timestamps as microsecond text and arrays as JSON arrays. Write the exact key list into the contract.
  - **Document:** `decisions [{id, digest}]` in (`received_at`, `id`) order; `inputs.decision_count` and `inputs.decisions_root` are over those digests.
- **Fixed figures:** `blocked` is always `{unavailable, monitor_only_observed}`; `coverage` is always `{unavailable, not_captured_yet}`.
- **`late_arrivals`:** counted rows with `occurred_at` < `from`.
- **Completeness and availability:** per figure as `period-report.md` defines them.
- **Format:** integers only; buckets sorted by `key`. More than 10 000 buckets in one figure, or a statement whose PAE exceeds `statementSigningLimit`, refuses with `ATTESTA_BUILDER_TOO_LARGE`.

**Document and statement**
- **Document:** `security-period-report-document/v1`, JCS bytes, deterministic. It carries no clock and no builder: the same inputs give the same bytes.
- **Statement:**
  - subject per the contract;
  - predicate = the document's figures without the lists, plus `inputs`, `builder {name: "trackai-security-report-builder", version}`, `as_of` (database clock, ms) and `previous`.
- **Both:** validate against their schemas (Ajv, as `securitySealValidators`) and refuse to sign on a schema or rule failure (`ATTESTA_BUILDER_SCHEMA_INVALID` / `ATTESTA_BUILDER_RULE_VIOLATION`).

**Rules SR1–SR9** (the P1–P10 counterparts). Write the table into `security-period-report.md`, implement it once in `security-report-rules.ts` (`checkSecurityReport`), and have the builder refuse to sign anything that breaks it:

| ID | Rule |
|---|---|
| SR1 | subject and bounds |
| SR2 | document and predicate scope equal; the tenant is the record's |
| SR3 | seals ordered, unique and contiguous; `seals_root` matches |
| SR4 | `rows_root`, `decisions_root` and the counts match |
| SR5 | each bucket figure's sum equals `findings` (except `denied_by_request`) |
| SR6 | completeness and availability follow the rule |
| SR7 | `blocked` and `coverage` fixed |
| SR8 | the predicate's figures equal the document's |
| SR9 | with the database at hand, recomputing gives the same document bytes |

**Signing and chaining**
- Sign outside any transaction, then chain in **one** ledger transaction, with no network call inside it.
- That transaction calls `chainStatement` with `previousSeen` = the earlier reports with the same subject name, as read in the snapshot. A concurrent report gives `ATTESTA_LEDGER_PREVIOUS_STALE`: retry once from a new snapshot.
- In the same transaction:
  - insert the `attesta_security_period_reports` row;
  - write the audit event `attesta.security_report.built`, with details `{scope_from, scope_to, repository_id (nullable), report_digest, statement_digest, row_count, seal_count, request_id}`.
- **Idempotent:** if the latest report for the same subject name has the same `report_digest`, return it (`outcome: 'existing'`) and sign nothing. A new digest chains a new report with `previous` set.

### 2.2 CLI and route
- **CLI:** `npm run attesta:security-report -w apps/api -- --tenant <uuid> --from <ms> --to <ms> [--repository <uuid>] [--confirm]`.
  - **Dry run by default:** prints the scope, the seal and row counts, the outcome code, the digests (for `--confirm`) and the safe codes, never row content.
  - **Actor:** `system_operator` `attesta:security-report:<os user>`.
  - **Script name:** `attesta:security-report`, in alphabetical position next to `attesta:security-seal`.
- **Routes** (`attesta.routes.ts`), both behind `attesta.export` (admin and auditor), `no-store`, 404 for another tenant's id exactly as for an unknown one:
  - `GET /api/attesta/security-period-reports/:id`: `{id, scope, report_digest, statement_digest, created_at}`.
  - `GET /api/attesta/security-period-reports/:id/document`: the stored document bytes as an attachment. A document that does not hash to its digest is a 500, never a download. Audited as **`attesta.security_report.downloaded`**, with details `{report_digest, statement_digest, request_id}`.
  - Classify both routes in the route sweep (`attesta-api.test.ts`).
- **No POST job:** the CLI builds; a request route is a later decision.

### 2.3 Pre-approved files
- `features/attesta/`:
  - new: `security-report-service.ts`, `security-report-rules.ts`, `attesta-security-report-cli.ts`, `security-report.test.ts`, `t15op-b-security-report-live-verify.ts`;
  - additive edits: `attesta.routes.ts`, `attesta-api.test.ts`, `security-seal-service.ts` (exports only, no behaviour change).
- `core/audit/catalog.ts` (the two actions, additive), `core/audit/audit-contract.test.ts` (its action list, fixtures and counts), and `docs/contracts/audit/catalog.md` (regenerated with `npm run audit:catalog -w apps/api`).
- `apps/api/package.json`: the two scripts, `attesta:security-report` and `verify:t15op-b-security-report-live`.
- `docs/contracts/attesta/security-period-report.md`: **additive** detail only (SR1–SR9, the decision projection, the audit actions).
- `docs/contracts/attesta/errors.md`: additive rows, if a new code is truly needed.
- The handoff; your own rows in `docs/plan/TASK15.md` (A15.16, Task15op-b), `docs/plan/TASK19.md` (none expected) and `docs/plan/STATUS_BOARD.md` (IT-T15op-02, in ID order).

### 2.4 Never touch, and when to stop
- **Never touch:**
  - `docs/contracts/security-v2/**`, `docs/contracts/task6/**`, the two report schemas and every other frozen contract text;
  - all merged migrations, **0027 included**;
  - `features/security-findings/**`, `features/qa/**`, the web app, GitAI, `evidence-pack-v1.schema.json` (packs keep `reports: []`).
- **No new migration.** If the report truly cannot be built within the frozen schemas, the 0027 guards and the table, stop and report the exact gap with your recommendation, as a question the founder can paste to the Task20 lead (standing in for the Task15 lead).

## 3. Working rules
- **Stages,** each committed (`Task15op-b: …`):
  1. rules and pure builder, with unit tests;
  2. store, signing and chaining;
  3. CLI and routes;
  4. contract detail;
  5. the live verify;
  6. the handoff.
- **Unit tests** (`node:test`, in-process, dev signer, no database):
  - figures from synthetic rows of both generations;
  - the `not_enrolled`, `unknown` and `unavailable` platform buckets;
  - a hashed model token;
  - `late_arrivals`;
  - `denied_by_request` for tenant and repository scope;
  - SR1–SR9 each refusing a crafted violation;
  - deterministic bytes;
  - the size refusal;
  - idempotent `existing` and a `previous` chain;
  - an unsealed period refused, and a broken seal refused;
  - Company A/B;
  - the offline verifier still accepting a built statement (exit 2 for reports, as today).
- **IT-T15op-02** (blocking for this merge): `scripts/it-db.sh npm run verify:t15op-b-security-report-live -w apps/api`. Reuse the IT-T15op-01 world. Run it once, small. It must show:
  1. seeding both generations, enforcement decisions and fleet states for Companies A and B;
  2. a refusal before sealing (`NOT_SEALED`);
  3. sealing with `--now` semantics;
  4. a tenant report and a repository report, built and chained (`/api/attesta/verify` ok);
  5. both routes, and B's same 404;
  6. a re-run returning `existing`;
  7. a fleet platform change then giving a new report with `previous`;
  8. a sealed row changed as table owner, then the report refused with `ATTESTA_SECURITY_SEAL_BROKEN`;
  9. the audit events.
- **Regression:** re-run IT-T15op-01 once.
- **Review:** an independent review subagent before the handoff; fix what it finds.

## 4. Close-out
- **Handoff** (under 100 lines, `docs/templates/HANDOFF_TEMPLATE.md`). It covers:
  - the CLI and routes;
  - SR1–SR9;
  - what Task19 (S7–S12 answers) and A16.13b can cite;
  - known limitations: platform current-state only, decisions unsealed, packs without documents;
  - Effort.
- **Push** your branch.
- **Final reply** in the AGENTS.md §12.4 shape. One bash block:
  1. fetch or check out the branch;
  2. `npm ci && npm test`;
  3. IT-T15op-02;
  4. under `# after the cross-agent review`: `gh pr create --base main --head task/Task15op-b-attesta-security-report --title "[Task15op-b] Attesta security period report" --body-file docs/handoffs/Task15op-b-attesta-security-report_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`, then `scripts/pr-preflight.sh task/Task15op-b-attesta-security-report`, then the merge.

  Then the review request in a `text` block.

## Lessons so far
- **Task15op-a (Claude):**
  - The reviewer and Codex both found **verification gaps, not guard gaps**: a pass that kept sealing on a moving cutoff, and a verify that trusted a seal's own order and counts.
  - So recompute every invariant from the rows. Test with a store whose clock moves and with crafted, self-consistent documents.
- **Task15i4 (Claude):** figures only from signed or sealed inputs, never live tables. A document must be byte-identical on re-run.
- **Task16e (Claude):** run the other Tasks' live verifies that touch shared guards once before the handoff.
