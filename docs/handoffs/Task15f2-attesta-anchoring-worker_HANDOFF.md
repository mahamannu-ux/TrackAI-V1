# Task15f2-attesta-anchoring-worker Handoff — anchor tables, batching worker, anchor checks in the verify report (A15.5, part 2 of 2)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15f2-attesta-anchoring-worker` (base: `main` at `9699d70`). Anchoring is now real: migration 0018 (two append-only tables), the plan → submit → record worker with a CLI, and the anchor checks in the verify report. Only the 32-byte Merkle root leaves the tenant. No routes (A15.9), no real network (A15.13), no trust-layer keys (Task15l).

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 items 1–8: migration 0018, worker, env wiring, CLI, verify report, exact codes and LOG_REJECTED, `ajv` move, F2 removal | ✅ |
| Quality | `npm test` 663 pass (baseline 635); typecheck clean; `drizzle-kit check` clean | ✅ |
| Integration | IT-T15f-01…04 pass in the agent sandbox (also at 600 records); IT-T15d and IT-T15c re-run clean | 🟡 founder run, blocking |
| Review | Review subagent: 1 must-fix (shard-offset keys decimal vs hex) and 4 should-fix; all fixed (see Deviations 4–7) | ✅ |
| Cross-review | Codex | ⬜ |

## Implemented interfaces (`apps/api/src/features/attesta/`)
```
anchor-worker.ts  runAnchorPass(db | AnchorStore, { anchor: DualAnchor, now? }, { maxBatch=256 (≤4096), partialAfterMs=600_000,
                    tenantId?, limitTenants?, maxBatchesPerTenant=16 }) → AnchorPassResult (counts + codes)
                  planTenant · rowsForOutcome · anchorBackoffMs (30 s doubling, cap 1 h) · anchorBatchId · pgAnchorStore(db)
anchor-env.ts     anchorSignerFromEnv(env) · anchorFromEnv(env) → { anchor: DualAnchor, verify: AnchorVerifyMaterial }
                  ATTESTA_ANCHOR_CREDENTIAL_ID, ATTESTA_DEV_ANCHOR_KEY_FILE (non-production), ATTESTA_REKOR_URL,
                  ATTESTA_REKOR_LOG_KEY_FILE, ATTESTA_REKOR_LOG_INDEX_OFFSETS ({"<decimal tree id>": n}), ATTESTA_TSA_URL,
                  ATTESTA_TSA_ANCHORS_FILE. Production: refuses to start until Task15l supplies the platform resolver.
CLI               npm run attesta:anchor -w apps/api [-- --loop --tenant <uuid> --max-batch 256 --partial-after-ms … --sleep-ms 300000]
verify-chain.ts   verifyChain(db, tenant, { …, anchors?: { rekorLogKey, rekorLogIndexOffsets?, anchorKeysSpkiDer, tsaAnchors,
                    windowMs=3_600_000, now, onRecord? } }) → report.anchors = { status:'checked', anchored, pending, missing,
                    invalid, not_checkable } | { status:'not_checked' }. CHAIN_REPORT_VERSION 1 → 2 (the new `anchors` field).
anchor-contract   TERMINAL_ANCHOR_CODES = { LOG_KEY_NOT_PINNED, LOG_REJECTED }; AnchorErrorCode gains ATTESTA_ANCHOR_LOG_REJECTED
```

## Guards (migration 0018) and the test for each
| Guard | Test |
|---|---|
| UPDATE / DELETE / TRUNCATE raise on both tables (`attesta_ledger_reject_mutation`, reused from 0017) | IT-T15f-03, API and RLS role |
| Batch: `batch_id = tenant:from-to`, `leaf_count = to − from + 1` ≤ 4096, root shape (check); next contiguous range only (ATA01: no gap, no overlap, per-tenant advisory lock); every seq a record of the tenant; `merkle_root` rebuilt in SQL from the record hashes | IT-T15f-03, -04; roots cross-checked with merkle.ts in IT-T15f-01 |
| Anchor: anchored ⇔ proof, no code; failed ⇔ code, no proof; uuid only for rekor, token only for tsa (check); record and batch in the same tenant, record inside its batch; proof bound to `leaf_index`, `tree_size`, type, ref (= uuid, or `tsa:sha256(token)`), and its path leads to the batch root | IT-T15f-03 (33 attacks as the API role, 6 as an RLS role) |
| Partial unique index: one `anchored` row per record and type; composite tenant FKs; RLS on, no policies; definer functions with `search_path = pg_catalog, pg_temp` | IT-T15f-03, -04 |

## Ported from
SushiCorp EV-2 @ `0bd67a5`: `services/anchoring/service.py`, `core/evidence/anchoring.py`, `core/evidence/verify.py`; service tests ported first (`anchor-worker.test.ts`). Deviations are in the `anchor-worker.ts` header: one row per type, tenant-scoped contiguous batches, batch row written at record time, terminal codes stop a batch, many batches per pass.

