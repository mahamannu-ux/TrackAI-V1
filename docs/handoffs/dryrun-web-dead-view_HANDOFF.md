# dryrun-web-dead-view Handoff — Remove dead evidence view (B14)

> Status: ✅ done. (AGENTS.md §11)

Branch `task/dryrun-web-dead-view` (base: `main` at `1911626`).

Removes the unreachable legacy `'evidence'` dashboard view and placeholders per B14; live Evidence Workspace, API contracts and Task6 UI are untouched.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | B14 orphan `'evidence'` view gone, nothing sets it | ✅ |
| Scope | 4 deletions in `page.tsx` + unused imports only | ✅ |
| Quality | 152 unit tests pass; `npm run check` green | ✅ |
| Integration | none needed | n/a, non-blocking |
| Review | self-review as independent reviewer; cross-agent skipped per prompt | ✅ no findings |

## Implemented interfaces
None (deletion only).

## Founder-approved decisions
1. Removed `'evidence'` from `View`.
2. Deleted full `EvidenceExplorer` component.
3. Deleted `view === 'evidence'` render.
4. Deleted `Deferred raw analytics` placeholder in `DetailDrawer`.
5. Removed only the imports made unused (7 evidence API fns, 4 evidence types).

## Deviations from spec
None. `EvidenceWorkspace`, live views, layout, copy and API behavior unchanged.

## Known limitations
None. All Task6 strings asserted by `security-findings.test.ts` verified present in `page.tsx`.

## Test coverage
Existing 152-test API suite passes; typecheck (both apps), lint, Drizzle check and web build pass. No tests added (prompt forbids).

## Integration test impact
None needed (web-only deletion, no API or migration change).

## Integration notes
No consumer impact: the view was unreachable (no navigation entry ever set it).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.01× | about 0.01× | ~3 | ~15 min |
