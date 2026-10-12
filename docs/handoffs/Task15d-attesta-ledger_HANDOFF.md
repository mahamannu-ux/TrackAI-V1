# Task15d-attesta-ledger Handoff — Attesta ledger, chain guards and verify report (A15.3)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15d-attesta-ledger` (base: `main` at `ea4364e`).

One hash chain per tenant (`chain_head`, `attesta_records`, `attesta_envelopes`, migration `0017`), database guards that make it append-only and gap-free, `chainStatement` (the one ledger transaction of `envelope.md` step 7) and `verifyChain` (a structured report). Not built: the builder and worker (A15.8), anchoring (A15.5), routes (A15.9), `period_report` records (A15.9).

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 deliverables 1–5: migration, guards, `ledger.ts`, `verify-chain.ts`, unit + live tests | ✅ |
| Quality | `npm test` 444 pass (52 new), typecheck, lint, `npm run check`, `drizzle-kit check` clean | ✅ |
| Integration | IT-T15d-01…04 via `scripts/it-db.sh`, also at the founder size (50×20 writers, 10 000 records: chain 42 s, verify 2.3 s, heap +15 MB) | 🟡 agent-verified; founder run pending |
| Review | review subagent: 2 must-fix (definer `search_path` hijack; report `ok` without keys), 5 should-fix; all fixed, IT cases added | ✅ · cross-agent review pending |

## Implemented interfaces
```
ledger.ts  chainStatement(tx, input, clock?) → { recordId, seq, recordHash, statementDigest, duplicate }
  input { tenantId, statementCanonical, envelope, credentialId, keyid, signatureDer, publicKeySpkiDer,
          outboxClaim?: { subjectId, claimedAt /* RFC 3339, µs, string */, attempts }, previousSeen }
  AttestaLedgerError(code, retryable) · mapLedgerDatabaseError(err) · deriveStatementColumns · buildCanonicalRecord
verify-chain.ts  verifyChain(db, tenantId, { fromSeq?, toSeq?, keys?, pageSize?, maxBreaks? }) → ChainReport
  ChainReport { report_version, tenant_id, range, checked, ok, chain_intact, breaks: [{seq, kind, detail_code}],
                breaks_truncated, head: {next_seq, head_hash} | null, signatures, warnings }
  verifyChainRows(rows, opts) (pure, streaming) · BREAK_DETAIL_CODES (kind → errors.md code)
npm run verify:task15d-ledger-live -w apps/api
```

## Ported from
SushiCorp EV-1 @ `0bd67a5`: `records.py`, `verify.py`, `0001_initial_schema.py` guards, IT-D1-03, the verify tests. Kept: record-hash rule, genesis, `seq` from `chain_head … FOR UPDATE`, stored bytes, guard set, break kinds, tamper matrix. Deviations (reasons in the file headers): statement record with typed copies derived from the statement; raw SQL in the caller's transaction; outbox `done` and `previous` re-check inside the lock; `recorded_at` clamped forwards; signature verified before storing (input adds `publicKeySpkiDer`); built-in `sha256()` instead of pgcrypto (pgcrypto sits outside `pg_catalog` on Supabase); guard `search_path = pg_catalog, pg_temp` (the prompt said `, public`: public lets a role shadow `to_jsonb(anyelement)` and run code as the definer); the guard rebuilds `canonical_record` byte for byte from the columns; verify streams (no reorder, counts only, `maxBreaks`), adds statement/envelope/signature kinds, codes instead of free-text detail; the 10 000-record matrix applies each tamper at all sampled positions in one verify.

