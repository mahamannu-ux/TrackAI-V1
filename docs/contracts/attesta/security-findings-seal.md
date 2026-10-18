# `security_findings_seal` statement (frozen when merged; built in Task15op-a, A15.15)

Written 2026-10-18 by Claude (Task15op-attesta-security). Founder checkpoint 2026-10-18: seals of finding windows instead of one statement per finding, sealed by `received_at`, the session split into 15op-a (seals) and 15op-b (the security period report), the CLI scheduled by the founder rather than the worker loop.

**What it is for:** gap G6 (`docs/plan/CUSTOMER_AUDITOR_QA.md`), question S1: "prove no high or critical finding was added, changed or removed afterwards". `security_findings` refuses UPDATE and DELETE by trigger (0013) and TRUNCATE (0027), but a database owner can switch triggers off. A seal is a signed Attesta statement over a contiguous window of one tenant's finding rows, of **both generations** (Task6.a and Numbat v2), chained and anchored in the tenant's ledger like every other statement. Afterwards:
- a deleted row changes the sealed `rows_root` (`missing_row`);
- a changed row changes its digest (`changed_row`);
- a row inserted late into a sealed window is in no seal (`unsealed_row_in_sealed_window`);
- a removed or rewritten seal breaks the `previous` chain or the ledger (`broken_previous`, `statement_problem`).

Pattern: `audit-seal.md` (Task16e), itself SushiCorp RP-1 as Task15i4 translated it. Why not one statement per finding (A15.15 as first planned): Numbat findings often have no repository or commit, which Attesta's outbox and commit subjects require, and per-finding signing multiplies signing at fleet volume. The ingest path (Task20d) is unchanged: no outbox, nothing in its transaction.

## The seal document

The RFC 8785 (JCS) bytes are stored in `attesta_security_finding_seals.seal_document`; `seal_digest` = `"sha256:" + hex(SHA-256(bytes))`. Schema: `security-findings-seal-document-v1.schema.json`.

| Field | Content |
|---|---|
| `format` | `https://trackai.dev/attesta/security-findings-seal-document/v1` |
| `tenant_id` | the tenant (lowercase UUID) |
| `window` | `{from, to}`: half-open `[from, to)`, compared with **`received_at`**, both the exact microsecond text (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) |
| `previous` | the previous seal's `seal_digest`, or `null` for the tenant's first seal |
| `count` | the number of rows (at most 8 000) |
| `generations` | `{task6a, v2}`: rows per `record_generation`; the sum is `count` |
| `rows` | `[{id, digest}]` in (`received_at`, `id`) ascending order |
| `rows_root` | the RFC 6962 root (`merkle.ts`) over the 32 raw bytes of each row digest, in `rows` order; the empty list's root is SHA-256 of the empty string |

**Why `received_at`:** it is set when TrackAI stores the row, so a late upload falls into a later window instead of reopening a sealed one. A finding's own time (`occurred_at`) is in the row digest.

**Row digest** = `"sha256:" + hex(SHA-256(JCS(projection)))`. The projection has exactly these keys for every row, each the **stored column verbatim** (JSON `null` when the column is null; `found_at_rest` a boolean or null; timestamps the exact microsecond text; everything else a string):

`id, record_generation, machine_id, repository_id, repository_kind, rule_id, rule_version, rule_category, rule_severity, effect, agent_family, source_agent, model, session_id, record_id, occurred_at, received_at, rule_pack_version, bundle_digest, lease_id, found_at_rest, phase, timing, result_category, operating_system`

Metadata only: `title`, `tags`, previews (`security_finding_previews`), delivery and source-event ids and client versions are never in it. `tenant_id` is the document's, and every read is tenant-bound, so a row moved to another tenant shows as `missing_row`. The document carries only ids and digests, so no session id or model name leaves the database in a seal, a statement or an evidence pack.

## Statement

| Part | Value |
|---|---|
| `_type` | `https://in-toto.io/Statement/v1` |
| `subject[0].name` | `trackai:tenant/<tenant UUID>/security-findings/<from>..<to>` |
| `subject[0].digest` | `{sha256: <hex>}` of the seal document bytes |
| `predicateType` | `https://trackai.dev/attesta/security-findings-seal/v1` |
| `predicate` | `{tenant_id, window, count, generations, rows_root, previous_seal, builder, as_of, previous}`: the document's fields (without `rows`), `previous_seal` = the document's `previous`, `builder` = `{name: "trackai-security-sealer", version}`, `as_of` = the database clock (RFC 3339 UTC, ms), `previous` = `[]` (a window is sealed once) |
| Schema | `predicate-security-findings-seal-v1.schema.json`; the whole statement is its `#/definitions/statement` |
| Envelope, digest | exactly as `envelope.md`; signed PAE bytes at most `ATTESTA_STATEMENT_MAX_SIGNED_BYTES` (1 MiB; the statement is about 1 KB whatever the row count) |
| Ledger | `record_kind = statement`; `repository_id`, `statement_kind`, `subject_sha` and `outbox_subject_id` **null** (migration 0027 extends the shape check and the chain guard, keeping the 0023 arms byte for byte) |

## Windows and cadence

