# Task15i2-attesta-evidence-packs Handoff — signed evidence packs, real keys in /verify (A15.9, part 2 of 3)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15i2-attesta-evidence-packs` (base: `main` at `a3e9e73`). An admin or auditor exports one signed JSON file that a third party checks offline. The pack format is frozen (`docs/contracts/attesta/evidence-pack.md`, schema `evidence-pack-v1.schema.json`), so A15.10 can start. This session also adds the export job and three routes, puts the real published keys and per-run anchor windows into `/verify`, and switches `attesta:build` to the inventory signer in production. Out of scope: `period_report` (Task15i3), the console (A15.11) and the verifier program (A15.10). **Anchor resume moved to Task15i3** (estimate rule, founder-agreed).

## At a glance
| | Item | Status |
|---|---|---|
| Scope | Items 1–6, 8 and 9 of the spec: contract, migration 0020, builder and RP-1 signature, job and `attesta:pack` CLI, routes under `attesta.export`, real keys in `/verify`, production build resolver, the three new API codes | ✅ |
| Quality | `npm test` 791 pass (baseline 756); typecheck clean; `drizzle-kit check` clean | ✅ |
| Integration | IT-T15i2-01…03 and the IT-T15i-01…03 regression passed (agent sandbox and founder run 2026-10-13) | ✅ |
| Review | Review subagent: 2 must-fix (the oracle accepted reordered or rolled-back trust documents) and 5 should-fix; all fixed except one, which is documented (Known limitations) | ✅ |
| Cross-review | Muse 2026-10-13 (Codex unavailable): attacks A–H executed by script (forged packs vs the oracle, leaks, A/B isolation, signed values, lease races, 0020 guards, authorization, boundaries); no findings; ready to push | ✅ |

## Pack format (summary)
`{pack, signature}`. The `pack` is RFC 8785 JSON: `manifest` (format, pack_id, tenant_id, `scope {repository_id, from, to, mode}`, `chain_range {from_seq, to_seq, prev_hash, head}`, generated_at, completeness, counts, a SHA-256 per section), `records` (the window plus one boundary record on each side), `statements` (`anchor_status` is `anchored` or `pending`), `anchors`, `anchor_batches`, `trust` (root documents, key sets from version 1, anchoring keys with their root entry, Rekor key and offsets, TSA anchors), `verification_hint` (a hint only: the user supplies the pin), `reports: []` and `verifier: null`. The `signature` is a DSSE envelope (`application/vnd.trackai.evidence-pack+json`) over `{manifest, pack_digest}`, signed with the tenant's active statement key. It is not chained. Limits: at most 50 000 records, and `to` at least 5 minutes before generated_at.

## Implemented interfaces
```
POST /api/attesta/evidence-packs  Idempotency-Key: acq-2026-q3
  {"from":"2026-07-01T00:00:00Z","to":"2026-09-30T23:59:59Z","repository_id":"0000…a1","mode":"repository_only"}
  → 202 {"id":"2222…01","status":"queued","replayed":false}; same key and scope → 202 same id, replayed:true; other scope → 409 ATTESTA_API_CONFLICT
GET  /api/attesta/evidence-packs/2222…01
  → {"id","status":"ready","scope","mode","counts":{"records":5,"statements":3,"anchored":3,"pending":0,…},"pack_digest":"sha256:…",
     "bytes":48211,"error_code":null,"retryable":null,"created_at","finished_at","content_path":"/api/attesta/evidence-packs/2222…01/content"}
GET  /api/attesta/evidence-packs/2222…01/content → 200 attachment {"pack":{…},"signature":{…}} (no-store, audited)
npm run attesta:pack -w apps/api -- --run-queued [--limit 20]   # recovery of queued or lease-expired jobs
```
- Code: `evidence-pack-service.ts`: `buildPack` (pure), `signPack`, `runEvidencePack`, `pgPackStore`, `packTrustFrom`, `defaultPackJobDeps`, `signedByNewestKeyset`. `read-service.ts`: `publishedKeySource`, and `anchorMaterialFromEnv` (in production it now re-reads the windows on every call).
- Audit actions `attesta.export.request` (also on replays) and `attesta.export.download` carry the request ID, scope, mode and counts; the only digest they carry is the pack digest. Job codes `ATTESTA_SIGNER_UNAVAILABLE`, `ATTESTA_API_UNAVAILABLE` and `ATTESTA_API_INTERNAL` are retryable with a new key; `ATTESTA_SIGNER_NO_CREDENTIAL`, `ATTESTA_SIGNER_REJECTED` and `ATTESTA_API_INVALID_QUERY` are not.
- Migration 0020 (`attesta_evidence_packs`): RLS on, status only moves forward, identity columns fixed, no DELETE or TRUNCATE.

