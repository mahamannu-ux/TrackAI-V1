# Task20f-security-settings-signing — handoff (part a of 2)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task20f-security-settings-signing` (base: `main` at `67af037`; merges `docs/Task20f-audit-events`). The founder split Task20f on 2026-10-17. **Part a** (this session): the pinned catalogue, the compiler, rule and data settings, the signed rule bundle, the admin API and CLI, and migration `0026` (all five tables and the fleet checks). **Part b** (the next session, same branch): leases, the three machine routes, the real `SecurityV2Authority`, fleet configuration v3, the `app.ts` parser fix, and the rest of IT-T20f-01. It does not build the console, Endpoint code, blocking or new keys.

## At a glance
| | Item | Status |
|---|---|---|
| Scope 1 | Audit contract PR `docs/Task20f-audit-events` (approved for Task16 by the founder, 2026-10-17) | ✅ three entries emitted here; `fleet.lease.*` and `policy.bundle.acknowledged` stay reserved until part b |
| Scope 2 | Catalogue at `20a5a52`: 51 files byte for byte, `manifest.json`, `NOTICE.md`, `security:catalogue-import` (refuses another commit) | ✅ |
| Scope 3–4 | Rule settings (default policy: 44 of 51 on) and data settings, versioned, append-only | ✅ |
| Scope 5 | Compiler: override only what differs, text edits of three scalars, header, identity override when nothing differs | ✅ |
| Scope 6 | Bundle: contract payload, RFC 8785, DSSE via `signVerified`, `policy_bundle` key, exact bytes stored, dry-run-first publish | ✅ (limit: 1 MiB signer cap, below) |
| Scope 7 | Agents `claude-code`, `codex`, `cursor`, `gemini-cli`, `copilot` (contract spelling) | ✅ |
| Scope 8–12 | Leases, machine routes, authority, `app.ts` fix, fleet v3 code | ⬜ part b (fleet checks already widened in `0026`) |
| Scope 13 | Migration `0026`: five tables, append-only triggers, RLS, composite tenant keys; fleet checks `(1, 2, 3)` | ✅ applied through `scripts/it-db.sh`; `drizzle-kit check` clean |
| Scope 14 | Admin API `GET`/`PUT /api/admin/security/settings` | ✅ |
| Quality | `npm test` 1,135 pass, 0 fail, 2 skipped; `npm run check` passes (typecheck, lint, drizzle check, web build) | ✅ |
| Integration | IT-T20f-01 part a: `verify:task20f-signing-live` passed once in the agent sandbox | 🟡 founder run; part b extends it |
| Review | Independent review subagent: 1 must-fix and 4 should-fix, all fixed. The fixes: the monitor switch moved off Task6.a's table; the dry run compiles and flags `exceeds_signer_limit`; the router enforces its own 256 KiB body limit; a bundle is tied to its rule-settings version by a check and a foreign key; the machine count goes through `withTenant()`. Codex cross-review after part b. | 🟡 |

## Implemented interfaces
```text
GET  /api/admin/security/settings   requireAdminAction('security_findings.read')   → trackai.security-settings-view/1
PUT  /api/admin/security/settings   requireAdminAction('security.settings.manage') body {dry_run, reason, monitor_mode?, rules?, data_settings?, agents?, day_one_scan?}
     → dry run: trackai.security-settings-plan/1 (rule_changes, publishes_bundle, next versions, active_machine_count)
     → apply:   trackai.security-settings-applied/1;  problems: SECURITY_SETTINGS_{UNAUTHENTICATED,FORBIDDEN,INVALID,CONFLICT,TOO_LARGE,SIGNING_UNAVAILABLE,UNAVAILABLE}
npm run security:settings -w apps/api -- --tenant <uuid> --operator <name> --change <file.json> [--confirm]
npm run security:catalogue-import -w apps/api -- <numbat checkout at 20a5a52bab41…>
features/security: readSecuritySettings, planSecuritySettings, applySecuritySettings, bundleEnvelopeByDigest (service.ts);
  compileRules (compiler.ts); signSecurityDocument, SECURITY_*_PAYLOAD_TYPE (signing.ts); securitySignerFromEnv (signing-env.ts)
DSSE payload types: application/vnd.trackai.security-rule-bundle+json, application/vnd.trackai.security-activation-lease+json
Dev keys: SECURITY_POLICY_BUNDLE_CREDENTIAL_ID + SECURITY_DEV_POLICY_BUNDLE_KEY_FILE; SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID + SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE
```

