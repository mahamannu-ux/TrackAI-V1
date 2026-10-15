# `audit_seal` statement (frozen when merged; built in Task16e, A16.4)

Written 2026-10-15 by Claude (Task16e-audit-tamper). Founder checkpoint 2026-10-15: the first seal of an existing tenant covers all its history (in chunks), an export covers at most one year, A16.10 (the auditor database role) moves to its own session.

**What it is for:** the audit trail (`security_audit_events`, `docs/contracts/audit/`) is append-only by trigger, but a database owner can still switch the trigger off. A seal is a signed Attesta statement over a contiguous window of a tenant's audit rows, chained and anchored in the tenant's Attesta ledger like every other statement (`TASK16.md` D1–D2: no second chain, no second signer). Afterwards:
- a deleted row changes the sealed `rows_root` (`missing_row`);
- a changed row changes its digest (`changed_row`);
- a row inserted late into a sealed window is in no seal (`unsealed_row_in_sealed_window`);
- a removed or rewritten seal breaks the `previous` chain or the ledger (`broken_previous`, `statement_problem`).

Pattern: SushiCorp RP-1 (a small signed statement names the digest of a stored document), as Task15i4 translated it for period reports.

## The seal document

The RFC 8785 (JCS) bytes are stored in `attesta_audit_seals.seal_document`; `seal_digest` = `"sha256:" + hex(SHA-256(bytes))`. Schema: `audit-seal-document-v1.schema.json`.

| Field | Content |
|---|---|
| `format` | `https://trackai.dev/attesta/audit-seal-document/v1` |
| `tenant_id` | the tenant (lowercase UUID) |
| `window` | `{from, to}`: half-open `[from, to)`, compared with `occurred_at`. Both are the exact microsecond text the audit read API returns (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, six digits) |
| `previous` | the previous seal's `seal_digest`, or `null` for the tenant's first seal |
| `catalog_version` | `AUDIT_CATALOG_VERSION` when sealed |
| `count` | the number of rows |
| `rows` | `[{id, digest}]` in (`occurred_at`, `id`) ascending order |
| `rows_root` | the RFC 6962 root (`merkle.ts`) over the 32 raw bytes of each row digest, in `rows` order; the empty list's root is SHA-256 of the empty string (the period-report rule) |

**Row digest** = `"sha256:" + hex(SHA-256(JCS(row)))`, where `row` is the stored row as `event-v1.schema.json` returns it **without** the derived `severity` and `catalog_version`: exactly the keys `id, action, actor_type, actor_id, target_type, target_id, details, occurred_at`, with `occurred_at` as the exact microsecond text. `tenant_id` is not in the row: it is the document's, and every read is tenant-bound, so a row moved to another tenant shows as `missing_row`.

## Statement

| Part | Value |
|---|---|
| `_type` | `https://in-toto.io/Statement/v1` |
| `subject[0].name` | `trackai:tenant/<tenant UUID>/audit/<from>..<to>` |
| `subject[0].digest` | `{sha256: <hex>}` of the seal document bytes |
| `predicateType` | `https://trackai.dev/attesta/audit-seal/v1` |
| `predicate` | `{tenant_id, window, count, rows_root, catalog_version, previous_seal, builder, as_of, previous}`: the document's fields (without `rows`), `previous_seal` = the document's `previous`, `builder` = `{name: "trackai-audit-sealer", version}`, `as_of` = the database clock (RFC 3339 UTC, ms), `previous` = `[]` (a window is sealed once, so no earlier statement has the same subject) |
| Schema | `predicate-audit-seal-v1.schema.json`; the whole statement is its `#/definitions/statement` |
| Envelope, digest | exactly as `envelope.md` |
| Ledger | `record_kind = statement`; `repository_id`, `statement_kind`, `subject_sha` and `outbox_subject_id` are **null** (`canonical_record` carries `"repository_id":null`). Migration 0023 relaxes `attesta_records.repository_id` to nullable for this type only (the shape check still requires it for ai-provenance and period-report records) |