## Deviations from spec (shared files beyond §2.3 named)
1. `anchor-contract.ts` (not pre-approved): `ATTESTA_ANCHOR_LOG_REJECTED` added to the code union, plus `TERMINAL_ANCHOR_CODES`. The 400/422 switch cannot compile without it.
2. `t15d-ledger-live-verify.ts` (not pre-approved): one grant. 0018's FK makes `TRUNCATE attesta_records CASCADE` reach `attesta_anchors`. The RLS role then got 42501 before the guard fired. It now also has TRUNCATE on the anchor tables, so the attack reaches the guard again (IT-T15d passes).
3. Failure count for backoff = failed attempts, i.e. failed rows ÷ `leaf_count`. One attempt writes one row per record, so a raw row count would hit the 1 h cap at once.
4. Review fix: shard offsets are given as decimal tree IDs (as checkpoint origins print them) and keyed by the 16-hex ID that `verifyRekorEntry` looks up. Before the fix, every sharded entry would have failed.
5. Review fix: the anchor guard also binds the Merkle path to the batch root. "Complete" now means one anchored row per record in each type. A bogus anchored row can no longer take a record's slot.
6. Review fix: stopped batches sort after due ones and never make a tenant a candidate on their own. `ATTESTA_SIGNER_REJECTED` is retried with backoff, not terminal (the spec names only two terminal codes).
7. Review fix: a `recorded_at` ahead of the verifier's clock (beyond 5 min) counts as `missing`, never `pending`. An anchor time before `recorded_at − 5 min` is `ANCHOR_INVALID`.
8. Verify statuses add `invalid` and `not_checkable` to anchored / pending / missing. NOT_CHECKABLE is one break per report (like `signatures_not_checked`). `anchor_missing` and the anchor-invalid kinds make `chain_intact` false; only the not-checked kinds do not.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | A stopped batch (LOG_REJECTED, LOG_KEY_NOT_PINNED) cannot be resumed. The tables are append-only and no operator "resume" marker exists yet | Its records stay `ANCHOR_MISSING`. Proposed: an append-only resume row plus an audited CLI, in Task15i or a small follow-up |
| 🟡 | The plan's advisory lock does not stop two passes submitting one root (two log entries, two tokens) | Harmless: the database keeps one anchored row per record and type |
| 🟡 | `IT-T15h-02` fails in this sandbox ("lease recovery re-ran the row"), on `main` too | Pre-existing, not from this branch; the founder's run decides |

## Integration test impact
> **FOUNDER:** blocking for this merge and for A15.9. Prerequisites: PostgreSQL 16 with pgvector (`scripts/it-db.sh`). Expected: `IT-T15f2=passed` in about a minute; volume run about 2 s per 600 records.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15f-01 | N records anchor in one pass; roots agree in SQL and TS; verify `ok`, all `anchored`; a second pass adds nothing | Blocking: merge, A15.9 | 🟡 agent-verified (20, 600) · ⬜ founder |
| IT-T15f-02 | 6 lying-log knobs → `failed` with the right code, records byte-identical; honest pass anchors the same batch_id/root; LOG_REJECTED stops, then ANCHOR_MISSING | Blocking: merge | 🟡 · ⬜ |
| IT-T15f-03 | Guards as API and RLS role; crash between submit and record → same root, recorded once; concurrent passes; overlapping ranges → ATA01 superseded | Blocking: merge | 🟡 · ⬜ |
| IT-T15f-04 | Company A/B: no mixed batch; B cannot anchor A's record or batch A's seqs; both verify clean | Blocking: merge, A15.9 | 🟡 · ⬜ |

## Integration notes
- A15.9 / A15.10: pass `anchors` material to `verifyChain`, and keep retired anchoring public keys in `anchorKeysSpkiDer`. Report version is now 2.
- A15.13 (founder-live): pin the sigstage log key file, `ATTESTA_REKOR_LOG_INDEX_OFFSETS` from one current entry (decimal tree ID → offset) and the FreeTSA root in `ATTESTA_TSA_ANCHORS_FILE`. Then run `attesta:anchor` once against real endpoints.
- Task14 schedules `attesta:anchor` (a pass every 5 minutes). Task15l replaces the dev signer in `anchorSignerFromEnv`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| 0.2× (likely 0.25×) | about 0.3× | one review round with five fixes, live verifier, the IT-T15d regression found and fixed |

Over 1.25× the 0.2× plan, within 1.25× of 0.25×. Causes: the review round (a must-fix in env wiring that unit tests could not see) and the live guard matrix. Next prompt: budget the review fix round inside the estimate for any guard-plus-worker session.