## Deviations from spec
1. **Stage-1 entries stayed reserved in the contract PR** and are flipped to emitted here, because an emitted entry must cite its emitting `file:line`. The stage-1 branch also changes `catalog.ts`, `audit-contract.test.ts` and `audit-api.test.ts` (a hard-coded catalogue version), because `catalog.md` is generated from them.
2. **Data settings are audited as `enabled_data_settings: string[]`**, because the raw-content key scan refuses `command_previews`.
3. **Shared files, founder-approved 2026-10-17:** `core/security/admin-authorization.ts` (`security.settings.manage`), `core/security/auditor-sweep.test.ts`, one `app.ts` mount line.
4. **The v2 monitor switch is NOT in Task6.a's `tenant_security_monitor_settings`** (this reverses checkpoint-2 question 3, which the founder had approved). The independent review found that Task6.a's activation endpoint and ingest read that row, so writing `monitor` there would also switch on the Task6.a OpenCode route, which AGENTS.md §9 item 11 forbids. The switch is now `monitor_mode` on Task20f's own versioned `security_data_settings_versions` row, and Task6.a's table is never written (the live verify checks this).
5. **`0026`'s snapshot absorbs Task20d's `0025` snapshot drift.** Task20d hand-edited 14 `security_findings` checks in the `0025` SQL but not in its snapshot, so `drizzle-kit generate` re-emitted them. I checked that each one is identical to what `0025` applied, removed those statements from `0026`, and kept the corrected snapshot.
6. **The catalogue is read from the source tree** (`dist/` → `src/features/security/catalogue`), because `tsc` copies no YAML.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | **Both Attesta signers cap a payload at 1 MiB** (`signer-kms.ts`, `signer-local-dev.ts`); the contract allows 4 MiB. The default bundle is about 179 KB, but overriding as few as 11 of the largest rules exceeds 1 MiB (every file is repeated in five folders). Publish then answers `413 SECURITY_SETTINGS_TOO_LARGE` and writes nothing. | The KMS adapter hashes locally, so the cap is the adapter's. Recommended: the Task15 owner raises both caps to cover 4 MiB plus the DSSE header (`features/attesta/**` is use-only here). |
| 🟡 | Lease and acknowledgement audit entries stay reserved | part b emits them |

## Test coverage
- **Catalogue:** manifest = files (51); one plain top-level line per key; a tampered copy refused; the import refuses a non-pinned commit.
- **Compiler:** golden bytes; default policy (7 files, 44 enabled, five identical folders, no `enforce`); identity override; incomplete settings; an uneditable file.
- **Signing:** payload validates against `security-rule-bundle-v1`; `verifyTrusted` (`policy_bundle`, `platform`, `production: true`) accepts against a test root. A tampered payload, the wrong purpose and the wrong key are rejected. The same for a lease document under `activation_lease`. Fail-closed signing: no key, production with an empty inventory, over the signer cap.
- **Admin:** guards and their actions; problems are closed, `no-store` and `X-Request-ID`; an invalid body is refused before the database; settings validation.
- **Mocked:** only the JWT layer in the live verify (an injected authorizer). The guards are covered by the auditor sweep.

## Integration test impact
> **FOUNDER:** IT-T20f-01 is blocking for the Task20f merge; part a is in, part b extends the same script. Prerequisites: `scripts/it-db.sh` (Docker or local PostgreSQL 16 + pgvector). Expected: nine `…=` summary lines, under a minute.