## Adversarial cases (listed before the guards were written)
| Attack | Stopped by | Test |
|---|---|---|
| App role UPDATE / DELETE / TRUNCATE on records, envelopes, head; head skip, back, foreign hash, tenant change, touch | reject + head triggers (`ATG01`) | IT-01 (API role and RLS role, 33 each) |
| Insert past / over the head, stale `prev_hash` | record guard (`ATH01` → HEAD_CONFLICT) | IT-01 |
| Wrong `record_hash` / `statement_digest`; non-canonical, extra or duplicate-key record bytes | record guard rebuilds the bytes | IT-01 |
| Buggy builder: typed column ≠ record ≠ statement, null copies, envelope over other bytes, sig ≠ column, keyid ≠ key, signature not verifying, `previousSeen` ≠ statement | `validateChainInput` + guards | unit `validateChainInput`, IT-01 |
| Head left behind / record without envelope at COMMIT | deferred `attesta_records_commit_guard` | IT-01 |
| Definer hijack via objects in `public` | `search_path = pg_catalog, pg_temp` | IT-01 `search_path_hijack` |
| Two workers on one outbox row; lease expiry | claim re-read `FOR UPDATE` (status, µs `claimed_at`, attempts) → CLAIM_LOST; unique `(tenant, outbox_subject_id)` | unit, IT-02 |
| Crash between signing and chaining | nothing stored; retry rebuilds (new `as_of`); same bytes dedupe on digest | IT-02 duplicate |
| Company B uses A's claim, repository or outbox id | tenant-bound queries, composite FK, guard check on `outbox_subject_id` | IT-01, IT-03 |

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | A role that **owns** the tables (or a superuser) can drop or disable the triggers | Detected only by `verifyChain` with keys and, later, anchoring (A15.5); prod should run the API as a non-owner role |
| 🟡 | The database never verifies signatures (a consistent forged envelope commits if inserted by raw SQL) | `chainStatement` verifies before insert; `verifyChain` with published keys reports `signature_invalid` |
| 🟡 | errors.md has no exact code for seq/field/tenant/order/head/envelope kinds; mapped to the nearest frozen code, `kind` stays precise | **FOUNDER:** decide on additive codes (question in the final reply); non-blocking |
| 🟡 | `period_report` records refused (CHECK + guard are ai-provenance only) | A15.9 extends both in a new migration |
| 🟡 | `npm test` grows by about 6 s (the 10 000-record matrix) | — |

## Integration test impact
> **FOUNDER:** blocking for A15.5 and A15.8 merges. Prerequisites: Docker or local PostgreSQL 16 + pgvector. Expected: `IT-T15d=passed`, about 1 minute at the size below.
> ```bash
> IT_T15D_WRITERS=50 IT_T15D_APPENDS=20 IT_T15D_VOLUME=10000 scripts/it-db.sh npm run verify:task15d-ledger-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15d-01 | Guards as API role and RLS role; definer settings; RLS on, no policies; SQL = TS = known-answer hash; hijack not resolved | Blocking: A15.5/A15.8 merge | 🟡 agent-verified · ⬜ founder run |
| IT-T15d-02 | Gap-free under parallel writers with rollbacks (IT-D1-03); claim lost; previous stale; duplicate; caller IMMEDIATE; rollback no gap | Blocking: A15.8 merge | 🟡 (50×20) · ⬜ |
| IT-T15d-03 | Company A/B: separate clean chains, no cross-tenant claim or repository | Blocking: A15.9 merge | 🟡 · ⬜ |
| IT-T15d-04 | 10 000-record chain verifies clean; one row changed behind the guards found; time and heap printed | Non-blocking | 🟡 (10 000 records) · ⬜ |

## Integration notes
- Call order (A15.8): build and sign **outside** any transaction, then `db.transaction(tx => chainStatement(tx, …))`. Map `retryable` codes to `pending` with backoff; `CLAIM_LOST` means stop; `GUARD_VIOLATION` is terminal and should alert.
- Read `claimed_at` for `outboxClaim` with `to_char(claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, never through a JS `Date` (drops µs, the claim never matches).
- `chainStatement` may be called several times in one transaction; it sets only its own constraint trigger and leaves it `DEFERRED`.
- `verifyChain` is `ok` only with published keys; use `chain_intact` for structure-only checks. Pass `db` (it opens a REPEATABLE READ read-only snapshot).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.3× (plan 0.25×) | about 0.3× | ~70 turns + 1 review subagent | ~3 h | ~0.4M tokens + 0.18M review |

Within 1.25× of the estimate. The review round (two must-fix) cost about a fifth of the session.
