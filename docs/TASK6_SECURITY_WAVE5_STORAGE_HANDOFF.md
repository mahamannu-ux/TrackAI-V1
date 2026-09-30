# Task6 Wave 5 storage handoff

Status: **Proposed; implementation not started**

Last updated: **2026-09-30**

## Why this handoff is needed

Wave 4 can safely create, queue and prepare authenticated delivery. TrackAI
must not acknowledge a finding until it can save it durably. The smallest safe
next step therefore begins the storage portion of S6.5 before a live upload
route is mounted.

## Proposed first storage slice

| Part | Customer-safe behavior |
|---|---|
| Tenant setting | One narrow value: `off` or `monitor`. Missing, expired or revoked means off. This is not Task5 consent and is not a Policy engine. |
| Finding table | Fixed metadata columns only. No command, prompt, path, URL, arguments, output, arbitrary JSON or secret values. |
| Identity | Tenant and machine come only from the managed Task4 credential. Repository comes from an active repository-wide machine grant. |
| Deduplication | Tenant plus delivery ID is unique. An exact replay returns the existing result; changed metadata with the same ID is rejected. |
| Transaction | Authorization check, deduplication and insertion succeed together or fail together. Only then may the server acknowledge delivery. |
| Isolation | Tenant-bound foreign keys and row-level security follow the existing Task4 pattern. Company A cannot address Company B rows. |

## Deliberately not in the first slice

- no customer UI;
- no finding search or ordinary-user read API;
- no raw evidence storage;
- no Task5 consent reuse;
- no dynamic rules, exceptions or inheritance; and
- no blocking or enforcement.

## Required tests before mounting the route

1. Safe insert and exact replay are idempotent.
2. Changed metadata with a reused delivery ID is rejected.
3. Off, missing, expired and revoked settings reject ingestion.
4. Revoked credentials and inactive repository grants reject ingestion.
5. Company A credentials cannot insert, read or reference Company B data.
6. Captured request, logs and database rows contain no raw customer content or
   reusable credentials.

The live `POST /worker/security/findings` route remains unmounted until these
tests and the schema migration checks pass.