`IT_PG_DATABASES=trackai_task20f_signing_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20f_signing_live scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api` covers:
- defaults;
- a dry run that writes nothing;
- signing unavailable, which writes nothing;
- publish → `verifyTrusted`-verified exact stored bytes;
- a data-only change (no bundle);
- epochs 1 → 2 → 3, with a concurrent publish refused as stale;
- an oversize change flagged by the dry run and refused with `413`;
- Task6.a's activation row left untouched;
- append-only triggers;
- Company A/B;
- audit rows.

Agent-sandbox run: passed 2026-10-17 (🟡). IT-T20f-02 (production KMS keys) waits for Task15n (⬜).

## Effort
Estimate for the whole Task20f: about 0.45× T6 (split at checkpoint 2); part a estimate about 0.22×, actual about 0.25×. It ran over on three surprises: Task20d's snapshot drift, the 1 MiB signer cap and a hard-coded catalogue version in a Task16 test. **Next prompt:** start part b from this branch, and read this file's design note D4–D7 instead of re-deriving it.

## Design note (approved by the founder, 2026-10-17)

### D1. Tables (migration `0026`: all five tables and the fleet checks land in part a)
Every table: `tenant_id` column, unique `(tenant_id, id)`, composite tenant foreign keys, RLS enabled with no browser policies, reached only through `withTenant()`, and an append-only trigger (`SECURITY DEFINER`, fixed `search_path`; it blocks UPDATE, DELETE and TRUNCATE, as in 0019/0023). Company A/B tests for each.

| Table | Key columns | Notes |
|---|---|---|
| `security_rule_settings_versions` | `version` (unique per tenant, from 1), `rules jsonb` (all 51 ids → `{enabled, severity}`), `numbat_pin`, `created_by`, `reason` | Current = highest version. No row → the default policy (44 on, 7 off, upstream severities) as version 0, never stored. |
| `security_data_settings_versions` | `version`, the five booleans, `agents text[]`, `day_one_scan`, `monitor_mode`, `created_by`, `reason` | Everything a lease carries except the bundle. No row → all false, all five agents, no day-one scan, monitoring off (version 0). |
| `security_rule_bundles` | `bundle_version` (= the rule-settings version compiled; a check and a foreign key to the settings version enforce it), `epoch` (per-tenant counter, max+1 under a tenant advisory lock), `digest` (hex SHA-256 of the payload bytes), `envelope bytea` (the exact JSON bytes served), `issued_at`, `compiler_version` | Unique `(tenant_id, epoch)` and `(tenant_id, digest)`; check `epoch >= 1`, payload ≤ 4 MiB. Current = highest epoch. |
| `security_activation_leases` | `id` = `lease_id` (uuid), `machine_id` (FK `(tenant_id, machine_id)` → `developer_machines`), `issued_at`, `expires_at`, `mode`, `bundle_digest` (FK `(tenant_id, digest)` → bundles), `data_settings_version` (it also carries the monitor switch), `envelope bytea` | Unique `(tenant_id, machine_id, id)` for the acknowledgement FK. History kept forever (lease provenance for findings). |
| `security_acknowledgements` | `lease_id`, `machine_id` (FK `(tenant_id, machine_id, lease_id)` → leases), `bundle_digest`, `result`, `refusal_code`, `received_at` | Check: `refusal_code` null exactly when `applied`. |

The **monitor switch is `monitor_mode` on the lease-settings row**, never Task6.a's `tenant_security_monitor_settings`, because Task6.a's route reads that table (review fix, 2026-10-17). A mode change writes a new lease-settings version and `security.monitor.changed`.

### D2. Compiler (pure function, `features/security/compiler.ts`)
- Input: the pinned catalogue (`catalogue/20a5a52/…` + `manifest.json`), the effective rule settings and their version `n`, and the five agents.
- For each rule whose `enabled` or `severity` differs from upstream, it emits one file at the upstream `<group>/<file>.yaml` path: the upstream bytes, with
  - a new first line `# Modified by TrackAI (Task20f) from perplexityai/numbat@20a5a52 <path>; Apache-2.0`;
  - the top-level lines `enabled:`, `severity:` and `version:` replaced as text (`version: "<upstream>-trackai.<n>"`).
