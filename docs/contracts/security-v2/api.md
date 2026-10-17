# Security v2 machine API

> **[CONTRACT - FROZEN]** once merged. Task20d implements record ingestion;
> Task20f implements lease, bundle, and acknowledgement routes.

All routes are machine-authenticated under `/worker/security/v2`. The managed
machine credential is the only source of tenant and machine identity. No path,
query, or body field may select either identity.

Every response, including errors, has `Cache-Control: no-store` and echoes a
valid caller-supplied `X-Request-ID`; otherwise the server creates and returns a
new request ID. Errors use the closed RFC 7807 shape in
[`errors.md`](errors.md). Error bodies and logs contain codes and bounded
metadata only, never a submitted value.

## `POST /worker/security/v2/records`

The JSON request body validates against
[`security-upload-v2.schema.json`](security-upload-v2.schema.json). It contains
1–500 records and its serialized JSON size must not exceed 4,194,304 bytes.

A syntactically and structurally valid request returns `200` with one result in
request order for every input record:

```json
{
  "schema_version": "trackai.security-upload-result/2",
  "results": [
    {
      "record_id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "result": "accepted"
    },
    {
      "record_id": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "result": "rejected",
      "code": "SECURITY_V2_FIELD_NOT_PERMITTED"
    }
  ]
}
```

The result object is closed. `result` is `accepted`, `duplicate`, or `rejected`.
`code` is required only for `rejected` and must be one of the safe codes in
`errors.md`; it is forbidden for the other two results. A whole-request parse,
envelope-schema, authentication, lease, or size failure returns one RFC 7807
problem instead of partial results.

The server re-checks optional fields and indicator records against the tenant's
current data settings. It refuses rather than strips anything not permitted.
No valid, unexpired lease for this credential refuses the whole upload with
`SECURITY_V2_LEASE_REQUIRED`.

The upload needs a current valid lease for the credential. An
authorization-bearing record's `lease_id` may name any verified lease issued to
this machine, not only the current lease, and its activity time must be at or
after `issued_at` and before `expires_at`. In upload v2 this check
applies to a finding's `detected_at`; `security_status.lease_id` is health state,
not authorization. A future additive kind carrying lease provenance uses its
`timestamp` or `observed_at`, as applicable. A record outside its named lease's
machine or time window is rejected with `SECURITY_V2_LEASE_MISMATCH`.

If a record is rejected with `SECURITY_V2_FIELD_NOT_PERMITTED` because a data
setting was switched off after detection, the Endpoint projects it again under
the current settings and resubmits it with the same `record_id`. The rejected
record was not stored, so the resubmission is not a conflict.

### Idempotency and indicator upserts

The server idempotency key is `(tenant_id, machine_id, record_id)` for every
kind. Tenant and machine come from the credential and never enter `record_id` or
the request body.

- For every kind except `indicator`, identical replay is `duplicate`. Reusing
  an ID with different content is `rejected` with
  `SECURITY_V2_RECORD_CONFLICT`.
- An indicator ID represents Numbat's `(run_id,type,value)` tuple. A replay with
  a higher `count` or later `last_seen` is `accepted`. The stored count and
  window end become the component-wise maxima of the stored and submitted
  values, so a mixed update cannot regress either value. A submission whose
  count and last-seen time are both identical or older is `duplicate`. Changing
  `first_seen` or an identity field is `rejected` with
  `SECURITY_V2_RECORD_CONFLICT`.

These rules are machine-scoped: the same local source identifiers on two
machines cannot collide inside one tenant.

## `GET /worker/security/v2/lease`

Returns the current machine's stored DSSE activation-lease envelope as the exact
stored JSON bytes with `200 application/json`. The decoded payload validates
against
[`security-activation-lease-v2.schema.json`](security-activation-lease-v2.schema.json),
uses purpose `activation_lease`, and uses audience `platform`.

If this credential has no current lease, the route returns `404` with
`SECURITY_V2_LEASE_NOT_ISSUED`. A lease for any other machine is not eligible
and is never returned.

## `GET /worker/security/v2/bundles/{sha256}`

`{sha256}` is exactly 64 lowercase hexadecimal characters. Returns the tenant's
stored DSSE rule-bundle envelope as the exact stored JSON bytes with
`200 application/json`. The decoded payload validates against
[`security-rule-bundle-v1.schema.json`](security-rule-bundle-v1.schema.json),
uses purpose `policy_bundle`, and uses audience `platform`. Its SHA-256 over the
exact decoded payload bytes must equal `{sha256}`.

A missing digest, a digest owned by another tenant, and a malformed-but-safe
lookup all return the same `404` problem with `SECURITY_V2_NOT_FOUND`. The
response never reveals whether another tenant has the digest.

## `POST /worker/security/v2/acknowledgements`

The JSON body validates against
[`security-acknowledgement-v1.schema.json`](security-acknowledgement-v1.schema.json).
It reports that the Endpoint either applied or refused one verified lease and
bundle. An accepted acknowledgement returns `204` with no body.

The server binds the named lease to the credential-derived tenant and machine.
A missing lease, another tenant's lease, or another machine's lease returns the
same `404` problem with `SECURITY_V2_NOT_FOUND`. A refusal code is safe metadata;
there is no free-text refusal reason.

## Required isolation-negative cases

Task20d and Task20f copy the applicable numbered cases into route tests:

1. Company A's machine X uploads records; Company B cannot replay or inspect
   them, even with the same `record_id`.
2. Company A's machine X and machine Y may submit the same `record_id`; each has
   an independent idempotency row under its credential-derived machine.
3. Company A's machine X asks for its lease and never receives machine Y's
   lease. If X has none, the answer is `SECURITY_V2_LEASE_NOT_ISSUED`.
4. Company A's machine X requests Company B's bundle digest and receives the
   same `SECURITY_V2_NOT_FOUND` response as for a random missing digest.
5. Company A's machine X acknowledges Company A's machine Y lease and receives
   `SECURITY_V2_NOT_FOUND`; no acknowledgement is written.
6. Company A's machine X acknowledges Company B's lease and receives
   `SECURITY_V2_NOT_FOUND`; no acknowledgement is written.
7. A records or acknowledgement body containing `tenant_id`, `machine_id`, or
   an equivalent selector is rejected as an unknown field. Supplying headers,
   query parameters, or path text cannot override credential identity.
8. A credential whose lease is expired, rejected, unavailable, or absent cannot
   upload, even if its body names a valid lease or bundle value from another
   machine.

## Cache, redirects, and signed bytes

These routes never redirect and never return cacheable content. Lease and bundle
responses return the stored envelope bytes unchanged; consumers verify the
base64-decoded payload and its DSSE signature before parsing or applying it.
Record and acknowledgement requests never carry signing keys, machine secrets,
or tenant selectors.
