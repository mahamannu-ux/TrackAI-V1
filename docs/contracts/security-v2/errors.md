# Security v2 safe errors

> **[CONTRACT - FROZEN]** once merged. Codes are safe labels. They never include
> or echo a rejected value, tenant, machine, path, URL, command, rule content, or
> internal exception text.

HTTP errors use `application/problem+json` and this closed RFC 7807 shape:

```json
{
  "type": "https://trackai.dev/problems/SECURITY_V2_INVALID_BODY",
  "title": "Security request is invalid",
  "status": 400,
  "code": "SECURITY_V2_INVALID_BODY",
  "request_id": "safe-request-id"
}
```

`type` is exactly `https://trackai.dev/problems/{code}`. `title` is the fixed
text below, `status` is the route's HTTP status, and `request_id` is a bounded
opaque value also returned in `X-Request-ID`. There is no `detail`, rejected
value, validation path, or implementation message.

## API problem and record-result codes

| Code | HTTP status | Fixed title | Use |
|---|---:|---|---|
| `SECURITY_V2_INVALID_BODY` | 400 | Security request is invalid | Malformed JSON, missing required fields, invalid field values, or an invalid record. |
| `SECURITY_V2_UNSUPPORTED_SCHEMA` | 400 | Security schema is not supported | A document names a schema version this API does not accept. |
| `SECURITY_V2_UNKNOWN_FIELD` | 400 | Security request contains an unknown field | Any closed object contains a field outside its allowlist. |
| `SECURITY_V2_FIELD_NOT_PERMITTED` | 403 | Security field is not permitted | A record carries a field or indicator kind disabled by current tenant data settings. |
| `SECURITY_V2_LEASE_REQUIRED` | 403 | A valid security lease is required | Upload credential has no verified, unexpired, applicable lease. |
| `SECURITY_V2_LEASE_MISMATCH` | 403 | Security record does not match its lease | A record names a lease not issued to its machine, or its activity time is outside that lease's validity window. |
| `SECURITY_V2_PAYLOAD_TOO_LARGE` | 413 | Security payload is too large | Request body, decoded bundle, or decoded rule file exceeds its fixed limit. |
| `SECURITY_V2_RECORD_CONFLICT` | 409 | Security record conflicts with prior state | A write-once ID changes content or an indicator update is not monotonic. |
| `SECURITY_V2_NOT_FOUND` | 404 | Security resource was not found | Bundle/lease lookup is absent or belongs to another tenant or machine. |
| `SECURITY_V2_LEASE_NOT_ISSUED` | 404 | Security lease has not been issued | The authenticated machine has no current lease. |
| `SECURITY_V2_RATE_LIMITED` | 429 | Security request rate limit exceeded | Bounded retry is required; the response may include integer `Retry-After`. |
| `SECURITY_V2_INTERNAL` | 500 | Security service is unavailable | Unexpected server failure; internal details remain server-side. |

For a valid upload envelope, a record-level refusal uses the same code string in
the per-record `code` field without an HTTP problem body. Whole-request failures
use the HTTP status above. Another tenant or machine is never distinguished from
missing.

## Endpoint acknowledgement refusal codes

These codes are carried only in
`trackai.security-acknowledgement/1.refusal_code`. They describe why the
Endpoint refused to apply a lease or bundle; they are not server error details.

| Code | Meaning |
|---|---|
| `SIGNATURE_REJECTED` | The DSSE signature or trusted-key binding was rejected. |
| `VERIFICATION_UNAVAILABLE` | Trust material or verification was unavailable, so the Endpoint failed closed. |
| `LEASE_EXPIRED` | The lease was already expired when evaluated. |
| `MACHINE_MISMATCH` | The signed lease names a different machine. |
| `TENANT_MISMATCH` | The signed document names a different tenant. |
| `EPOCH_REGRESSION` | The verified bundle epoch is below the last applied epoch for the tenant. |
| `BUNDLE_DIGEST_MISMATCH` | The lease digest does not match the exact bundle payload bytes. |
| `RULES_CHECK_FAILED` | `numbat rules check` refused the staged rule files. |
| `UNSUPPORTED_SCHEMA` | The signed document's schema version is unsupported. |

This refusal-code enum may grow only additively. An acknowledgement never carries
a free-text reason, stack trace, signature bytes, rule contents, or rejected
value.
