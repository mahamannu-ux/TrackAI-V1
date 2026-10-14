# Task15k-attesta-console Handoff — attestation card, verify panel, pack export, CORS

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15k-attesta-console` (base: `main` at `b76cf19`).

Commit/PR drawers show per-statement attestation; Administration → Attestation verifies the chain and exports signed evidence packs; CORS lets the browser send `Idempotency-Key`/`X-Request-ID`. No new API routes, migration or dependency.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 client, §2.2 card + drawer, §2.3 workspace, §2.4 CORS + test | ✅ |
| Quality | `npm test` 881 pass (baseline 879 + 2 new); typecheck, lint, `check` clean | ✅ |
| Integration | IT-T15k-01 browser walkthrough (blocking this merge) | ✅ founder run 2026-10-14 |
| Review | Full-diff re-read + cross-agent review (ready to push with 4 fixes, all applied in `a6c7daa`); post-review delta: 1-line dark color-scheme fix (`0f849cc`, gates green) + docs | ✅ |

## Implemented interfaces
```
AttestationCard({ repositoryId, sha })  // nothing when either is null; never "verified"
AttestaWorkspace({ repositories })      // Administration → Attestation (admin + auditor)
getAttestaSubject(repo, sha) → {statements} // verifyAttestaChain({fromSeq?, toSeq?})
requestEvidencePack(body, idempotencyKey) → 202 {id} // getEvidencePack(id) // downloadEvidencePack(path) → Blob
AttestaApiError { code, status, requestId } // message is the problem title only
CORS: allowed += Idempotency-Key, X-Request-ID; exposed: X-Request-ID, Content-Disposition, Retry-After
```

## Deviations from spec
1. `AdminPanel` takes the dashboard `repositories` list (both roles already load it) so auditors see the pack repository select; the alternative (`resources.repositories`) is null for auditors.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | A pack poll that fails, or runs past 10 minutes, shows "Status unavailable (code …). Refresh the page to check again." under the job and stops; re-export to retry | Cosmetic; server jobs unaffected |
| 🟡 | Proposed UX follow-ups (lead design needed, NOT in this branch): the export date picker accepts future dates the server will 400 — clamp `max` to now; verify From/To record numbers have no in-UI explanation of what a record is or how to find one — add affordances (show seq + short SHA in break rows, presets, or a record browser) | Follow-up session; branch stays as-reviewed for merge |

## Test coverage
`app-cors.test.ts` (2 tests, live `fetch` against `createApp`, no mocks): preflight on `/api/attesta/evidence-packs` allows the four headers; `GET /health` exposes `X-Request-ID`. The web app has no unit tests (§10); wording lives in `kindLabel`/`anchorBadge` (card) and `verifyVerdict`/`breakLabel` (workspace).

## Integration test impact
> Founder run 2026-10-14: all six checklist steps pass (card pending vs not-attested, merged/open PR, amber verify ×2 states, red unknown-key on pre-ceremony rows, admin + auditor Full export + download, F12 clean).

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15k-01 | Admin: commit with statement shows "Signed · anchoring pending/overdue", without shows "Not attested yet"; Attestation → Verify gives amber "anchors not checked"/"Not fully checkable"; Full pack exports and downloads; auditor repeats Verify + Export; no CORS error | Blocking: Task15k merge | ✅ founder run 2026-10-14 |

## Integration notes
- Verify `429` means one verify per tenant is already running; pack `409` cannot happen with fresh `crypto.randomUUID()` keys.
- `anchor_status` is a database fact; only `ok: true` in Verify is a cryptographic pass.
- Walkthrough data (disposable acceptance DB only, nothing in this branch): 2 commits ingested via the real `ingestMetricsBatch` path (`/tmp/t15k-walkthrough-seed.ts`, since deleted-data equivalent), statements first built with `--ephemeral-dev-key` (hence the honestly-red `KEY_UNKNOWN` on seq 0–1 — that key predates and never entered the key ceremony), then a throwaway local key ceremony (`attesta:keys` register/activate/publish + offline root sign/import, keys in `/tmp/t15k-keys`, never production) and 2 more statements signed by the published key (seq 2–3, the amber signatures-checked range).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| about 0.1× | about 0.2× | Build as estimated; over 1.25× because of unplanned founder walkthrough support (seed script, key ceremony, guide + rewrite). Next console prompt should budget ~0.1× for the walkthrough assist separately instead of folding it into the build estimate |
