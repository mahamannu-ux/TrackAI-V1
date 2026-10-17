# Task20f-security-settings-signing — handoff

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task20f-security-settings-signing` (base `main` at `67af037`; merges `docs/Task20f-audit-events`). Split by the founder on 2026-10-17: **part a** built the pinned catalogue, compiler, settings, signed rule bundle, admin API and migration `0026`; **part b** built the signed per-machine lease, the three machine routes, the real `SecurityV2Authority`, fleet configuration v3 and the `app.ts` parser skip. No console, Endpoint code, blocking or new keys.

## At a glance
| | Item | Status |
|---|---|---|
| 1 | Audit contract PR `docs/Task20f-audit-events`; all six Task20f entries now emitted (`security.settings.changed`, `policy.bundle.published`, `security.monitor.changed`, `fleet.lease.issued`, `fleet.lease.refused`, `policy.bundle.acknowledged`) | ✅ |
| 2–7 | Catalogue at `20a5a52` (51 files, manifest, NOTICE, import script); rule and data settings (44 of 51 on by default); compiler; signed bundle; agents `claude-code`, `codex`, `cursor`, `gemini-cli`, `copilot` | ✅ |
| 8 | Lease `trackai.security-activation-lease/2`, 72 h, lazy, reused under 1 h, history kept, `fleet.lease.issued` | ✅ |
| 9 | `GET /lease`, `GET /bundles/{sha256}`, `POST /acknowledgements` (api.md cases 3–8) | ✅ |
| 10 | Real authority wired into the production mount; ingest accepts only under a current non-`off` lease | ✅ |
| 11 | `app.ts`: global parser skipped for `/worker/security/v2` (case-insensitive) | ✅ |
| 12–13 | Fleet configuration v3; migration `0026` (five tables, fleet checks `(1, 2, 3)`) | ✅ |
| 14 | Admin API `GET`/`PUT /api/admin/security/settings` | ✅ |
| Quality | `npm test` and `npm run check` pass (see Test coverage) | ✅ |
| Integration | IT-T20f-01 parts a and b passed in the agent sandbox; Task20d and Task9 live verifies rerun and pass | 🟡 founder run |
| Review | Independent review subagent: part a 1 must-fix + 4 should-fix, part b 1 must-fix + 4 should-fix, all fixed (Deviations 7–8); Codex cross-review next | 🟡 |

## Implemented interfaces
```text
Machine (managed credential; no-store; X-Request-ID; RFC 7807 problems from errors.md):
GET  /worker/security/v2/lease              200 exact stored DSSE bytes | 404 SECURITY_V2_LEASE_NOT_ISSUED (no bundle, machine not active) | 500 SECURITY_V2_INTERNAL (no key)
GET  /worker/security/v2/bundles/{sha256}   200 exact stored DSSE bytes | 404 SECURITY_V2_NOT_FOUND (malformed, missing, foreign: identical)
POST /worker/security/v2/acknowledgements   204 | 400 SECURITY_V2_{UNKNOWN_FIELD,UNSUPPORTED_SCHEMA,INVALID_BODY} | 404 SECURITY_V2_NOT_FOUND
Admin: GET/PUT /api/admin/security/settings (part a; trackai.security-settings-view/1, -plan/1, -applied/1)
features/security: currentOrIssueLease, recordLeaseAcknowledgement, parseAcknowledgement (lease.ts); pgSecurityLeaseStore (lease-store.ts);
  createSecurityV2Authority (authority.ts); createSecurityLeaseRouter (lease.routes.ts), injected as createSecurityV2Router({ leaseRoutes })
features/fleet: getFleetConfiguration(tenant, machine, resolveSecurityLease = resolveFleetSecurityLease); FleetConfigurationEnvelopeV3
Tables: security_rule_settings_versions, security_data_settings_versions (holds monitor_mode), security_rule_bundles,
  security_activation_leases, security_acknowledgements: all append-only, RLS, withTenant(), composite tenant keys