## Founder-approved decisions
1. 2026-10-13: ship both modes, default `full`; no per-repository Merkle commitment in phase 1.
2. 2026-10-13: anchor resume (spec item 7) moves to Task15i3; the estimate came in above 0.25×.

## Deviations from spec
1. **Not pre-approved:** two new test-support files, `testing/evidence-pack-fixtures.ts` and `testing/evidence-pack-oracle.ts`. They are shared by the unit and live tests. `core/security/security.test.ts` (the test for `admin-authorization.ts`) gained one line.
2. **Boundary records:** the segment includes one boundary record on each side of the window, so completeness can be proven. `chain_range` also carries `prev_hash`. Statements gain `seq`, `statement_digest` and `anchor_status`.
3. **`verify-chain.ts` is unchanged.** It already checks signatures against every key the tenant ever activated. Applying key windows needs a new verify break code, which is a contract change outside §API (see Known limitations).
4. **CLI flag:** `attesta:pack` takes `--run-queued` only (production scheduling is Task14).
5. **Review fixes:**
   - The oracle walks root documents and key sets in version order.
   - The oracle checks `counts`, `completeness`, `anchor_status` and duplicates against the pack's own content.
   - A job fails, retryably, if its signature does not verify with the pack's own newest key set.
   - A created job always starts, even when the audit write fails.
   - Stranded jobs no longer count toward the 4-job limit.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | `/verify` treats every key the tenant ever activated as valid at any time. It does not check revocation times or time evidence. | A statement signed after a key was compromised would still show `ok`. The offline verifier (trust.md step 8) catches it. **Recommended for Task15i3:** an additive `ATTESTA_VERIFY_KEY_NOT_VALID_AT` code and a check of each record's anchor time in `verify-chain.ts` |
| 🟡 | The 5-minute settle rule assumes each API host's clock is within 5 minutes of the database clock. `recorded_at` comes from the writer's clock. | Run NTP on API hosts. This is stated in the contract |
| 🟡 | Withholding the newest key set is not detectable offline without a persisted `lastTrusted` (trust.md first-use limit). | A15.10 persists `lastTrusted` |
| 🟡 | Jobs run inside the API process. A large pack (up to 50 000 records) is held in memory, and a crash leaves the job queued until `attesta:pack --run-queued` runs. | Task14 schedules the recovery pass |
| 🟡 | A malformed JSON body gets the app's generic 500, not a problem response. The CORS allow-list lacks `Idempotency-Key` and `X-Request-ID`. Both live in `app.ts`, which is not this session's to change. | Matters for the console (A15.11) |

## Test coverage
`evidence-pack.test.ts` (24 tests: determinism, boundaries, both modes, refused segments, raw-content scan, signature, oracle tampering and re-signed lies, trust-document order, the job with leases, codes and A/B); `attesta-api.test.ts` (routes, idempotency, 409/429, A/B 404s, validation before the store, tampered file, AU-1 sweep with `attesta.export`, `/verify` keys); `attesta-build-cli.test.ts` (production never reaches the dev resolver; recovery pass).

## Integration test impact
- **Command:** `scripts/it-db.sh npm run verify:task15i2-evidence-packs-live -w apps/api` (about 15 s; needs PostgreSQL 16 with pgvector).
- **Blocking:** this merge and A15.10. Status for all three: ✅ founder run 2026-10-13 (agent-verified the same day). ~~**FOUNDER:** run it once.~~ (2026-10-13)

| ID | Proves |
|---|---|
| IT-T15i2-01 | Builder, keys and anchoring → POST → ready → download. The oracle verifies everything from the user's pin, `pending` is 0, and `/verify` is `ok` with signatures and anchors checked |
| IT-T15i2-02 | Company A/B: identical 404s; neither tenant's pack contains the other's records; a relabelled pack fails |
| IT-T15i2-03 | The auditor exports and downloads, both audited; 403s; idempotency and 409; `repository_only` hides the other repository; the 0020 guards |

## Integration notes
- **A15.10 (Muse):** copy "What a verifier checks" in `evidence-pack.md`. Start from `testing/evidence-pack-oracle.ts` and its negative cases in `evidence-pack.test.ts`. Add the Rekor and TSA checks (`verifyStoredAnchor`), key windows with time evidence, a persisted `lastTrusted`, and exit codes 0, 1 and 2.
- **Task15i3** (split 2026-10-13): the anchor-resume action (append-only `attesta_anchor_resumes`, the audited CLI, the resume rule in `anchor-worker.ts`) and the `/verify` key-validity check above. **Task15i4:** fills `reports` with period-report documents.
- **Task14:** schedule `attesta:pack --run-queued`, provision `TASK4_EXPORT_DIR` and keep API host clocks in sync.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| 0.2× plan, 0.3× in the design note (0.25× without resume) | about 0.25× | Resume moved out. One review round with two oracle must-fixes. The live test passed on the first run |