- Windows are contiguous: a seal's `from` is the previous seal's `to`. A tenant's first seal starts at its earliest `received_at`.
- `to` ≤ database clock − **10 minutes**: `received_at` is stamped by the API process (`v2-storage.ts`), so the margin covers commit lag and clock skew (same assumption as `evidence-pack.md`: API hosts keep their clocks close to the database's).
- A seal holds at most **8 000** rows, so a document stays about 1 MiB (129 bytes a row). A larger backlog is sealed back to back: `to` is then the `received_at` of the first row that does not fit, so rows sharing one instant are never split; more than 8 000 rows at one instant (at least 16 full 500-record uploads in the same millisecond) is refused with `ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW`.
- A seal is due when the tenant has unsealed rows before the cutoff **and** its last seal is at least an hour old, or when its last seal is at least 24 hours old (an empty window proves "nothing arrived"). Within one pass, rows left after a full 8 000-row chunk are due at once (the backlog), never as an empty window. `--now` drops the age rule (an operator about to build a report): rows are sealed at once, and an empty window only when the last seal's `to` is at least a minute behind the cutoff, so a second run is not due. A tenant with no finding row has no seal.
- Who seals: `npm run attesta:security-seal -w apps/api` (dry run; `--confirm` to seal; `--tenant <uuid>`, `--now`; actor `system_operator`). The founder schedules it (hourly); it is not in the worker loop (checkpoint 2026-10-18).
- How: read in one repeatable-read snapshot, sign with the tenant's statement key outside any transaction, then in one ledger transaction re-check the last seal, chain the statement, store the seal row and write `audit.trail.security_findings_sealed`.

## Table `attesta_security_finding_seals` (migration 0027)

The `attesta_audit_seals` columns plus `task6a_count` and `v2_count`. One row per seal, written only in the ledger transaction that chains it. Append-only (no UPDATE, DELETE or TRUNCATE). The insert guard checks: the digest is SHA-256 of the document; the columns equal the document's; the record is this tenant's security-findings-seal statement naming this digest, window and previous; and `previous_digest` is the tenant's latest seal with `window_from` = its `window_to` (or null with no seal yet). A second seal over one window, or a gap, is refused by the database.

## The verify report (`GET /api/attesta/security-seals/verify?from&to`)

`attesta.read` (tenant administrator or auditor); `no-store`; one `audit.trail.security_findings_verified` event per call. For every seal overlapping `[from, to)` (RFC 3339; at most 31 days apart, at most 1 000 seals and 500 000 rows, else 400 `ATTESTA_API_INVALID_QUERY`): recompute each sealed row's digest from the current table and the `rows_root`, check the `previous` links and windows, and run Attesta's chain, signature and anchor check (`verifyRange`) on each seal record's own `seq`. A row received before the tenant's first seal is in no window, so it was inserted after sealing: `unsealed_row_in_sealed_window` against the first seal. A seal ledger record with no seal row (a removed seal) is `broken_previous`.

```text
{ ok, from, to, seals_checked,
  breaks: [{kind, seal, row_id?}],        kind: missing_row | changed_row | unsealed_row_in_sealed_window
                                                | broken_previous | statement_problem
  breaks_truncated,
  unsealed_tail: {from, count},           rows at or after the last seal's `to`: "not sealed yet", never "verified"
  chain: {ok, checked} }
```

`ok` is true only with no break and an `ok` Attesta check (signatures checked, no anchor or key-window finding). `unsealed_tail` never makes a report not ok and is never called verified. A seal proves the register was not altered after sealing; it never says a finding was blocked (monitor-only, AGENTS.md rule 7).

## Rules SS1–SS6 (`security-seal-service.ts`)

| ID | Rule |
|---|---|
| SS1 | `subject[0].name` = `trackai:tenant/<predicate.tenant_id>/security-findings/<window.from>..<window.to>`; `subject[0].digest.sha256` = SHA-256 of the document bytes; `from` < `to` |
| SS2 | The document's `tenant_id`, `window`, `count`, `generations`, `rows_root` and `previous` equal the predicate's (`previous_seal`); `tenant_id` = the ledger record's tenant |
| SS3 | `count` = `rows.length` = `generations.task6a + generations.v2`; `rows` in (`received_at`, `id`) order with unique ids; `rows_root` recomputes |
| SS4 | With the table at hand: every sealed id exists in the window with the same digest, no other row of the tenant is in the window, and the generation counts match the rows |
| SS5 | `previous` is the prior seal's digest and its `to` is this seal's `from`; the first seal has `previous: null` |
| SS6 | The statement verifies, chains and anchors like any Attesta statement (`envelope.md`, `tables.md`) |

## Evidence packs and the offline verifier

A tenant pack (`scope.repository_id` null) lists seal statements in its window under `statements` like any other; a repository pack does not (they name no repository). `reports` stays `[]` (checkpoint 2026-10-18: filling it is a separate, approved change to the frozen pack schema). The offline verifier checks a seal statement against this schema and the record's typed columns; SS2–SS4 need the document and the rows, so it reports them as not checkable (exit 2), never as passed.

## Provenance

Pattern: Task16e audit-seal / Task15i4 period-report (SushiCorp RP-1); EV-1 reused through Attesta, not re-ported. Deviations from audit seals: the window compares `received_at`; the settle margin is 10 minutes (5 for audit); a seal holds 8 000 rows (50 000 for audit), so a document stays near the 1 MiB statement bound; the document carries `generations` and no catalog version.
