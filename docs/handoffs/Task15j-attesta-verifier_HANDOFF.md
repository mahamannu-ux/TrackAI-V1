# Task15j-attesta-verifier Handoff — offline evidence-pack verifier (A15.10)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15j-attesta-verifier` (base: `main` at `9fd6740`). Counsel runs one command on a laptop with no TrackAI account and no network; the exit code says whether the pack is genuine and complete (0), broken (1) or not checkable (2). No database, no network, no routes; existing files only imported, plus the `attesta:verify-pack` script line.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | Pure `verifyEvidencePack`, CLI, 64 tests, script line, import-graph purity | ✅ |
| Quality | `npm test` 855 pass (baseline 791); typecheck, lint, `npm run check` clean | ✅ |
| Integration | None (no database). Founder clean-machine run is A15.13 | n/a |
| Review | Self-review plus cross-review fix round (6 fixes, all in, tests for each) | ✅ |

## Implemented interfaces
```
verifyEvidencePack(download: unknown, options: OfflineVerifyOptions): OfflineReport
// options: pinnedRootKeyids (or customerPins, or both: pin decides, root feeds anchor
//   windows), rekorLogKeyPem?, tsaAnchorsPem?, rekorLogIndexOffsets? (decimal tree ids,
//   user-supplied; the pack's value only warns), lastTrusted?, trustedTimeFloor?, now,
//   anchorWindowMs? (default 3600000)
// report: {report_version: 1, result, exit_code, tenant_id, pack_id, generated_at,
//   checks: [trust_and_signature, structure, chain, completeness, statements, anchors, reports],
//   counts: {records, statements, anchors_verified}, trusted?, trustedTime?, verifier_error?}
npm run attesta:verify-pack -w apps/api -- --pack <download.json> (--root-keyid sha256:… … | --customer-pin <file>)
  [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--rekor-log-index-offsets <json>] [--state <file>] [--json]
```

## Ported from
SushiCorp `services/anchoring/offline_verify.py` @ `0bd67a5` (catalog EV-2): per-check structure, "nothing missing is ever a pass", exits 0/1/2, tamper cases first. Deviations: Node not Python; trust documents travel in the pack but the pin is the user's; DSSE/in-toto not JCS records; two pack modes.

## Deviations from spec
1. **Reordered key sets verify (exit 0), truncated exit 2 — not exit 1.** The frozen trust layer sorts by version and calls a non-v1-starting history absent trust information. Contradicting it would fork from GitAI's vectors.
2. **Schema errors confined to `/reports` defer to the reports check** (v1 freezes `reports: []`; future reports are not-checkable, not a structure break).
3. **Unavailable trust in a statement is not-checkable** (trust.md Consumers); an `anchored` claim missing either type's row is invalid; record typed fields must equal the signed statement (0017 guard rule).
4. **Rekor offsets come only from the user** (review correction: the pack's value only warns); missing `--state` starts empty with a first-use notice; environment failures (schemas, unexpected) read not-checkable with `verifier_error`, never failed.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Sandbox-verified only; the clean-machine auditor run is A15.13 | Founder run before any customer claim |
| 🟡 | Post-rotation packs signed by retired keys fail (no signature time evidence); re-export | Counsel asks for a fresh export, as with expiry |
| 🟡 | Each statement re-runs the trust chain: a 50 000-statement pack verifies slowly | Later optimization only if an auditor pack proves slow |

## Test coverage
64 tests (47 verifier + 17 CLI): good full/repository_only/pending packs, every listed tamper plus schema/rule/binding lies, forger/conflict/foreign-keyset attacks, real fakes (window-expiry, foreign TSA, offsets use/mismatch), retired-key evidence, pins+root windows, state write/read/rollback, env failures, purity, garbage input. Real Rekor/TSA/KMS stand in via `FakeRekor`/`FakeTsa`/in-process KMS; no mocks of product code.

## Integration test impact
None (no database; no new `IT-` rows). A15.13 runs the CLI on a clean machine — non-blocking for merge.

## Integration notes
- `anchorKeyWindows` come only from `trusted.platform` (or the pins+root second call); without user key material anchors are not-checkable, never valid. Pending age is measured at `generated_at`, never now. Warnings never change the exit code.
- A15.13: `npm run attesta:verify-pack -w apps/api -- --pack <download.json> --root-keyid <pin> --rekor-log-key <pem> --tsa-anchors <pem>`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| about 0.1× | about 0.2× | Schema-minimal fixtures needed valid-statement chains; one cross-review round (6 fixes incl. offsets source correction) |