## Windows and cadence

- Windows are contiguous: a seal's `from` is the previous seal's `to`. A tenant's first seal starts at its earliest audit row (founder: all history).
- `to` ≤ database clock − 5 minutes (the evidence-pack settle margin, `evidence-pack.md`): `occurred_at` is the writer's transaction start, so a row may commit a little after its time.
- A seal holds at most **50 000** rows. A larger backlog is sealed in back-to-back seals: `to` is then the `occurred_at` of the first row that does not fit, so rows sharing one instant are never split.
- A tenant is sealed when it has unsealed rows before the cutoff **and** its last seal is at least an hour old, or when its last seal is at least 24 hours old (an empty window still proves "nothing happened"). A tenant with no audit row has no seal.
- Who seals: the Attesta worker loop (`npm run attesta:build -w apps/api -- --loop`, actor `service` `attesta-worker`) and `npm run attesta:audit-seal -w apps/api` (dry run; `--confirm` to seal; actor `system_operator`).
- How: read in one repeatable-read snapshot, sign with the tenant's statement key outside any transaction, then in one ledger transaction re-check the last seal, chain the statement, store the seal row and write `audit.trail.sealed`.

## Table `attesta_audit_seals` (migration 0023)

One row per seal, written only in the ledger transaction that chains it (no job state: a seal is never requested). Append-only (no UPDATE, DELETE or TRUNCATE). The insert guard checks: the digest is SHA-256 of the document; the columns (`window_from`, `window_to`, `row_count`, `previous_digest`) equal the document's; the record is this tenant's audit-seal statement naming this digest and window; and `previous_digest` is the tenant's latest seal with `window_from` = its `window_to` (or null, with no seal yet). So a second seal over the same window, or a gap, is refused by the database.

## The verify report (`GET /api/audit/verify?from&to`)

For every seal overlapping `[from, to)` (both RFC 3339; at most 31 days apart): recompute each sealed row's digest from the current table and the `rows_root`, check the `previous` links and windows, and run Attesta's chain, signature and anchor check (the functions behind `/api/attesta/verify`) over the seal records' `seq` range.

```text
{ ok, from, to, seals_checked,
  breaks: [{kind, seal, row_id?}],        kind: missing_row | changed_row | unsealed_row_in_sealed_window
                                                | broken_previous | statement_problem
                                          seal: the seal_digest (null for a break of the chain range itself)
  breaks_truncated,
  unsealed_tail: {from, count},           rows at or after the last seal's `to`: "not sealed yet", never "verified"
  chain: {ok, checked} }
```

`ok` is true only when there is no break and the Attesta check is `ok` (signatures checked, no anchor or key-window finding). Rows in `unsealed_tail` never make a report not ok and are never called verified.

## Rules AS1–AS6 (`audit-seal-service.ts`)

| ID | Rule |
|---|---|
| AS1 | `subject[0].name` = `trackai:tenant/<predicate.tenant_id>/audit/<window.from>..<window.to>`; `subject[0].digest.sha256` = SHA-256 of the document bytes; `from` < `to` |
| AS2 | The document's `tenant_id`, `window`, `count`, `catalog_version`, `rows_root` and `previous` equal the predicate's (`previous_seal`); `tenant_id` = the ledger record's tenant |
| AS3 | `count` = `rows.length`; `rows` in (`occurred_at`, `id`) order with unique ids; `rows_root` recomputes |
| AS4 | With the table at hand: every sealed id exists in the window with the same digest, and no other row of the tenant is in the window |
| AS5 | `previous` is the prior seal's digest and its `to` is this seal's `from`; the first seal has `previous: null` |
| AS6 | The statement verifies, chains and anchors like any Attesta statement (`envelope.md`, `tables.md`) |

## Provenance

RP-1 via Task15i4 (period reports); EV-1 reused through Attesta, not re-ported. **Deviations from the prompt:** the seal table has no job/lease columns (a seal is written once, inside its ledger transaction; there is nothing to queue).
