# Task15k-attesta-console Handoff — attestation card, verify panel, pack export, CORS

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15k-attesta-console` (base: `main` at `b76cf19`).

Commit/PR drawers show per-statement attestation; Administration → Attestation verifies the chain and exports signed evidence packs; CORS lets the browser send `Idempotency-Key`/`X-Request-ID`. No new API routes, migration or dependency.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 client, §2.2 card + drawer, §2.3 workspace, §2.4 CORS + test | ✅ |
| Quality | `npm test` 881 pass (baseline 879 + 2 new); typecheck, lint, `check` clean | ✅ |
| Integration | IT-T15k-01 browser walkthrough (blocking this merge) | ⬜ founder run |
| Review | Full-diff re-read: strings vs spec tables, no "verified" outside `ok`, no frozen paths | ✅ |

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
| ⬜ **FOUNDER:** run IT-T15k-01 below and paste back failures only | Blocking: this merge | A15.11 stays 🟡 until then |
| 🟡 | A pack poll that fails, or runs past 10 minutes, shows "Status unavailable (code …). Refresh the page to check again." under the job and stops; re-export to retry | Cosmetic; server jobs unaffected |

## Test coverage
`app-cors.test.ts` (2 tests, live `fetch` against `createApp`, no mocks): preflight on `/api/attesta/evidence-packs` allows the four headers; `GET /health` exposes `X-Request-ID`. The web app has no unit tests (§10); wording lives in `kindLabel`/`anchorBadge` (card) and `verifyVerdict`/`breakLabel` (workspace).

## Integration test impact
> **FOUNDER:** blocking this merge. Prerequisites: API + web running per `docs/TASK5_LOCAL_ACCEPTANCE_RUNBOOK.md`, anchoring env unset, an admin and an auditor login. Expected: card/verify/export behave as below, no browser CORS error.
> ```bash
> cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15k-01 | Admin: commit with statement shows "Signed · anchoring pending/overdue", without shows "Not attested yet"; Attestation → Verify gives amber "anchors not checked"/"Not fully checkable"; Full pack exports and downloads; auditor repeats Verify + Export; no CORS error | Blocking: Task15k merge | ⬜ founder run |

## Integration notes
- Verify `429` means one verify per tenant is already running; pack `409` cannot happen with fresh `crypto.randomUUID()` keys.
- `anchor_status` is a database fact; only `ok: true` in Verify is a cryptographic pass.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Notes |
|---|---|---|
| about 0.1× | about 0.1× | Four commits; one review round with no fixes; baseline web build needs the Supabase placeholders from `npm run check` |