- A catalogue test asserts that each of the 51 files has exactly one top-level line of each. The compiler throws if a future pin breaks that. There is no YAML dependency, and `enforce` is never written.
- **Empty case (decision).** Numbat refuses an empty `--rules-dir` (`numbat@20a5a52:docs/rules.md:657-659`), and the contract requires at least one file per agent. If no rule differs from upstream, the compiler emits one *identity override*: the first rule by id, unchanged except for the header and the version tag. A same-id replacement replaces the rule as a whole, so behaviour is identical.
- Every agent folder (`claude-code`, `codex`, `cursor`, `gemini-cli`, `copilot`; these are the contract's `SecuritySourceAgent` spellings, so Copilot CLI is `copilot`) gets the same files. `enabled_rule_ids` is the effective enabled set, sorted. `compiler_version` is `task20f.1`.
- Output is checked against the bundle limits: each file ≤ 256 KiB, payload ≤ 4 MiB.

### D3. Bundle and lease signing
- Payload bytes are the RFC 8785 bytes (`attesta/canonical.ts`) of the contract payload. They are signed in a DSSE envelope (`attesta/dsse.ts` `signEnvelope`) through `signVerified` (signer contract), with keyid `sha256:<hex(SHA-256(SPKI DER))>`, exactly what `verifyTrusted` looks up.
- **Payload types (decision; the frozen contract names none):**
  - `application/vnd.trackai.security-rule-bundle+json` (purpose `policy_bundle`);
  - `application/vnd.trackai.security-activation-lease+json` (purpose `activation_lease`).

  Task20g must check these. `signedAt` is the payload's `issued_at`.
- Stored: the exact envelope bytes, served unchanged with `200 application/json`, plus the digest. Nothing is ever re-serialized to verify.
- **Key resolution** (`features/security/signing-env.ts`, the `anchor-env.ts` pattern):
  - **Production:** `platformSigner(store, adapters, 'policy_bundle' | 'activation_lease', trustConfigFromEnv())` from the trust inventory, re-resolved on every signature, so a rotation or revocation takes effect at once. No key → `SecuritySigningUnavailable`: publish stops with nothing written, and `GET /lease` answers `500 SECURITY_V2_INTERNAL` (never an unsigned or stale lease).
  - **Development:** `SECURITY_POLICY_BUNDLE_CREDENTIAL_ID` + `SECURITY_DEV_POLICY_BUNDLE_KEY_FILE` and `SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID` + `SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE` (LocalDevSigner, `dev:` ids, refused in production).
  - **Tests:** the dev signer and a test root document listing both keys, then `verifyTrusted` with `production: true`.
- The signature is made outside any database transaction (plan → sign → record, AGENTS.md §9 item 18).

### D4. Publishing and lease issuance
- **Publish** (`PUT /api/admin/security/settings` or `npm run security:settings -- … --confirm`):
  - **Dry run** returns or prints the changed rules (id, from → to), the new versions, and the number of active machines affected.
  - **Apply:** compile and sign first; then, in one transaction under the tenant lock:
    - insert the settings versions and the bundle;
    - write `security.settings.changed`, plus `policy.bundle.published` (when rules changed) and `security.monitor.changed` (when the mode changed).
  - A data-only change makes no new bundle.
  - Turning monitoring on with no bundle yet publishes the default bundle first, so "monitor on" always has a bundle.
- **`GET /lease`, lazy:**
  - The newest stored lease for this machine is returned unchanged when all of these hold:
    - it is under 1 hour old and not expired;
    - it names the current bundle digest;
    - it matches the current data-settings version (which includes the monitor mode).
  - Otherwise a new lease is signed, stored and returned, and `fleet.lease.issued` is written (actor `machine`).
  - Mode is the lease-settings row's `monitor_mode`. `expires_at` = issued + 72 h. An `off` lease carries `agents: []`.
  - A tenant with no bundle, or a machine that is not `active`, gets `404 SECURITY_V2_LEASE_NOT_ISSUED`.
- **`GET /bundles/{sha256}`:** a tenant-bound lookup. Malformed, missing and foreign digests all get the same `404 SECURITY_V2_NOT_FOUND`.
- **`POST /acknowledgements`:**
  - The lease must belong to this credential's tenant and machine, otherwise `404 SECURITY_V2_NOT_FOUND`.
  - `applied` must name the lease's own bundle digest (otherwise also 404). A refusal stores the digest the Endpoint reports.
  - The result is a `204` plus `policy.bundle.acknowledged` (target: the bundle row) or `fleet.lease.refused` (target: the machine).
  - Unknown fields, including `tenant_id` / `machine_id`, get `400 SECURITY_V2_UNKNOWN_FIELD`.
- **Routes:** in a sibling router, `features/security/lease.routes.ts`, mounted inside `createSecurityV2Router` through a new optional dependency, so it runs behind the same credential check, `no-store` and `X-Request-ID` middleware.

### D5. Authority (`features/security/authority.ts`, implements Task20d's `SecurityV2Authority`)
- `currentLease(t, m, now)`: the machine's **newest** lease, only if its mode is not `off` and `issued_at <= now < expires_at`. An older monitor lease never revives after an `off` lease.
- `leaseForMachine(t, m, id)`: any non-`off` lease ever issued to that machine (historical provenance).
- `currentDataSettings(t)`: the newest data-settings version, or null (all off).
- `security-findings.routes.ts` passes it to `createSecurityFindingsRouter({ v2Dependencies: { authority, leaseRoutes } })` in the production mount (dependency injection only).

### D6. Fleet configuration version 3
- **Creation:** an admin creates a v2 configuration as today. When the tenant's monitoring is on at creation, it is stored as `schema_version = 3`, with v2's release columns and v2's snapshot (`securityActivation` kept in the snapshot for the audit row).
- **Serving:** the v3 envelope's `securityLease` is resolved when the configuration is served, from the machine's current lease, issued lazily as `GET /lease` does.
  - A lease lives 72 h but a configuration lives weeks, so a reference frozen at creation would soon point at an expired lease.
  - The fleet configuration is not signed yet (`verification.state: unavailable`), so a per-fetch value changes nothing that was signed.
  - No lease can be issued → the route answers `409 state_conflict` (fleet's existing safe category).
- v1 and v2 rows serve exactly as today. The Endpoint treats their activation as `off` (contract).
- **Database checks:** `schema_version in (1, 2, 3)`; the release-contract check requires v2's release columns for 3 as well.

### D7. `app.ts` (item 11)
- The global parser becomes `app.use((req, res, next) => req.path.startsWith('/worker/security/v2') ? next() : jsonParser(req, res, next))`.
- The v2 router's credential check, 4 MiB guard and its own `express.json({ limit: '4mb' })` then run before any body is read.
- Test: an unauthenticated 4.5 MiB body is refused `403` before parsing; an authenticated body over 4 MiB gets `413`; other `/worker` routes keep the 5 MB parser.

### D8. Admin API
- **`GET /api/admin/security/settings`** returns the current rule settings (all 51, with upstream values beside them), data settings, monitor mode, the bundle (version, epoch, digest, issued_at) and the versions.
- **`PUT /api/admin/security/settings`** takes `{dry_run, reason, monitor_mode?, rules?: {id: {enabled?, severity?}}, data_settings?: {...}, agents?, day_one_scan?}` and returns the plan (dry run) or the new versions.
- Both follow AP-1 (RFC 7807, `X-Request-ID`) and send `no-store`. The PUT is audited (D4).
- Guard: `requireAdminAction('security_findings.read')` for GET (admins and auditors), and a new `security.settings.manage` (admins only) for PUT.
