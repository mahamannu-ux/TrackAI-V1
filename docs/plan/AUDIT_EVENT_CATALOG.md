# Audit event catalog

Inventory for Task16 A16.1, written 2026-10-14 from the code on `task/Task16a-audit-inventory`.
Every row is an `action` value written to `security_audit_events`
(`apps/api/src/core/db/schema.ts:573`) in production code. Live-verify and test scripts
are listed separately; nothing here is fixed, only recorded (A16.3/A16.5 decide).

Conventions: `actorType`/`targetType` are free-text columns (no enum in the schema).
`details` lists key names only, never values. "Raw?" is whether raw customer content
(prompts, responses, tool payloads, file bytes, private keys) could ever reach `details`.

## 1. Events written today (40 distinct actions, 33 insert sites)

| Action | Source | Emitting file:line (every call site) | actorType | targetType | details keys | Triggered by | Raw? |
|---|---|---|---|---|---|---|---|
| `repository.enrolled` / `repository.reenrolled` | Task4 | `core/security/repository-security-service.ts:115` (`enrollRepository`) | `tenant_admin` | `repository_enrollment` | repositoryId, effectiveFrom, generationSessionEvidenceFrom, commitNoteEvidenceFrom, effectiveUntil, reason | `POST /api/admin/repository-enrollments` | no |
| `repository_backfill.authorized` | Task4 | `core/security/repository-security-service.ts:184` (`authorizeRepositoryBackfill`) | `tenant_admin` | `repository_backfill_authorization` | enrollmentId, evidenceFamily, occurredFrom, occurredUntil, expiresAt, reason | `POST /api/admin/backfill-authorizations` | no |
| `repository_grant.issued` | Task4 | `core/security/repository-security-service.ts:251` (`grantMachineRepository`) | `tenant_admin` | `machine_repository_grant` | machineId, enrollmentId, branchPatterns, effectiveFrom, effectiveUntil, reason | `POST /api/admin/repository-grants` | no |
| `repository_grant.branch_scope_replaced` | Task4 | `core/security/repository-security-service.ts:314` (`replaceMachineRepositoryGrantBranchScope`) | `tenant_admin` | `machine_repository_grant` | previousGrantId, machineId, enrollmentId, previousBranchPatterns, branchPatterns, reason | `POST /api/admin/repository-grants/:id/branch-scope` | no |
| `repository_grant.revoked` | Task4 | `core/security/repository-security-service.ts:350` (`revokeMachineRepositoryGrant`) | `tenant_admin` | `machine_repository_grant` | machineId, reason | `POST /api/admin/repository-grants/:id/revoke` | no |
| `repository_backfill.revoked` | Task4 | `core/security/repository-security-service.ts:383` (`revokeRepositoryBackfillAuthorization`) | `tenant_admin` | `repository_backfill_authorization` | enrollmentId, evidenceFamily, reason | `POST /api/admin/backfill-authorizations/:id/revoke` | no |
| `repository.revoked` | Task4 | `core/security/repository-security-service.ts:429` (`revokeRepositoryEnrollment`) | `tenant_admin` | `repository_enrollment` | repositoryId, reason, grantsRevoked, backfillAuthorizationsRevoked | `POST /api/admin/repository-enrollments/:id/revoke` | no |
| `github_app.installation_created` | Task4 | `core/security/github-app-security-service.ts:114` (`createGitHubAppInstallation`) | `tenant_admin` | `github_app_installation` | providerHost, appId, installationExternalId, accountLogin, credentialId, credentialFingerprint, permissions, subscribedEvents | `POST /api/admin/github-app/installations` | no |
| `github_app.credential_rotated` | Task4 | `core/security/github-app-security-service.ts:192` (`rotateGitHubAppCredential`) | `tenant_admin` | `github_app_credential` | installationId, rotatedFromCredentialId, overlapUntil, credentialFingerprint | `POST /api/admin/github-app/installations/:id/credentials/rotate` | no |
| `github_app.rotation_finished` | Task4 | `core/security/github-app-security-service.ts:227` (`finishGitHubAppCredentialRotation`) | `tenant_admin` | `github_app_installation` | retiredCredentialIds, reason | `POST /api/admin/github-app/installations/:id/credentials/finish` | no |
| `github_app.installation_revoked` | Task4 | `core/security/github-app-security-service.ts:263` (`revokeGitHubAppInstallation`) | `tenant_admin` | `github_app_installation` | credentialsRevoked, reason | `POST /api/admin/github-app/installations/:id/revoke` | no |
| `machine.registered` | Task4 | `core/security/machine-security-service.ts:74` (`registerDeveloperMachine`) | `tenant_admin` | `developer_machine` | installationId, displayName | `POST /api/admin/machines` | no |
| `machine_credential.issued` / `machine_credential.rotated` | Task4 | `core/security/machine-security-service.ts:117` (`issueMachineCredential`) | `tenant_admin` | `machine_credential` | machineId, keyId, rotatedFromCredentialId, expiresAt | `POST /api/admin/machines/:id/credentials` | no |
| `machine_credential.revoked` | Task4 | `core/security/machine-security-service.ts:158` (`revokeMachineCredential`) | `tenant_admin` | `machine_credential` | machineId, keyId, reason | `POST /api/admin/machine-credentials/:id/revoke` | no |
| `machine.revoked` | Task4 | `core/security/machine-security-service.ts:199` (`revokeDeveloperMachine`) | `tenant_admin` | `developer_machine` | reason, credentialsRevoked, repositoryGrantsRevoked | `POST /api/admin/machines/:id/revoke` | no |
| `admin_membership.granted` / `admin_membership.reactivated` | Task4 | `core/security/admin-security-service.ts:73` (`grantAdminMembership`) | `system_operator` (only caller) | `tenant_admin_membership` | role, subject | CLI `bootstrap:task4-wave4-admin` (`features/admin/task4-wave4-admin-bootstrap.ts:68`); no HTTP route grants memberships | no |
| `admin_membership.revoked` | Task4 | `core/security/admin-security-service.ts:107` (`revokeAdminMembership`, no callers — see Observations); `features/admin/task4-wave4-admin-placeholder-repair.ts:54` (`main`) | `tenant_admin` (service) / `system_operator` (repair CLI, actorId `task4-placeholder-repair`) | `tenant_admin_membership` | subject, role, reason (service); reason, correctiveOverlay (repair CLI) | no route today; repair CLI only | no |
| `retention_policy.created` / `retention_policy.replaced` | Task4 | `core/operations/retention-policy-service.ts:101` (`replaceTenantRetentionPolicy` via `nextVersion`) | `tenant_admin` | `tenant_retention_policy` | previousPolicyId, version, mode, retentionDays, reason | `POST /api/admin/operations/retention-policy` | no |
| `evidence_export.completed` | Task4 | `core/operations/evidence-export-service.ts:367` (`createTenantEvidenceExport`) | `tenant_admin` | `evidence_export_job` | archivePurpose, scopeFrom, scopeUntil, recordCounts, contentSha256, bytes, reason | `POST /api/admin/operations/exports` | no |
| `evidence_export.failed` | Task4 | `core/operations/evidence-export-service.ts:399` (`createTenantEvidenceExport` failure path) | `tenant_admin` | `evidence_export_job` | failureCode, reason | `POST /api/admin/operations/exports` (failed attempt) | no |
| `evidence.collection.enabled` / `evidence.collection.disabled` | Task5 | `features/evidence/service.ts:186` (`setEvidenceConsent`) | `tenant_admin` | `tenant_evidence_settings` | provider, retentionDays | `PUT /api/admin/evidence/settings` | no |
| `evidence.raw.read` | Task5 | `features/evidence/service.ts:386` (`readRawEvidence`) | `tenant_user` (the only non-admin actorType in production) | `evidence_event` | provider, eventType | `GET /api/evidence/events/:id/raw` (on the evidence read router, guarded by `evidence.raw.read`) | no |
| `evidence.intention.corrected` | Task5 | `features/evidence/service.ts:459` (`correctIntention`) | `tenant_admin` | `evidence_intention` | correctedFromIntentionId, reason | `POST /api/admin/evidence/intentions/:id/corrections` | no |
| `evidence.retention.purged` | Task5 | `features/evidence/service.ts:497` (`purgeExpiredEvidence`) | `tenant_admin` | `tenant` | expiredEvents, expiredIntentions, expiredSummaries, expiredSemanticIndexes | `POST /api/admin/evidence/purge-expired` | no |
| `evidence.semantic.reindex_enqueued` | Task5 | `features/evidence/service.ts:1159` (`enqueueSemanticReindex`) | `tenant_admin` | `tenant` | model, modelRevision, enqueued | `POST /api/admin/evidence/semantic-reindex` | no |
| `security_findings.read` | Task6.a | `features/security-findings/admin-read.ts:73` (`databaseStore.readAndAudit`) | `tenant_admin` or `tenant_auditor` (from `req.adminRole`, set by `requireAdminAction`) | `security_findings` (targetId is the tenant id — see Observations) | limit, returned | `GET /api/admin/security-findings` | no |
| `telemetry_normalization.reconciled` | Task4 | `features/operations/task4-wave5-pending-reconcile.ts:27` (`main`) | `system_operator` (actorId `task4-wave5-pending-reconciler`) | `tenant_evidence` | selected, normalized, failed, eventKinds | CLI `reconcile:task4-wave5-pending` (dry-run first) | no |
| `fleet_configuration.created` | Task9 | `features/fleet/service.ts:264` (`createFleetConfiguration`) | `tenant_admin` | `fleet_configuration` | epoch, schemaVersion, targetClientVersion or clientCompatibility/desiredRelease, channel, ring, reason, repositoryPolicyCount, securityActivation | `POST /api/admin/fleet/configurations` | no |
| `fleet_configuration.assigned` | Task9 | `features/fleet/service.ts:316` (`assignFleetConfiguration`) | `tenant_admin` | `fleet_configuration` | epoch, machineIds, reason | `POST /api/admin/fleet/assignments` | no |
| `fleet_machine.offboarded` | Task9 | `features/fleet/service.ts:463` (`applyFleetOffboard`) | `tenant_admin` | `developer_machine` | reason, desiredConfigurationId, activeCredentialCount, activeGrantCount, serverRevocation, localCleanup, mdmCleanup | `POST /api/admin/fleet/machines/:id/offboard` | no |
| `attesta.verify` | Task15 | `features/attesta/read-service.ts:407` (`pgReadStore.verify` audit hook) | `tenant_admin` or `tenant_auditor` (from `req.adminRole`) | `attesta_chain` (targetId is a `fromSeq-toSeq` range, not a row id — see Observations) | request_id, ok, checked, break_count, failed (only when failed) | `GET /api/attesta/verify` | no |
| `attesta.export.request` | Task15 | `features/attesta/evidence-pack-service.ts:793` (pack-store audit hook) | `tenant_admin` or `tenant_auditor` (from `req.adminRole`) | `attesta_evidence_pack` | request_id, scope, mode, replayed (request); request_id, scope, mode, pack_digest, counts (download route call at `attesta.routes.ts:267` reuses the download details shape) | `POST /api/attesta/evidence-packs` (request and idempotent replay) | no |
| `attesta.export.download` | Task15 | `features/attesta/evidence-pack-service.ts:793` (same hook, via `attesta.routes.ts:267`) | `tenant_admin` or `tenant_auditor` | `attesta_evidence_pack` | request_id, scope, mode, pack_digest, counts | `GET /api/attesta/evidence-packs/:id/content` | no |
| `attesta.report.request` | Task15 | `features/attesta/period-report-service.ts:511` (report-store audit hook, via `attesta.routes.ts:297`) | `tenant_admin` or `tenant_auditor` | `attesta_period_report` | request_id, scope, replayed | `POST /api/attesta/period-reports` (request and idempotent replay) | no |
| `attesta.report.download` | Task15 | `features/attesta/period-report-service.ts:511` (same hook, via `attesta.routes.ts:341`) | `tenant_admin` or `tenant_auditor` | `attesta_period_report` | request_id, scope, report_digest, statement_digest | `GET /api/attesta/period-reports/:id/document` | no |

