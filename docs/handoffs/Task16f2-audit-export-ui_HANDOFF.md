# Handoff: Task16f2-audit-export-ui (verify/export UI, read-receipt toggle, offline verifier)

## At a glance
Audit view now has Trail / Tamper evidence and export / Attestation tabs; read receipts hidden by default; offline `audit:verify-export` CLI. `npm test` 991 pass; lint, typecheck, `npm run check` green.

## Implemented interfaces
- API: `GET /api/audit/events?exclude_action=` (repeatable ≤20, catalog values, cursor-bound, overlap refused) — `read-service.ts`.
- Web client (`lib/api.ts`): `excludeActions` in `AuditFilters`; `verifyAuditTrail`, `requestAuditExport`, `getAuditExport`, `downloadAuditExport`; `AuditVerifyReport`, `AuditExportJob`.
- `audit-workspace.tsx`: tabs in component state (Trail keeps its opening search; others request on action); "Show read receipts" toggle (off; part of applied filters; Reset clears); evidence section (Check → verdict line + counts + breaks table; Request export → 3s poll while tab open, 5-min cap, Download `audit-export-<id>.json`); Attestation tab renders `AttestaWorkspace`.
- `page.tsx`: Attestation section removed from Administration (type, nav, render); Audit gets `repositories`.
- Offline: `verifyAuditExport(download, options)` (`offline-export-verifier.ts`, export.md steps 1–7) → `{exit_code, checks, breaks, unsealed}`; CLI `npm run audit:verify-export` (`--export`, `--root-keyid`/`--customer-pin`, `--rekor-log-key`, `--tsa-anchors`, `--json`); codes/counts only. `offline-verifier.ts`: `export` on 5 anchor/trust helpers, no behaviour change.

## Deviations (one needs the lead)
- Breaks table shows the truncated seal digest, not the seal's window: `GET /verify` breaks carry `{kind, seal, row_id?}` — no window. QUESTION FOR THE LEAD: (a) accept digest display (identifies the seal exactly, full on hover); (b) add `window` to break objects (additive, small API change + contract note). Recommendation: (a) now, (b) only if auditors ask. I proceeded on (a) rather than stopping because no information is lost.
- `attesta:verify-pack`'s `--state`/`--rekor-log-index-offsets` not mirrored (no persisted trust / no sharded trees here).

## Known limitations
- Pending anchors → exit 2, never a break (export.md). Unsealed events reported only. The offline file cannot show a seal row removed with guards off (export.md Limit — pair with an evidence pack).
- `T15l bounds` timing test ("600 keys parse quickly") failed once under full-suite load, passes alone; unrelated (touches no trust code).

## Test coverage
- `audit-api.test.ts`: exclusion filters, cursor binding, overlap refused (+3).
- `offline-export-verifier.test.ts` (+13): in-memory export (test root/keyset/statement keys, FakeRekor+FakeTsa anchors): pass, unsealed reported, wrong payload type, changed manifest, section digest, rows_root, broken previous, statement swap, event changed/missing/added, pending → exit 2.

## Integration test impact
- IT-T16f2-01 (founder browser, blocking merge; ⬜): Task16f stack; run `npm run attesta:audit-seal -w apps/api -- --confirm` after audit events exist. (1) auditor: Trail hides read receipts until toggle; (2) Check green + "not sealed yet" count; (3) Request export → ready → Download saves file; (4) Attestation tab as before, Administration has no Attestation; (5) admin same; (6) developer no Audit view.
- IT-T16f2-02 (founder offline, blocking merge; ⬜): `npm run audit:verify-export -w apps/api -- --export audit-export-<id>.json --root-keyid <from attesta:keys>` → exit 0 (or 2 "anchors pending" if anchoring unconfigured locally); edited-copy → exit 1 `changed_row`.

## Integration notes
- No migration; no new routes; tenant isolation rides the existing guards (exclusion is one more condition after `tenant_id`). Export POST is auditor-allowed by design (Task16e). Poll reads job status only (no audit row).

## Effort
Estimate 0.08× T6, actual about 0.1× (at the 1.25× line). Cause: the anchor fixture needed two discoveries no prompt could give — FakeRekor stamps real-clock integratedTime (fixed past clocks fail the request window) and the trust root must name the dev signer key for Rekor windows. Next prompt: say fixtures use live fake clocks + signer-keyed roots.
