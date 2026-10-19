# Task20i-b-security-console Handoff — Security screen

> Status: 🟡 implementation and automated gates pass; waiting on the founder browser walkthrough.

Branch `task/Task20i-b-security-console` (base: `main` at `d87b732`; merged `main` before handoff).

Task20i-b adds a top-level Security view to the dashboard for active tenant administrators and auditors. It reads the Task20i-a findings and coverage API and Task20f settings API. No API, contract, migration or dependency changed.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Findings filters, cursor paging, detail drawer, nearby labels, redacted indicator value, and Task6.a legacy phase | 🟡 implemented; browser walkthrough pending |
| Acceptance | Per-machine Coverage view, four health layers, honest literal states, expiry and refusal wording | 🟡 implemented; browser walkthrough pending |
| Acceptance | Settings view with upstream rule values, five data settings and warnings, monitor mode and bundle details | 🟡 implemented; rule titles are not returned by the settings API |
| Acceptance | Administrator draft → dry run → reason-required apply; auditors have no write controls | 🟡 implemented; browser walkthrough pending |
| Scope | Web-only, `apiFetch`, URL-persisted Security tab, active admin/auditor navigation guard | ✅ |
| Quality | Web build, API+web typecheck, lint and `npm test` (1,223 tests) pass | ✅ |
| Integration | No integration test added; founder browser walkthrough is non-blocking for this merge and closes T20.11 | ⬜ founder run |
| Review | Self-review of the full diff; Task20 lead cross-review pending | 🟡 |

## Implemented interfaces
```ts
// apps/web/src/lib/api.ts
getSecurityFindings(query): Promise<SecurityFindingPage>
getSecurityFinding(id): Promise<SecurityFindingDetail>
getSecurityCoverage(cursor?): Promise<SecurityCoveragePage>
getSecuritySettings(): Promise<SecuritySettingsView>
putSecuritySettings(change): Promise<SecuritySettingsPlan | SecuritySettingsApplied>

// apps/web/src/app/dashboard/security-workspace.tsx
SecurityWorkspace({ repositories, role }): JSX.Element
```

## Ported from
None. The prompt explicitly chose the in-repository Task19e patterns; no catalogued component was ported.

## Founder-approved decisions
1. Security tab state is stored as `?view=security&tab=findings|coverage|settings`, replacing history state like Task19e.
2. Free-text category, rule, agent and machine filters accept values beyond the first returned page; the API has no filter-facets endpoint.
3. Findings and coverage remain metadata-only; the detail drawer shows the API's nearby indicators and enforcement as nearby, not as linked to or caused by the selected finding.

## Deviations from spec
1. `GET /api/admin/security/settings` returns each rule's id, group, enabled state, severity and upstream values, but does not return a title. The table shows “Not returned by the settings API” rather than inventing titles; the API's `group` is shown as the category. Adding titles would require an API change and is outside this Web-only scope.
2. The Settings dry run requires a non-empty `reason` even though the UI asks for the reason only before Apply. The dry run sends the non-audited placeholder “Settings review”; Apply requires the administrator's reason.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Complete the browser walkthrough below using the Task20i-a synthetic seed or the founder's development setup | Non-blocking for the Task20i-b merge; required to close T20.11 |
| 🟡 | The settings response has no rule titles; the console labels this missing field instead of deriving titles from another source | Complete titles need a separately approved API response change |

## Test coverage
- `npm run typecheck`, `npm run lint`, and `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=task20-local-public-placeholder npm run build -w apps/web` pass.
- The post-merge `npm test` rerun passes all 1,223 tests. An earlier full run hit the inherited Attesta “600 keys parse quickly” timing assertion; `cd apps/api && node --import tsx --test src/features/attesta/trust-verify.test.ts` passes 19/19.
- The Web app has no unit-test harness. The founder walkthrough covers role-specific behavior, settings concurrency and live presentation.

## Integration test impact
No database integration test was added. `IT-T20i-01` belongs to Task20i-a and remains a separate API gate. The Security screen walkthrough is non-blocking for the Task20i-b merge but required to close T20.11. Prerequisite: synthetic findings/coverage rows from the Task20i-a verifier or the founder's development seed.

**FOUNDER:** In the running console, as an administrator: filter Findings, open a finding and check both nearby headings and the hidden URL/email label; open Coverage and confirm literal states and health-layer wording; in Settings, review a draft, apply it with a reason, then make a change in a second browser tab. Return to the first tab and apply its stale draft; confirm the client detects the changed settings versions, clears the review plan and shows “Someone else changed the settings; reload and review again” without sending the stale update. Reload, review and apply again. Sign in as an auditor and confirm Settings has no write controls.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| Browser walkthrough (T20.11) | Findings, Coverage, admin dry-run/apply and conflict handling, auditor read-only Settings | Non-blocking: Task20i-b merge; required: close T20.11 | ⬜ founder run |

The API live verifier and Task20i-a merge gate are unchanged. Task20j can use the console implementation; T20.11 remains open until the founder walkthrough.

## Integration notes
- Findings and Coverage route shapes are copied from `v2-read.ts`; settings types match `admin.routes.ts` and `service.ts`. Every request uses the shared `apiFetch`.
- Before applying, the client rereads settings and compares rule, data, monitor and bundle-epoch versions with the draft baseline. A stale draft is rejected locally; the server conflict response remains handled for a race after this check.
- The Security view is exposed only to active tenant administrators and auditors; server authorization remains authoritative.
- Build-time Supabase URL and key in the command above are local placeholder values, not credentials.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.15× | about 0.18× | one session | about 1 h | not shown |

The extra time came from splitting the workspace into focused components and isolating the inherited full-suite timing failure; no scope expansion was needed.