Raw-content check: no production call site puts raw prompts, responses, tool payloads,
file bytes or private keys into `details`. The closest calls are safe by construction:
credential issue/rotation store only `keyId`/`credentialFingerprint` (the plaintext is
returned in the response, never in `details`); `github_app.installation_created` stores
metadata but not the private key; `evidence.raw.read` stores only provider/eventType
(the content is returned in the response body); export completion stores digests and
counts, never records. One doubt is flagged in Observations (audit reads themselves).

## 2. Test and operator scripts (not production events)

Scripts that write audit rows on throwaway/ephemeral databases, or read them to assert.
They must not be mistaken for product emitters.

| Script | Writes or reads | Actions touched |
|---|---|---|
| `bootstrap:task4-wave4-admin` (`features/admin/task4-wave4-admin-bootstrap.ts:68`) | writes | `admin_membership.granted` / `admin_membership.reactivated` |
| `repair:task4-wave4-admin-placeholder` (`features/admin/task4-wave4-admin-placeholder-repair.ts:54`) | writes | `admin_membership.revoked` |
| `reconcile:task4-wave5-pending` (`features/operations/task4-wave5-pending-reconcile.ts:27`) | writes (apply mode; dry-run first) | `telemetry_normalization.reconciled` |
| `verify:task4-wave5-export-live` (calls `createTenantEvidenceExport`) | writes | `evidence_export.completed` / `evidence_export.failed` |
| `verify:task5-*-live` corpus/graph/opencode/analytics/semantic/retention (call `setEvidenceConsent`, `correctIntention`, `purgeExpiredEvidence`, `readRawEvidence`) | write | `evidence.collection.enabled/disabled`, `evidence.intention.corrected`, `evidence.retention.purged`, `evidence.raw.read` |
| `verify:task9-fleet-live` (calls fleet service) | writes | `fleet_configuration.created` / `fleet_configuration.assigned`, `fleet_machine.offboarded` |
| `verify:task4-machine-lifecycle-live` (`core/security/task4-machine-lifecycle-live-verify.ts:183`), `verify:task4-wave4-admin-lifecycle-live` (`features/admin/task4-wave4-admin-lifecycle-live-verify.ts:522`), `verify:task4-wave4-github-live` (`features/admin/task4-wave4-github-live-verify.ts:100`), `verify:task5-opencode-live` (`features/evidence/task5-opencode-live-verify.ts:219`), `verify:task5-retention-live` (`features/evidence/task5-retention-live-verify.ts:183`), `verify:task9-fleet-live` (`features/fleet/task9-fleet-live-verify.ts:295`) | read-only assertions | machine, membership, github_app, evidence, fleet actions |

