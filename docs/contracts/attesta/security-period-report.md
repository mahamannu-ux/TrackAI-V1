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
