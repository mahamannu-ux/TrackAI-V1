# Task15op-attesta-security — design note (checkpoint 1)

> Status: 🟡 design note only, waiting on the checkpoint-1 answer. No migration or code yet. The handoff replaces this file at close-out.

Branch `task/Task15op-attesta-security` from `main` at `c30c6ab`. Pattern: Task16e audit-seal / Task15i4 period-report (SushiCorp RP-1); no new SushiCorp port.

## 0. Estimate and split
- **About 0.45× T6** (the lead's estimate was 0.35×). The two pattern sessions took 0.26× (Task16e) and 0.25× (Task15i4). Reuse saves about a third, but this session adds the second generation's columns, the platform and enforcement inputs, and the extra verify, pack and offline wiring.
- Above 0.4×, so I propose the **split**:
  - **Task15op-a** (this session, about 0.27×): the contract for both types, the one migration (both predicate types, both tables), finding seals, the seal CLI, the seal verify route, and the offline verifier and evidence packs for seals.
  - **Task15op-b** (a follow-up, about 0.18×): the security period report service, its CLI, its document route, and IT-T15op-02.
- Because 15op-a's migration already covers the report table, 15op-b needs **no migration**. That follows the Task15i4 lesson: replace the guards in one migration.
- **Pre-existing failure:** on `main` (`c30c6ab`), `npm test` is 1152/1155 with 1 failing. The failing test is `features/security/signing.test.ts:99` ("signing fails closed: over the signer limit…"), which expects `SecurityDocumentTooLarge`. Task15op0 raised the signer cap, so 40 overrides no longer pass it. This is Task20f's file, outside my scope: I report it and do not change it.

## 1. Seal document `https://trackai.dev/attesta/security-findings-seal-document/v1`
| Field | Content |
|---|---|
| `format`, `tenant_id`, `previous`, `rows`, `rows_root` | as `audit-seal-document/v1` (`rows [{id, digest}]` in (`received_at`, `id`) order; RFC 6962 root, `digestsRoot`) |
| `window` | `{from, to}` half-open over **`received_at`**, exact microsecond text (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) |
| `count` | rows |
| `generations` | `{task6a, v2}` row counts (sum = `count`) |

No `catalog_version`; the format URL versions the projection.

**Row digest** = `"sha256:" + hex(SHA-256(JCS(projection)))`. The projection has a **fixed key set** for every row. Each value is the **stored column verbatim** (JSON `null` when empty), so a digest recomputes from the row alone, with no derived values:

`id, record_generation, machine_id, repository_id, repository_kind, rule_id, rule_version, rule_category, rule_severity, effect, agent_family, source_agent, model, session_id, record_id, occurred_at, received_at, rule_pack_version, bundle_digest, lease_id, found_at_rest, phase, timing, result_category, operating_system`

- Timestamps are microsecond text.
- **Additions to the prompt's list:** `record_id` (Numbat's content-addressed record digest), `result_category` (S11's outcome) and `operating_system` (S9 for Task6.a rows). All three are short enums or digests.
- **Never included:** `title`, `tags`, previews, `security_finding_previews`, `delivery_id`, `source_event_id`, `client_version`.
- The document carries only ids and digests, so no session or model string leaves the database in a seal or a pack.

## 2. Seal statement
- **Subject:** `trackai:tenant/<uuid>/security-findings/<from>..<to>`, `{sha256}` of the document bytes.
- **Predicate:** `https://trackai.dev/attesta/security-findings-seal/v1`, with `{tenant_id, window, count, generations, rows_root, previous_seal, builder {name: "trackai-security-sealer", version}, as_of, previous: []}`.
- **Ledger:** `repository_id`, `statement_kind`, `subject_sha` and `outbox_subject_id` are null, as for audit seals.
- **Rules:** SS1–SS6 mirror AS1–AS6.

**Windows and cadence**
- **Contiguous:** each seal's `from` is the previous seal's `to`. The first seal starts at the tenant's earliest `received_at`.
- **Cutoff:** `to` ≤ DB clock − **10 min**. `received_at` is the API's clock (`v2-storage.ts` passes `receivedAt`), so the margin covers commit lag and skew.
- **Due when:** the tenant has rows and its last seal is ≥ 1 h old, or its last seal is ≥ 24 h old (an empty window). This is the audit-seal rule. `--now` seals up to the cutoff whatever the age, for an operator who is about to build a report.
- **Size cap:** at most **8 000 rows per seal**. The statement is about 1 KB whatever the row count; the cap bounds the **document** (8 000 × 129 bytes per row, about 1 MiB). That keeps the size established by `ATTESTA_STATEMENT_MAX_SIGNED_BYTES` for documents, packs and verify memory.
- **Backlog:** a larger backlog is sealed back to back. `to` is the first row that does not fit, so one instant is never split.
- **Overflow:** more than 8 000 rows at one millisecond needs at least 16 full uploads (500 records each) in the same millisecond. That is refused with `ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW`, never split.
- **Which tenants:** those with at least one `security_findings` row.

**Who seals:** `npm run attesta:security-seal -w apps/api` runs as a dry run; `--confirm` seals; `--tenant` and `--now` are optional.
- **Actor:** `system_operator`.
- **Steps:** a repeatable-read snapshot, then signing with no transaction open, then one ledger transaction: re-check the last seal, `chainStatement`, insert the seal row, and record the audit event **`audit.trail.security_findings_sealed`**.
- **Idempotent:** a second run is `not_due`; a concurrent run is `stale`.
- **Not in the worker loop:** `worker.ts` is not pre-approved. Q2 asks about it.

**Verify** `GET /api/attesta/security-seals/verify?from&to`
- **Authorization:** `attesta.read`; audited as `audit.trail.security_findings_verified`; `no-store`.
- **Report:** the audit verify report shape, with the same limits (≤ 31 days, ≤ 1 000 seals, ≤ 500 000 rows).
- **Break kinds:** `missing_row`, `changed_row`, `unsealed_row_in_sealed_window`, `broken_previous`, `statement_problem`, plus `unsealed_tail`.
- **Chain check:** `verifyRange` runs on each seal's own `seq`, as `features/audit/verify-service.ts` does. The new code lives in `attesta/security-seal-service.ts` and `attesta.routes.ts`.

## 3. Security period report (Task15op-b) `https://trackai.dev/attesta/security-period-report/v1`

**Subject**
- Tenant scope: `trackai:tenant/<t>/security-period/<from>..<to>`.
- Repository scope: `trackai:tenant/<t>/repository/<r>/security-period/<from>..<to>`.
- Bounds are RFC 3339 ms, half-open `[from, to)` over `received_at`, matching the seals.
- `to` ≤ `as_of` − 10 min.
- The ledger `repository_id` is the scope's repository, or null for tenant scope.

**Refusals (safe codes)**
- The report is refused with **`ATTESTA_SECURITY_PERIOD_NOT_SEALED`** until a seal's `window_to` ≥ `to`.
- It is refused with **`ATTESTA_SECURITY_SEAL_BROKEN`** if any covering seal shows a break (the AS4-style check runs first).
- So figures come only from rows that are sealed and verified.

**Inputs:** `seal_count`, `seals_root` (over the covering seals' statement digests, window order), `row_count`, and `rows_root` (over the digests of the counted rows, (`received_at`, `id`) order). Anyone holding the rows recomputes both.

**Figures** are integers only. Each is `{availability, value}`, with `completeness {rows, recorded, partial, unavailable}` as `period-report.md` defines it.

| Figure | Source | Notes |
|---|---|---|
| `findings` | count | — |
| `by_severity` | `rule_severity` | `info…critical` |
| `by_category` | `rule_category` | — |
| `by_rule` | `rule_id` | — |
| `by_generation` | `record_generation` | — |
| `by_repository` | `repository_id` | v2 `not_enrolled` gets its own bucket |
| `by_agent` | `agent_family` / `source_agent` | — |
| `by_model` | `model` | null and all Task6.a rows go to `unknown`. A value that does not fit the token pattern is hashed, as `fields.md` does |
| `by_platform` | Task6.a `operating_system` (sealed); v2 `fleet_machine_states.platform` | v2 platform: Q4 |
| `outcomes` (S11) | Task6.a `phase` | `{requested, observed_result, partial, unavailable}` plus `v2_unclassified` |
| `denied_by_request` | `security_enforcement_decisions` with `decision = 'deny'` and `received_at` in the period | Tenant scope only; `not_applicable` for a repository (decisions carry no repository). **Not sealed**, so `partial` / `not_sealed`. The document lists the decision ids and digests so the figure reproduces. Sealing decisions is phase 2 |
| `blocked` | — | always `{availability: "unavailable", reason: "monitor_only_observed"}`; a deny is never called blocked |
| `rule_pack_versions` | distinct `rule_pack_version` | count |
| `late_arrivals` | rows with `occurred_at` < `from` | honesty about the `received_at` basis |
| `coverage` (S2) | — | `unavailable` / `not_captured_yet` (G7) |

**What is where** (the period-report split):
- **Document:** no clock and no builder; the same rows give the same bytes.
- **Predicate:** the figures without contributions, plus `builder` (`trackai-security-report-builder`), `as_of` and `previous` (earlier reports for the same subject, P10).
- **Re-running:** a run over the same scope with the same document digest returns the existing report (idempotent). A new digest, possible only through the unsealed inputs (platform, decisions), chains a new report with `previous` set.
- **Size:** more than 10 000 repositories, or more than 1 MiB, is refused with `ATTESTA_BUILDER_TOO_LARGE`.
- **CLI:** `npm run attesta:security-report -w apps/api -- --tenant <t> --from --to [--repository <r>]` runs as a dry run; `--confirm` builds.
- **Route:** `GET /api/attesta/security-period-reports/:id/document` (`attesta.export`, audited as `attesta.report.download` with a type marker, `no-store`). No POST job, because the CLI builds.

## 4. Migration `0027_attesta_security_seals.sql` (in 15op-a)
- **Shape check:** dropped and re-added with two new arms:
  - seal: `repository_id`, `statement_kind`, `subject_sha` and `outbox_subject_id` all null;
  - report: `statement_kind`, `subject_sha` and `outbox_subject_id` null; `repository_id` optional.
- **Chain guard:** `attesta_records_chain_guard()` is replaced with `CREATE OR REPLACE`. The three existing arms are kept byte for byte, and two `ELSIF` arms are added that check the subject name against the predicate's tenant, window or scope, and repository. The `canonical_record` formula is unchanged (it already handles a null repository).
- **`attesta_security_finding_seals`:** the `attesta_audit_seals` columns plus `task6a_count` and `v2_count`, with the same unique keys, the first-seal partial index, and composite `(tenant_id, record_id)` → `attesta_records`. The insert guard (the 0023 pattern, its own advisory lock key) checks: the digest against the document, the columns against the document, the record against the document, and that the seal follows the tenant's latest seal.
- **`attesta_security_period_reports`:** `tenant_id`, `repository_id` (nullable, composite FK to `scm_repositories`), `period_from`, `period_to`, `report_document`, `report_digest`, `record_id`, `statement_digest` and `created_at`; unique `(tenant_id, record_id)` and `(tenant_id, report_digest)`. The insert guard checks the digest, the columns and the record.
- **Both tables:** RLS on with no browser policies; `SECURITY DEFINER` functions with `search_path = pg_catalog, pg_temp`; append-only (`attesta_ledger_reject_mutation` on UPDATE, DELETE and TRUNCATE).
- **Steps:** `schema.ts` (the two tables only), `drizzle-kit generate`, a hand-added guard section as in 0023, a dry-run on `scripts/it-db.sh`, and `drizzle-kit check`.

## 5. Contracts, packs, offline verifier
- **New files** under `docs/contracts/attesta/`: `security-findings-seal.md`, `security-findings-seal-document-v1.schema.json`, `predicate-security-findings-seal-v1.schema.json`, `security-period-report.md`, `security-period-report-document-v1.schema.json` and `predicate-security-period-report-v1.schema.json`, plus synthetic fixtures under `fixtures/security/`. Additive rows go in `README.md` (files table) and `errors.md` (the three codes above).
- **`/api/attesta/verify`:** both types verify through `deriveStatementColumns` in `ledger.ts`; `verify-chain.ts` needs only that.
- **Evidence packs** already carry every in-scope ledger statement, so seal and report statements are included automatically. Tenant-level ones (`repository_id` null) appear only in tenant packs.
  - `reports` stays `[]`: `evidence-pack-v1.schema.json` fixes it at `maxItems: 0` and is frozen (Q3).
- **Offline verifier:** checks both types against their schemas and typed columns. It reports the document and row checks as **not checkable (exit 2)**, as it does for period reports today.

## 6. Tests and IT-T15op-01
- **Unit tests,** in-process with the dev signer:
  - the seal round trip;
  - each tamper class detected;
  - the 8 000-row chunking and the one-instant refusal;
  - the statement staying under the signing limit;
  - the ledger accepting both types and refusing a seal naming another tenant;
  - the offline verifier accepting both types;
  - Company A/B.
- **15op-b adds** the report figures from both generations, the `not_enrolled` and `unknown` buckets, the refusal of an unsealed period, and the refusal on a broken seal.
- **IT-T15op-01** (blocking for this merge): `scripts/it-db.sh npm run verify:t15op-security-live -w apps/api`.
  - It seeds both generations for Companies A and B, seals with chunking, and verifies (ok).
  - Then, as table owner with the immutability trigger disabled, it deletes a row, updates a row and inserts one late, and checks the three breaks.
  - It also checks the ledger and seal-table guards, and A/B isolation. In 15op-b it gains the report steps.

## 7. Questions for the checkpoint (my recommendation first)
1. **Split** into 15op-a and 15op-b as in §0? *Recommend yes.*
2. **Worker loop:** should the Attesta worker loop also run the security seal pass (it needs `worker.ts`, which is not pre-approved)? *Recommend not now. The founder schedules the CLI hourly; add it to the loop in 15op-b if pre-approved.*
3. **Seal and report documents in evidence packs:** filling `reports` changes the frozen `evidence-pack-v1` schema. *Recommend leaving `reports: []` here (the statements are already in packs). Fill it in a separate, approved additive pack-contract change, with Task15i4's period reports.*
4. **v2 platform:** `fleet_machine_states.platform` is the **current** state, not the state when the finding occurred (its history is G7, Task20i). *Recommend labelling it `partial` / `current_machine_state`, with the document listing `{machine_id, platform}` (no per-machine counts) so it reproduces. The alternative is `unavailable` until G7.*
5. **TRUNCATE on `security_findings`:** 0013 blocks UPDATE and DELETE but not TRUNCATE. Should 0027 add a `BEFORE TRUNCATE` trigger, as 0023 did for audit events (Task20's table, additive)? *Recommend yes.*
6. **Seal basis:** `received_at` rather than `occurred_at` (the prompt's choice), with `late_arrivals` in the report. *Confirm.*
