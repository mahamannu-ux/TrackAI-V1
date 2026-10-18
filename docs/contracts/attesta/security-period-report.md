# `security_period_report` statement (design, binding; ledger support in Task15op-a, builder in Task15op-b, A15.16)

Written 2026-10-18 by Claude (Task15op-attesta-security). Founder checkpoint 2026-10-18 approved the design note's recommendations. Task15op-a freezes the predicate type, the schemas, the ledger columns and the table (migration 0027); Task15op-b builds the report and may add detail here, not contradict it.

**What it is for:** one signed set of security figures per tenant (or repository) and period, built **only from sealed, verified finding rows** (`security-findings-seal.md`): questions S7, S8, S9, S11 and S12 (`docs/contracts/qa/questions.md`). Pattern: `period-report.md` (RP-1).

## Statement

| Part | Value |
|---|---|
| `subject[0].name` | tenant scope `trackai:tenant/<t>/security-period/<from>..<to>`; repository scope `trackai:tenant/<t>/repository/<r>/security-period/<from>..<to>` (RFC 3339 UTC, ms, `Z`) |
| `subject[0].digest` | `{sha256}` of the report document bytes (`security-period-report-document-v1.schema.json`) |
| `predicateType` | `https://trackai.dev/attesta/security-period-report/v1` |
| Predicate | `predicate-security-period-report-v1.schema.json`: `scope`, `inputs`, `figures`, `blocked`, `coverage`, `completeness`, `builder` (`trackai-security-report-builder`), `as_of`, `previous` |
| Ledger | `record_kind = statement`; `statement_kind`, `subject_sha`, `outbox_subject_id` null; `repository_id` = the scope's repository, or null for tenant scope. `previous` lists earlier reports with the same subject name, oldest first (enforced under the chain lock, as P10) |

## Scope and inputs

- `scope = {tenant_id, repository_id | null, from, to, basis: "received_at"}`: half-open `[from, to)` over `received_at`, matching the seals. `to` ≤ `as_of` − 10 minutes.
- **Sealed first.** The builder refuses with `ATTESTA_SECURITY_PERIOD_NOT_SEALED` until the tenant's latest seal has `window_to` ≥ `to`, and with `ATTESTA_SECURITY_SEAL_BROKEN` when any seal overlapping the period shows a break (the SS4 check runs first). So every counted row is sealed and unaltered.
- `inputs = {seal_count, seals_root, row_count, rows_root, decision_count, decisions_root}`: `seals_root` over the covering seals' statement digests (window order); `rows_root` over the counted rows' digests ((`received_at`, `id`) order); `decisions_root` over the counted enforcement decisions' digests. Roots are RFC 6962 (`merkle.ts`); the empty list's root is SHA-256 of the empty string.

## Figures (integers only)

Each figure is `{availability, value}` (`recorded`; `partial` with `partial_reason`; `unavailable` with `reason`). Bucket figures are `[{key, count}]` sorted by `key`.

| Figure | Source | Notes |
|---|---|---|
| `findings` | the counted rows | — |
| `by_severity`, `by_category`, `by_rule`, `by_generation` | `rule_severity`, `rule_category`, `rule_id`, `record_generation` | — |
| `by_repository` | `repository_id` | v2 `not_enrolled` rows in the bucket `not_enrolled` |
| `by_agent` | Task6.a `agent_family`, v2 `source_agent` | — |
| `by_model` | v2 `model` | null and Task6.a rows in `unknown`; a value that is not a token is `sha256:<hex>` of its UTF-8 bytes and the figure `partial` / `values_hashed_unrepresentable` (`fields.md` rule) |
| `by_platform` | Task6.a `operating_system` (sealed); v2 `fleet_machine_states.platform` | the v2 value is the **current** machine state (history is G7): `partial` / `current_machine_state`; no state row → `unavailable` bucket. The document lists `machine_platforms [{machine_id, platform}]` (no per-machine counts) so the bytes reproduce |
| `outcomes` (S11) | Task6.a `phase` | keys `requested`, `observed_result`, `partial`, `unavailable`, plus `v2_unclassified` for v2 rows |
| `denied_by_request` | `security_enforcement_decisions`, `decision = 'deny'`, `received_at` in the period | tenant scope only (`unavailable` / `not_applicable` for a repository). Not sealed: `partial` / `not_sealed`; the document lists `decisions [{id, digest}]` |
| `rule_pack_versions` | distinct `rule_pack_version` | — |
| `late_arrivals` | counted rows with `occurred_at` < `from` | the honest cost of the `received_at` basis |
| `blocked` | — | always `{availability: "unavailable", reason: "monitor_only_observed"}`: a Numbat deny is a request, never "blocked" or "prevented" |
| `coverage` (S2) | — | `{availability: "unavailable", reason: "not_captured_yet"}` until G7 |

`completeness` per figure is `{rows, recorded, partial, unavailable}` (`period-report.md`).

## What is where