```

## What Task20g must verify on the Endpoint
- **Envelope:** DSSE, one signature, keyid `sha256:<hex SHA-256 of SPKI DER>`; verify with `verifyTrusted`, audience `platform`, before parsing. Payload types: bundle `application/vnd.trackai.security-rule-bundle+json` (purpose `policy_bundle`), lease `application/vnd.trackai.security-activation-lease+json` (purpose `activation_lease`); `signedAt` = the payload's `issued_at`.
- **Lease:** `tenant_id` and `machine_id` equal the enrolled identity (else `TENANT_MISMATCH` / `MACHINE_MISMATCH`); `issued_at <= now < expires_at` (else `LEASE_EXPIRED`); refresh hourly (the server reuses a lease under 1 h old for the same bundle and settings, so a refetch may return identical bytes); `mode: off` has `agents: []` and means monitoring off.
- **Bundle:** fetch `GET /bundles/{lease.bundle_digest}`; SHA-256 of the decoded payload bytes must equal the lease's `bundle_digest` (`BUNDLE_DIGEST_MISMATCH`); refuse an `epoch` below the last applied one (`EPOCH_REGRESSION`); check every file's `sha256`.
- **Acknowledge** each verified lease: `applied` names the lease's own digest (any other answers 404); a refusal may report the digest it refused.
- **Fleet v3:** `securityLease {leaseId, bundleDigest, expiresAt}` is resolved per fetch from the current lease; v1/v2 `securityActivation` is treated as `off`.

## What Task20i reads
`GET /api/admin/security/settings` (all 51 rules with upstream values, data settings, `monitor`, `bundle` {version, epoch, digest, issued_at}, versions) and the dry-run/apply `PUT`. Lease and acknowledgement history are in their tables; no admin read route is built for them yet.

## Deviations from spec
1. Stage-1 audit entries were reserved in the contract PR and flipped to emitted here (an emitted entry must cite its `file:line`).
2. Data settings are audited as `enabled_data_settings: string[]` (the raw-content key scan refuses `command_previews`).
3. Shared files, founder-approved 2026-10-17: `core/security/admin-authorization.ts`, `core/security/auditor-sweep.test.ts`, the admin mount line in `app.ts`.
4. **The v2 monitor switch is `security_data_settings_versions.monitor_mode`**, never Task6.a's table (part-a review fix; Task6.a's route reads that table).
5. `0026`'s snapshot absorbs Task20d's `0025` snapshot drift (checked statement by statement).
6. The catalogue is read from the source tree (`tsc` copies no YAML).
7. **Part b:** one line in `features/fleet/task9-fleet-live-verify.ts` (not pre-approved) narrows the envelope type for v3; behaviour unchanged. Fleet v3 with signing unavailable answers `503 fleet_unavailable` (a no-lease case answers `409 state_conflict` as D6 says). No new migration. The v2 router's error handler now maps a JSON parse failure to `400 SECURITY_V2_INVALID_BODY` (it answered `500`): after D7 its parser is the only one, so the fix belongs with the parser skip.
8. **Part b review fixes:** every 4xx body-parser error is `400 SECURITY_V2_INVALID_BODY`; a lease fetch that read the state before an `off` switch serves the newer stored lease instead of inserting a stale monitor lease; `currentLease` also returns null while the tenant's current switch is `off`, so ingest stops at once rather than at the Endpoint's next refresh (a tightening of D5); concurrency is tested in-memory and in IT-T20f-01.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Both Attesta signers cap a payload at 1 MiB (the contract allows 4 MiB); overriding about 11 of the largest rules exceeds it and publish answers `413` with nothing written | Task15 owner to raise the caps |
| 🟡 | Two concurrent first fetches for one machine can each sign; the insert re-checks under a per-machine lock and serves the stored lease, so one row is kept (a wasted signature) | none |

## Test coverage
- **Part a:** catalogue, compiler golden bytes, signing and `verifyTrusted`, admin guards and problems (see the previous handoff revision in git).
- **Part b (`lease.test.ts`, 10 tests):** contract-valid signed lease verified under `activation_lease` and rejected under `policy_bundle` or when tampered; reuse under 1 h; reissue after 1 h, a new bundle or new settings; history; `off` lease; no bundle and inactive machine; signing unavailable writes nothing; the acknowledgement parser; every api.md case 3–8 over HTTP through the real v2 router, lease router and authority; ingest accepted under a lease and refused when absent, expired, `off` or another machine's; audit rows checked by the real `buildAuditRow`.
- **`app-parser.test.ts`:** an unauthenticated 4.5 MiB v2 body is refused `403` before parsing (also with an upper-case path); over 4 MiB gets `413` with and without Content-Length; other routes keep the 5 MB parser.
- **`fleet.test.ts`:** v3 envelope validates against `fleet-configuration-v3.schema.json`; v3 needs its lease and release fields; v1/v2 unchanged.
- **Mocked:** storage in unit tests (in-memory store); the JWT layer in the live verify.

## Integration test impact
> **FOUNDER:** IT-T20f-01 is blocking for the Task20f merge. Prerequisites: `scripts/it-db.sh` (Docker or local PostgreSQL 16 + pgvector). Expected: fifteen `…=` summary lines, under a minute.

`IT_PG_DATABASES=trackai_task20f_signing_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20f_signing_live scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api` covers part a (settings, dry run, signing unavailable, publish, epochs, oversize, Task6.a untouched, append-only, A/B) and part b: real machine credentials over HTTP → signed lease verified and reused → bundle by digest → acknowledgement → an upload accepted through the real authority and storage → an expired lease (machine Y) and an `off` lease refused → cases 3–8 → fleet v3 created while monitoring, served with the current lease, database checks holding → append-only leases and acknowledgements → audit rows. Agent-sandbox run: passed 2026-10-17 (🟡). Also rerun here: `verify:task20d-ingest-live`, `verify:task9-fleet-live` (pass). IT-T20f-02 (production KMS keys) waits for Task15n (⬜).

## Effort
Whole Task20f: estimate about 0.30× T6, re-estimated 0.45× and split; actual about 0.45× (part a about 0.25×, part b about 0.20×). Part a ran over on Task20d's snapshot drift, the 1 MiB signer cap and a hard-coded catalogue version; part b ran to plan because the design note had settled D4–D7.

## Design note (approved by the founder, 2026-10-17; as built)
- **D1 Tables:** as in "Implemented interfaces"; current = highest version or epoch; no settings row means the defaults as version 0, never stored.
- **D2 Compiler:** an override only for a rule that differs from upstream: upstream bytes, a `# Modified by TrackAI (Task20f) …; Apache-2.0` first line, and the `enabled:`, `severity:`, `version: "<upstream>-trackai.<n>"` lines replaced as text; an identity override when nothing differs; all five agent folders identical; `compiler_version` `task20f.1`.
- **D3 Signing:** RFC 8785 payload bytes, DSSE through `signVerified`; production keys from the trust inventory per signature, dev keys from `SECURITY_*_CREDENTIAL_ID` + `SECURITY_DEV_*_KEY_FILE`; no key fails closed; never inside a transaction.
- **D4 Publish and lease:** publish is dry-run first, then compile and sign, then one transaction under the tenant lock; a lease is reused while under 1 h old, unexpired and matching the current bundle digest, data-settings version and mode, otherwise signed, stored and audited.
- **D5 Authority:** `currentLease` = the newest lease only while not `off`, in its window, and while the tenant's current switch is not `off`; `leaseForMachine` = any non-`off` lease of that machine; `currentDataSettings` = the newest row or null.
- **D6 Fleet v3:** a v2 configuration created while v2 monitoring is on is stored as version 3; `securityLease` is resolved per fetch; no lease → `409 state_conflict`.
- **D7 `app.ts`:** the global parser skips `/worker/security/v2`, so the v2 router authenticates and enforces 4 MiB before parsing.
- **D8 Admin API:** `security_findings.read` for GET, `security.settings.manage` for PUT; AP-1, `no-store`, audited.
