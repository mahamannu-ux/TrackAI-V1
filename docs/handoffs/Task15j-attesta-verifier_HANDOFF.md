# Task15j-attesta-verifier Handoff — offline evidence-pack verifier (A15.10)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15j-attesta-verifier` (base: `main` at `9fd6740`). Counsel runs one command on a laptop with no TrackAI account and no network; the exit code says whether the pack is genuine and complete (0), broken (1) or not checkable (2). No database, no network, no routes; existing files only imported, plus the `attesta:verify-pack` script line.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | Pure `verifyEvidencePack`, CLI, 50 tests, script line, import-graph purity | ✅ |
| Quality | `npm test` 841 pass (baseline 791); typecheck, lint, `npm run check` clean | ✅ |
| Integration | None (no database). Founder clean-machine run is A15.13 | n/a |
| Review | Self-review as reviewer (fixed anchor-agreement branches, trust-unavailable mapping, reports carve-out) | ✅ |

## Implemented interfaces
```
verifyEvidencePack(download: unknown, options: OfflineVerifyOptions): OfflineReport
// options: pinnedRootKeyids (or customerPins), rekorLogKeyPem?, tsaAnchorsPem?,
//   lastTrusted?, trustedTimeFloor?, now, anchorWindowMs? (default 3600000)
// report: {report_version: 1, result, exit_code, tenant_id, pack_id, generated_at,
//   checks: [trust_and_signature, structure, chain, completeness, statements, anchors, reports],
//   counts: {records, statements, anchors_verified}, trusted?, trustedTime?}
npm run attesta:verify-pack -w apps/api -- --pack <download.json> (--root-keyid sha256:… … | --customer-pin <file>)
  [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--state <file>] [--json]
```

## Ported from
SushiCorp `services/anchoring/offline_verify.py` @ `0bd67a5` (catalog EV-2): per-check structure, "nothing missing is ever a pass", exits 0/1/2, tamper cases first. Deviations: Node not Python; trust documents travel in the pack but the pin is the user's; DSSE/in-toto not JCS records; two pack modes.

## Deviations from spec
1. **Reordered key sets verify (exit 0), truncated exit 2 — not exit 1.** The frozen trust layer sorts documents by version (order carries no meaning; versions plus `previous` digests define the chain) and calls a history not starting at v1 `DOCUMENT_UNAVAILABLE`. Contradicting it would fork from GitAI's vectors; the tests assert frozen behavior.
2. **Schema errors confined to `/reports` defer to the reports check.** v1 freezes `reports: []` (`maxItems: 0`); a future pack with reports is not-checkable per spec, not a structure break.
3. **Unavailable trust in a statement is not-checkable, not a break** (trust.md Consumers: unavailable → exit 2).
4. **Missing `--state` file starts empty** (first use); existing-but-bad state is exit 2.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Sandbox-verified only; the clean-machine auditor run is A15.13 | Founder run before any customer claim |
| 🟡 | Post-rotation packs signed by retired keys fail (no signature time evidence exists for pack signatures); re-export | Counsel asks for a fresh export, as with expiry |

## Test coverage
50 tests (38 verifier + 12 CLI): good full/repository_only/pending packs, every listed tamper plus schema/rule lies, forger/conflict/foreign-keyset attacks, real fakes (window-expiry, foreign TSA), retired-key evidence, state write/read/rollback, purity, garbage input. Real Rekor/TSA/KMS stand in via `FakeRekor`/`FakeTsa`/in-process KMS; no mocks of product code.

## Integration test impact
None (no database; no new `IT-` rows). A15.13 runs the CLI on a clean machine — non-blocking for merge.

## Integration notes
- `anchorKeyWindows` come only from `trusted.platform`; without user key material anchors are not-checkable, never valid. Pending age is measured at `generated_at`, never now. Warnings never change the exit code.
- A15.13: `npm run attesta:verify-pack -w apps/api -- --pack <download.json> --root-keyid <pin> --rekor-log-key <pem> --tsa-anchors <pem>`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| about 0.1× | about 0.15× | Fixture statements are schema-minimal, so tests build schema-valid chains from frozen fixtures; trust-layer ordering semantics needed two deviations above |
