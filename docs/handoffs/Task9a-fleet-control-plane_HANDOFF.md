# Task9a-fleet-control-plane Handoff — Managed fleet control plane

> Status: 🟡 implementation and agent gates pass; founder IT-T9-01 and cross-agent review remain.

Branch `task/Task9a-fleet-control-plane` (base: `main` at `117a005`).

Task9a adds the smallest tenant-bound server desired/observed-state contract for later GitAI and fleet-console sessions. It does not add an MDM connector, campaign engine, frontend, signing implementation, secret store or Task6 Policy behavior.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | managed fetch/report, admin inventory/configuration/assignment/offboard | ✅ 10 focused tests |
| Scope | exactly two tables and one isolated `features/fleet/` directory | ✅ |
| Quality | 162 unit tests, typecheck, lint, Drizzle check, web build | ✅ |
| Integration | IT-T9-01 disposable PostgreSQL | 🟡 agent-verified; founder run is blocking for merge |
| Review | full diff re-read; machine grant scoping and state races fixed | ✅ independent · ⬜ cross-agent |

## Implemented interfaces
```text
GET  /worker/fleet/configuration
POST /worker/fleet/report
GET  /api/admin/fleet/machines
POST /api/admin/fleet/configurations
POST /api/admin/fleet/assignments
POST /api/admin/fleet/machines/:id/offboard/preview
POST /api/admin/fleet/machines/:id/offboard

fleet_configurations    immutable tenant epochs and metadata-only policy snapshots
fleet_machine_states    one desired/observed row per tenant and machine
```

Configuration responses use GitAI's existing `latest`, `next`, `enterprise-latest` and `enterprise-next` channels. Stored grant references are machine-bound; the worker receives only references for its authenticated machine. `verification` is always `{ required: true, state: 'unavailable' }` until Task15 supplies verification.

## Founder-approved decisions
1. Reused `machine.manage`, Task4 machine/grant/health/audit/revocation, Task6 `off|monitor`, and `withTenant()`.
2. Explicit machine assignment is the rollout record; reassigning an earlier immutable configuration is rollback.
3. MDM device/user facts remain opaque evidence and reconciliation remains `unavailable` until Task8.

## Deviations from spec
None. Shared edits are limited to the prompt-approved schema, generated migration, app mounts and API package scripts.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Task15 verification is unavailable | Task9c must fail closed when production verification is required |
| 🟡 | Local and MDM cleanup are reported separately as not requested/best effort | Server revocation is authoritative; offline cleanup is never claimed |
| 🟡 | Reconciliation is unavailable without Task8's custodian interface | MDM evidence cannot grant or infer identity |

## Test coverage
Ten focused tests cover closed/bounded reports, unknown fields, future timestamps, authenticated identity, 204/configuration fetch, fail-closed verification, tenant routing, auditor denial, rollback reassignment, preview/apply separation, safe errors, honest status states and schema shape. Routes run through a real Express app in-process without opening a port. IT-T9-01 uses real PostgreSQL with no mocks and acknowledges both an advance and an older rollback epoch.

## Integration test impact
> **FOUNDER:** Blocking for Task9a merge and later TrackAI fleet contract changes. Prerequisites: Docker or local PostgreSQL 16 + pgvector. Expected: `it_t9_01=passed`, about one minute.
> ```bash
> scripts/it-db.sh npm run verify:task9-fleet-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T9-01 | migration apply/rollback/reapply, RLS, tenant FKs/epochs, fetch/report, A/B negatives, rollback, revoke, immutable audit, privacy | Blocking: Task9a | 🟡 agent-verified · ⬜ founder run |

Task9c and Task9e may build after this interface merges; production verification and UI/endpoint behavior remain later-session gates.

## Integration notes
- Task9c consumes the exact worker envelope and must retain last-known-good when verification is unavailable or rejected.
- Task9e should render `current`, `stale`, `unreported`, `unavailable`, `mismatch` and `revoked` without converting missing values to zero.
- No SushiCorp component was ported; SushiCorp has no endpoint-fleet component.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---|---|---|
| about 0.24× | about 0.24× | one Codex session | about 1 hour | unavailable |