The document holds `format`, `tenant_id`, `scope`, `seals`, `row_count`, `rows_root`, `decisions`, `machine_platforms`, the figures, `blocked`, `coverage` and `completeness`: no clock, no builder, so the same inputs give the same bytes. The predicate holds the same figures plus `inputs`, `builder`, `as_of` and `previous`. A re-run with the same document digest returns the existing report (idempotent); a new digest (possible only through the unsealed inputs: platforms, decisions) chains a new report naming the earlier one in `previous`. More than 10 000 buckets in one figure, or a statement over 1 MiB, is refused (`ATTESTA_BUILDER_TOO_LARGE`).

## Table `attesta_security_period_reports` (migration 0027)

`tenant_id`, `repository_id` (nullable; composite key to `scm_repositories`), `period_from`, `period_to` (ms text), `report_document`, `report_digest`, `record_id` (composite key to `attesta_records`), `statement_digest`, `created_at`. Append-only; the insert guard checks the digest, that the columns equal the document's scope, and that the record is this tenant's security-period-report statement naming this digest and scope.

## Jobs and routes (Task15op-b)

`npm run attesta:security-report -w apps/api -- --tenant <t> --from <ms> --to <ms> [--repository <r>]` (dry run; `--confirm` builds); `GET /api/attesta/security-period-reports/:id/document` (`attesta.export`, audited, `no-store`). Rules SR1–SR9 (the P1–P10 counterparts) are written there.

## Builder detail (Task15op-b, added 2026-10-18)

Added by Claude (Task15op-b-attesta-security-report). Additive: nothing above changes. Code: `security-report-rules.ts` (figures, SR1–SR9), `security-report-service.ts` (snapshot, coverage, signing and chaining).

