# Audit contract, version 1

Written by Task16b (A16.3), 2026-10-15. Frozen once merged: **additive changes only**. Any other change needs a version 2 and a founder decision.

The contract has three parts:
- `event-v1.schema.json`: one audit row as the read API (Task16c) returns it.
- `catalog.md`: every action, **generated** from `apps/api/src/core/audit/catalog.ts` with `npm run audit:catalog -w apps/api`. Never edit it by hand: a unit test fails when it is out of date.
- One emitter, `recordAuditEvent()` (`apps/api/src/core/audit/`). It refuses any row the catalog does not describe.

Rows still live in `security_audit_events`. This contract adds no column and no migration.

## Names
- **Today's names are frozen.** All 47 actions written before this contract keep their exact `action` string and `details` key names, including the mixed separators (`repository.*` vs `repository_grant.*`) and mixed casing (`requestId` in `attesta.keys.*`, `request_id` elsewhere). Renaming is a breaking change, not a cosmetic one:
  - migration `0021`'s commit trigger looks up `action = 'attesta.anchor.resume'`, the batch id in `target_id` and `details->>'request_id'`;
  - the live verifiers and the Attesta console read these names too.
- A catalog entry may carry `aliases` (earlier names) for a future rename. v1 has none.
- **New actions** are named `<domain>.<object>.<past_verb>`: lower case, dot-separated, snake_case inside a segment (for example `fleet.lease.issued`). New details keys are snake_case.

## Actor vocabulary
`actor_type` is one of six values. Each catalog entry lists which ones its action allows.

| actor_type | Who | actor_id |
|---|---|---|
| `tenant_admin`, `tenant_auditor` | A person acting through an admin guard. The value comes from `req.adminRole` whenever a guard ran, never hardcoded. | Supabase subject |
| `tenant_user` | A signed-in person with no admin guard | Supabase subject |
| `system_operator` | A CLI or operator script | the operator token |
| `machine` | A developer machine on `/worker/*` | the machine id |
| `service` | An automated worker | the service name |

`machine` and `service` exist because the API must not assume a person is acting (B17), and for D6.1 activation leases.

Where an action's guard denies auditors (the auditor sweep proves it) and its catalog entry allows only `tenant_admin`, that is the only value `req.adminRole` can hold, so the service writes it directly.

## Severity
Severity is derived from the catalog, not stored.

| Severity | Meaning |
|---|---|
| `high` | Revocation, purge or deletion; raw-content reveal; a credential, key or membership change; a policy or activation change |
| `notice` | Any other change of state |
| `info` | Reads, verifications and exports |

`catalog_version` (an integer in `catalog.ts`) goes up when an entry is added or an alias is recorded. It never goes up for a change to what an existing row means, because that change is forbidden.

## Targets
Each entry declares a target id kind:

| Kind | `target_id` holds | Format check |
|---|---|---|
| `row` | the id of the row acted on | a UUID; if the entry gives a pattern, that pattern instead (Attesta keyids `sha256:<hex>`) |
| `tenant` | the tenant id, for a collection or tenant-scope event | must equal the row's tenant |
| `compound` | a documented format, for example `attesta.verify` `<from_seq>-<to_seq>` or `attesta.keys.publish` `<tenant>:<version>` | the entry's regular expression |

## Details
Every entry lists its details keys exactly as today's emitter writes them. Each key is required or optional and may be marked nullable. Its type is one of:
- `string` (at most 512 characters) or `reason` (operator free text, at most 1000);
- `integer`, `boolean`, `iso_timestamp` (RFC 3339 with a zone and a four-digit year), `uuid` (either letter case, because routes accept upper case and store it unchanged);
- `sha256_hex` (64 hex characters) or `sha256_digest` (`sha256:` followed by 64 hex characters);
- `string[]` or `uuid[]` (at most 200 items);
- `enum[...]`;
- a declared nested shape: an object of named keys, an array of such objects (`changes[]`), `counts` (an object of non-negative integers) or `string_map` (an object of strings).

The emitter checks every event:
- It refuses an unknown key, a missing required key, a wrong type or an oversize value. It also refuses a details object larger than 16 KB, which bounds what one row can carry. That cap is an addition beyond the original A16.3 list.
- `request_id` (AP-1 `X-Request-ID`) is an optional key on every action. Actions that already write `requestId` keep that name.
- **No raw content.** A unit test refuses any key name that suggests raw content: `prompt`, `response`, `content`, `payload`, `command`, `diff`, `code`, `source`, `secret`, `token`, `password`, `private_key`, `pem`, `plaintext`. It matches whole words inside the key, so `credentialFingerprint` passes and `tokenValue` fails. Four frozen v1 keys are listed as exceptions in the test, each with its reason (`contentSha256` is a digest; `failureCode`, `code` and `terminal_code` are error codes). A new key can never be added to that list.
- The emitter never logs a details value. Its error messages name only the action and the key.

## The emitter
- `buildAuditRow(tenantId, event)` is pure. It returns the validated row or throws `AuditContractError`, whose code is one of `AUDIT_UNKNOWN_ACTION`, `AUDIT_RESERVED_ACTION`, `AUDIT_ACTOR_NOT_ALLOWED`, `AUDIT_TARGET_INVALID` or `AUDIT_DETAILS_INVALID`.
- `recordAuditEvent(executor, tenantId, event)` inserts the row through the caller's Drizzle database or transaction, so the row is written inside the caller's transaction.
- **Fail closed.** A contract error throws before anything is written, so the caller's change rolls back with it: no audit, no change.
- A **reserved** action is refused until its owning Task changes its status to `emitted`. Until its first row exists, the owning Task may still change a reserved entry's shape; after that, only additive changes are allowed.

## What is not an audit event
- A signed Attesta statement: the ledger already records each one, one per commit.
- A successful anchor: it is recorded in Attesta's anchors table. A failed anchor is audited (`attesta.anchor.failed`, reserved).

## Audit reads are audited
Founder, 2026-10-15. Each query of the audit trail writes one `audit.events.read` event at `info` severity. The event holds the filter names, the limit and the returned count, never row contents. It is reserved here and emitted by Task16c.