## 3. Planned events (no code yet, from TASK16.md A16.11)

| Planned event | Status today |
|---|---|
| Attesta key create / rotate / revoke | missing; no key-lifecycle audit writes exist |
| Attesta statement signed | missing |
| Attesta anchor succeeded / failed | missing |
| Attesta verification run | exists as `attesta.verify` (Task15, §1) |
| Evidence pack exported | exists as the `attesta.export.request` / `attesta.export.download` pair (Task15, §1); no single `exported` event |
| D6.1 activation lease issued / refused | missing |
| Task6.b bundle published / activated / acknowledged | missing |
| T14.7 artifact signed | missing |

## 4. Observations (not fixed; for A16.3/A16.5)

1. `features/evidence/service.ts:386` — `evidence.raw.read` is the only production event with `actorType: 'tenant_user'`; every other service hardcodes `tenant_admin` (or takes the role from the request). A16.3 should decide the actor vocabulary.
2. `features/security-findings/admin-read.ts:73` — `security_findings.read` targets `security_findings` with targetId set to the tenant id; it names a collection, not a row. A16.3 should decide whether collection reads take the tenant as target.
3. `features/attesta/read-service.ts:407` — `attesta.verify` targets `attesta_chain` with a `fromSeq-toSeq` range string as targetId, not a row id. Same vocabulary question as (2).
4. `core/security/admin-security-service.ts:107` — `revokeAdminMembership` writes `admin_membership.revoked` but has no callers anywhere in `apps/api/src`; the only revocation event written comes from the repair CLI (`task4-wave4-admin-placeholder-repair.ts:54`). Either the service is dead code or the revocation path it was built for was never wired.
5. `features/admin/admin.routes.ts:116` — `GET /api/admin/context` has no `requireAdminAction` guard (it reports only the caller's own identity/membership). It is the only route on either admin router without one; the sweep test pins it in an explicit unguarded set.
6. `features/admin/admin.routes.ts:274` — `GET /api/admin/operations/exports/:id/download` is a GET guarded by the `export.manage` action, so auditors are denied a read-shaped route. Deliberate (it streams the operator archive), but the auditor export path (A16.7) must cover it.
7. Reads that are never audited: `GET /api/admin/audit` (`admin-resource-service.ts:107` reads but never writes — auditor reads of the audit trail itself leave no trace), export plan/list/download reads (`evidence-export-service.ts:62/123/142`), retention plan (`retention-run-service`), monitoring (`operational-monitoring-service`), and consent/settings/semantic-health reads. A16.3 should decide whether audit reads are themselves audited.
8. `evidenceWorkerRouter.post('/opencode/batches')` (`evidence.routes.ts:37`, machine-authenticated `/worker/evidence`) writes no audit event — presumably deliberate at ingestion volume, but it is the only mutating evidence entry point without one.
9. Naming is inconsistent: `repository.*` vs `repository_grant.*` vs `repository_backfill.*` (dot vs underscore separators), `machine_credential.*` vs `machine.*`, `evidence.collection.*` vs `evidence.retention.purged` vs `evidence_export.*`. A16.3 owns the v1 naming decision.
10. Missing actor/target gaps: `purgeExpiredEvidence` (`service.ts:497`) and `enqueueSemanticReindex` (`service.ts:1159`) target the bare `tenant` with counts-only details — fine for scope, but there is no per-record linkage for purged evidence.
11. `admin_membership.granted`/`reactivated` details (`admin-security-service.ts:80`) store the subject (a Supabase UUID) in cleartext alongside the role; consistent with the membership row itself, but A16.3 should confirm subject handling under the no-raw-content rule.