**Request.** `{tenant, repository | null, from, to}`: RFC 3339 UTC with milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`), `from` < `to`, at most 366 days, `to` ≤ database clock − 10 minutes. A repository that is not the tenant's (another tenant's or unknown) is the same refusal. All refusals are `ATTESTA_API_INVALID_QUERY`.

**Coverage**, read in one repeatable-read, read-only snapshot. `to` is compared as microsecond text (`to` with `000` before `Z`).
1. `ATTESTA_SECURITY_PERIOD_NOT_SEALED` when the tenant has no seal, or its latest seal's `window_to` < `to`.
2. The covering seals are those whose window overlaps `[from, to)`. Each is checked with the seal verify report's own code, one seal at a time: its stored document against its columns, its ledger statement (SS2), its current rows (SS3–SS4: missing, changed and late rows; the recomputed invariants) and its `previous` link (SS5, the first one against its predecessor read by digest).
3. `ATTESTA_SECURITY_SEAL_BROKEN` on any break, and also when the covering seals leave part of the period outside every seal: the last covering seal ends before `to`; the first starts after `from` although it has a predecessor; or no seal overlaps a period that does not lie wholly before the tenant's first seal. A row received in `[from, min(to, first seal's from))` is in no seal (inserted after sealing) and is a break too.
4. The Attesta signature and anchor check of the seal records is not repeated (`/api/attesta/verify` covers it).

**Counted rows** are the covering seals' intact rows with `from` ≤ `received_at` < `to` (and, for repository scope, `repository_id` = the scope's). Their seal row digests, in (`received_at`, `id`) order, give `row_count` and `rows_root`. At most 20 000 covering seals and 500 000 counted rows; beyond, `ATTESTA_BUILDER_TOO_LARGE` (split the period).

**Where each row lands.** Every bucket figure holds every counted row, so each sums to `findings` (SR5). Each row's value has a state that completeness counts:

| Figure | Bucket key | State |
|---|---|---|
| `by_severity`, `by_category`, `by_rule`, `by_generation` | the column | recorded (partial when hashed) |
| `by_repository` | `repository_id`; a v2 row without one: `not_enrolled` | recorded (partial when hashed) |
| `by_agent` | Task6.a `agent_family`, v2 `source_agent`; null: `unknown` | recorded / partial when hashed / unavailable when `unknown` |
| `by_model` | v2 `model`; null and every Task6.a row: `unknown` | recorded / partial when hashed / unavailable when `unknown` |
| `by_platform` | Task6.a `operating_system`; v2 the machine's current `fleet_machine_states.platform`; `unavailable` when the value is `unavailable`, missing or not one of `macos`, `linux`, `windows`, `wsl` | Task6.a recorded; v2 partial (current state); `unavailable` unavailable |
| `outcomes` | Task6.a `phase`; every v2 row: `v2_unclassified` | Task6.a recorded; v2 unavailable |

A key that is not a token (`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`) becomes `sha256:<hex of its UTF-8 bytes>` in every bucket figure (`fields.md` rule 2), and that row is partial.

**Availability and completeness (SR6).** `completeness` per bucket figure is `{rows, recorded, partial, unavailable}` over the counted rows by the states above. A bucket figure is `unavailable` / `source_missing` (no value) when rows exist and none is recorded or partial; else `partial` when any row is partial (`current_machine_state` for `by_platform`, `values_hashed_unrepresentable` for the others); else `recorded`. An `unknown`, `unavailable` or `v2_unclassified` bucket alone never makes a figure partial: the bucket and completeness say it. `findings`, `rule_pack_versions` (distinct `rule_pack_version`) and `late_arrivals` are always recorded, with completeness `{rows, rows, 0, 0}`. `denied_by_request`: repository scope `unavailable` / `not_applicable`, completeness all 0; tenant scope with no deny `recorded` 0, completeness all 0; with *n* denies `partial` / `not_sealed` *n*, completeness `{n, 0, n, 0}`.

**Decision digest** = `"sha256:" + hex(SHA-256(JCS(projection)))`, the projection being every column of `security_enforcement_decisions` except `tenant_id`, verbatim (JSON `null` when null; `occurred_at` and `received_at` the exact microsecond text; `rule_ids` and `finding_record_ids` JSON arrays of strings; everything else a string), with exactly these 15 keys:

`id, machine_id, record_id, decision, mode, rule_ids, deny_rule_id, deny_rule_version, finding_record_ids, tool_name, tool_call_id, session_id, source_agent, occurred_at, received_at`

The document lists `decisions [{id, digest}]` in (`received_at`, `id`) order and `machine_platforms [{machine_id, platform}]` sorted by `machine_id`, for the counted v2 rows' machines. Neither the document nor the statement carries a session id, tool name, title or raw model name.

**Idempotency.** A document whose digest a stored report of the same scope already has returns that report (`existing`) and signs nothing; the unique `(tenant_id, report_digest)` key means this also holds when the inputs returned to an earlier state (A, then B, then A again returns the first report, although the latest is B). A new digest chains a report whose `previous` lists every earlier report of the subject name, oldest first; a report chained meanwhile (`ATTESTA_LEDGER_PREVIOUS_STALE`) is rebuilt once from a fresh snapshot.

### Rules SR1–SR9 (`security-report-rules.ts` `checkSecurityReport`)

| ID | Rule |
|---|---|
| SR1 | `subject[0].name` = the scope's name (tenant or repository form); `subject[0].digest.sha256` = SHA-256 of the document bytes; `from` < `to` ≤ `as_of` − 10 min, at most 366 days; all real ms instants |
| SR2 | The document's `scope` = the predicate's; `tenant_id` = `scope.tenant_id` = the ledger record's tenant; `previous` names each digest once (the order is enforced under the chain lock, as P10) |
| SR3 | `seals` in window order, each window overlapping the period, contiguous (`from` = the prior `to`), `seq` ascending, statement and seal digests unique; the last reaches `to`; no seal means no row; `seal_count` and `seals_root` match |
| SR4 | `row_count`, `rows_root`, `decision_count` and `decisions_root` match the document; `findings` = `row_count`; `denied_by_request` = the decision count (tenant scope); no decision in a repository report; decision ids unique, `machine_platforms` sorted and unique |
| SR5 | Each bucket figure with a value sums to `row_count`, keys sorted and unique, counts ≥ 1; `late_arrivals` and `rule_pack_versions` within the rows (`rule_pack_versions` > 0 exactly when rows exist) |
| SR6 | Completeness adds up and every figure's availability follows the rule above; `by_platform` is `current_machine_state` exactly when a listed machine has a platform |
| SR7 | `blocked` = `{unavailable, monitor_only_observed}` and `coverage` = `{unavailable, not_captured_yet}` in the document and the predicate (also frozen in the schemas) |
| SR8 | The predicate's `figures` and `completeness` equal the document's |
| SR9 | With the database at hand (the builder's snapshot): recomputing the document from the counted rows, the seals, the decisions and the platforms gives the same bytes |

A document that is not its own JCS form, or that a schema refuses, is `SR_SCHEMA` alone. The builder refuses to sign anything that breaks a rule (`ATTESTA_BUILDER_SCHEMA_INVALID` / `ATTESTA_BUILDER_RULE_VIOLATION`). The offline verifier checks a report statement against its schema and the record's typed columns; SR1–SR9 need the document (and SR9 the database), so packs report them as not checkable (exit 2) while `reports` stays `[]`.

### CLI, routes and audit actions

- `npm run attesta:security-report -w apps/api -- --tenant <t> --from <ms> --to <ms> [--repository <r>] [--confirm]`: dry run by default; prints the scope, seal, row and decision counts, the outcome (`would_build`, `built`, `existing`, `refused`) and a safe code, plus the report id and digests with `--confirm`. Actor `system_operator` `attesta:security-report:<os user>`.
- `GET /api/attesta/security-period-reports/{id}`: `{id, scope, report_digest, statement_digest, created_at}`. `GET /api/attesta/security-period-reports/{id}/document`: the stored document bytes as an attachment; a document that does not hash to its digest is a 500, never a download. Both `attesta.export` (tenant administrator, auditor), `no-store`; another tenant's id is the same 404 as an unknown one.
- `attesta.security_report.built` (in the ledger transaction; details `scope_from, scope_to, repository_id | null, report_digest, statement_digest, row_count, seal_count, request_id`) and `attesta.security_report.downloaded` (details `report_digest, statement_digest, request_id`); catalog version 4.
