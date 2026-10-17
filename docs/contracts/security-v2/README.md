# TrackAI security v2 contract

> **[CONTRACT - FROZEN]** once merged. Task20a defines wire shapes only. It does
> not implement ingestion, storage, migrations, signing, HTTP routes, or Endpoint
> behavior.

This directory is the shared boundary between the TrackAI API and the TrackAI
Endpoint for Numbat-backed coding-agent security. The accepted Numbat record
schema range is exactly `0.5.0`. The source is
`perplexityai/numbat@20a5a52` (Apache-2.0). TrackAI runs that source unchanged
and projects only the fields named here.

## Versioning rule

The strings before the slash name a document; the integer after the slash is
its major version. A compatible addition may be published only as an additive
minor revision of the documentation and schemas: existing valid documents must
remain valid and retain their meaning. A removed field, a newly required field,
a narrowed enum or bound, or a changed meaning requires a new major-version
schema beside this one. Existing major versions remain readable.

All JSON objects are closed (`additionalProperties: false`). Strings and arrays
are bounded. Integers are non-negative safe JSON integers unless a field says
otherwise. Timestamps are real RFC 3339 UTC instants in canonical uppercase-`Z`
form. Digests are 64 lowercase hexadecimal SHA-256 characters, without a
`sha256:` prefix. IDs are opaque and never contain raw customer content.

## Documents and fixed constants

| Document | Schema version | Purpose |
|---|---|---|
| Upload | `trackai.security-upload/2` | One machine-authenticated batch containing any mix of the seven record kinds. |
| Data settings | `trackai.security-data-settings/1` | Five tenant switches controlling which optional values may leave a machine. |
| Rule-bundle payload | `trackai.security-rule-bundle/1` | One tenant's compiled Numbat files and enabled rule IDs. |
| Activation-lease payload | `trackai.security-activation-lease/2` | One machine's short-lived activation, bundle binding, agents, and data settings. |
| Fleet configuration | numeric schema version `3` | Task9 configuration v2 with `securityActivation` replaced by `securityLease`. |
| Lease acknowledgement | `trackai.security-acknowledgement/1` | The machine's applied or refused result for one lease and bundle. |

| Constant | Value |
|---|---:|
| Maximum upload records | 500 |
| Maximum upload request body | 4 MiB (4,194,304 bytes) |
| Maximum decoded rule file | 256 KiB (262,144 bytes) |
| Maximum decoded rule-bundle payload | 4 MiB (4,194,304 bytes) |
| Default activation-lease validity | 72 hours |
| Normal activation-lease refresh | hourly |
| Maximum redacted preview | 200 Unicode code points |
| Accepted Numbat schema | exactly `0.5.0` |

The upload limit applies to the serialized JSON body and, for signed documents,
the bundle limit applies to the decoded DSSE payload bytes. JSON Schema bounds
the representable fields; the receiving implementation must enforce the request
and decoded-byte limits.

## Common upload rules

An upload is `{schema_version, records}`. It never carries a tenant ID or machine
ID. Machine authentication supplies both. Every record is a closed object with
`kind` and `record_id`; the remaining fields depend on `kind`.

`record_id` is `sha256:` followed by the lowercase hexadecimal SHA-256 digest
of this exact UTF-8 preimage (`NUL` is one `0x00` byte):

```text
trackai.security-record/2 NUL <kind> NUL <source key part 1> [NUL <source key part 2> ...]
```

The source key parts are:

| Kind | Source key parts |
|---|---|
| `finding` | Numbat `finding_id` |
| `enforcement` | Numbat `decision_id` |
| `indicator` | Numbat `run_id`, `type`, `value` |
| `scan_summary` | Numbat `run_id` |
| `permission_event` | Numbat `event_id` |
| `security_status` | Endpoint-generated `observed_at` |
| `agent_inventory` | Endpoint-generated `observed_at` |

The wire value is `sha256:<64 lowercase hexadecimal characters>`. Hashing every
source key, rather than exposing Numbat IDs or indicator values inside an
idempotency key, keeps logs and safe errors from becoming a second data channel.
The Endpoint persists a generated snapshot's `observed_at` and `record_id` across
retries. The server's idempotency key is
`(tenant_id, machine_id, record_id)` for every kind; neither identity is added to
the body or to `record_id`.

An upload needs a current valid lease for its machine credential. An
authorization-bearing record's `lease_id` may name any verified lease issued to
that machine, not only its current lease, provided the record's activity time
is at or after `issued_at` and before `expires_at`. In upload
v2 this historical provenance check applies to findings (`detected_at`);
`security_status.lease_id` reports observed health rather than authorizing that
snapshot. For kinds that gain lease provenance additively, activity time is
their `timestamp` or `observed_at`, as applicable. A missing machine binding or
activity time outside the named lease window is rejected with
`SECURITY_V2_LEASE_MISMATCH`.

Every kind except `indicator` is write-once: identical replay is `duplicate`,
while reuse with changed content is rejected. Indicators are monotonic upserts,
as Numbat requires (`numbat@20a5a52:docs/cli.md:192-194`): the same ID with a
higher `count` or later `last_seen` is accepted. The stored `count` and
`last_seen` become the component-wise maxima of old and submitted values; this
defines a mixed update without regressing either value. An observation whose
count and last-seen time are both identical or older is `duplicate`. Changing
`first_seen` or any identity field is rejected.

## Record decisions and field provenance

The tables below are the field-decision table required before schemas are
written. “Optional” means the source can omit it. The Endpoint must not invent a
value. A source record that lacks a field required by this contract is not
uploadable as that kind.

### `finding`

Required fields are `kind`, `record_id`, `rule_id`, `rule_version`, `severity`,
`title`, `source_agent`, `source_type`, `confidence`, `detected_at`,
`numbat_schema_version`, `bundle_digest`, `lease_id`, `found_at_rest`, and
`repository`. Context and allowed previews are optional.

| TrackAI field | Numbat source | Meaning | Data setting |
|---|---|---|---|
| `rule_id` | `finding.rule_id` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:45`) | Built-in rule identifier. | always |
| `rule_version` | `finding.rule_version` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:46`) | Version of the rule that matched. | always |
| `severity` | `finding.severity` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:47-50`) | `info`, `low`, `medium`, `high`, or `critical`. | always |
| `title` | `finding.title` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:93`) | Bounded title from the pinned rule, not event content. | always |
| `source_agent` | `finding.source_agent` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:51-82`) | Numbat's normalized agent name. | always |
| `source_type` | `finding.source_type` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:84`) | `artifact`, `hook`, or `otel`. | always |
| `model` | `finding.model` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:89`) | Source-reported model when available. | always |
| `model_provider` | `finding.model_provider` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:90`) | Source-reported provider when available. | always |
| `session_id` | `finding.session_id` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:86`) | Source session identifier when available. | always |
| `parent_session_id` | `finding.parent_session_id` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:88`) | Parent source session when available. | always |
| `sub_agent_id` | `finding.sub_agent_id` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:92`) | Source child-agent identifier when available. | always |
| `confidence` | `finding.confidence` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:145`) | Extraction certainty, not maliciousness probability (`numbat@20a5a52:docs/cli.md:321-323`). | always |
| `tags` | `finding.tags` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:125-129`) | Bounded rule/source tags. | always |
| `detected_at` | `finding.detected_at` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:38-43`) | When Numbat created the finding. | always |
| `numbat_schema_version` | `finding.schema_version` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:25`) | Must equal `0.5.0`. | always |
| `bundle_digest` | active verified bundle | Bundle whose rules produced the finding. | always |
| `lease_id` | active verified lease | Lease permitting the upload. | always |
| `found_at_rest` | Endpoint scan context | `true` only for the opt-in day-one scan. | always |
| `repository` | Endpoint enrollment lookup | `{kind:"enrolled",id}` or `{kind:"not_enrolled"}`; Numbat's unsalted `project_path_hash` never leaves the machine (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:85`). | always |
| `observed_command` | `finding.observed_command` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:118`) | Numbat-redacted command preview, at most 200 code points. | `command_previews` |
| `observed_file_path` | `finding.observed_file_path` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:119`) | Numbat-redacted path preview, at most 200 code points. | `file_paths` |
| `observed_url` | `finding.observed_url` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:120`) | Numbat-redacted URL preview, at most 200 code points. | `urls` |
| `endpoint.hostname` | `finding.endpoint.hostname` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:148-159`) | Numbat-observed host name, redacted and at most 200 code points. | `host_identity` |
| `endpoint.username` | `finding.endpoint.username` (`numbat@20a5a52:docs/schema/v0.5.0/finding-record.schema.json:148-159`) | Numbat-observed user name, redacted and at most 200 code points. | `user_identity` |

The TrackAI `endpoint` projection is optional and closed; it can contain only
`hostname` and/or `username`. It never contains `uid` or `device_id`.
`finding.timestamp`, `observed_content_preview`, `evidence_refs`,
`cited_event_ids`, and `project_path_hash` are deliberately not projected.

### `enforcement`

| TrackAI field | Numbat source | Decision |
|---|---|---|
| `decision` | `enforcement.decision` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:30-34`) | `deny` or `no_override`; neither proves host behavior (`numbat@20a5a52:docs/enforcement.md:105-127`). |
| `mode` | `enforcement.mode` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:35`) | Numbat's `monitor` or `enforce` evaluation mode. |
| `rule_ids` | `enforcement.rule_ids` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:94-99`) | Every matched rule ID; non-empty and unique. |
| `deny_rule_id`, `deny_rule_version` | same-named fields (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:100-101`) | Required only for `deny`; forbidden for `no_override`. |
| `finding_record_ids` | `enforcement.finding_ids` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:89-93`) | The corresponding TrackAI `record_id` values, never raw Numbat finding IDs. |
| `tool_name` | `enforcement.tool_name` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:81`) | Optional tool name. |
| `tool_call_id` | `enforcement.tool_call_id` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:82`) | Optional source per-action ID. |
| `session_id` | `enforcement.session_id` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:74`) | Optional source session. |
| `source_agent` | `enforcement.source_agent` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:40-71`) | Numbat's normalized agent name. |
| `timestamp` | `enforcement.timestamp` (`numbat@20a5a52:docs/schema/v0.5.0/enforcement-record.schema.json:29`) | Required and valid UTC activity time. |

`reason`, `action_event_ids`, endpoint identity, model fields, and case IDs are
not projected.

### `indicator`

| TrackAI field | Numbat source | Decision |
|---|---|---|
| `type` | `indicator.type` (`numbat@20a5a52:docs/schema/v0.5.0/indicator-record.schema.json:20-23`) | `domain`, `ipv4`, `ipv6`, `url`, `email`, `md5`, `sha1`, or `sha256`. |
| `value` | `indicator.value` (`numbat@20a5a52:docs/schema/v0.5.0/indicator-record.schema.json:24`) | Numbat-redacted value, at most 200 code points. |
| `count` | `indicator.count` (`numbat@20a5a52:docs/schema/v0.5.0/indicator-record.schema.json:25`) | Positive safe integer. |
| `first_seen`, `last_seen` | same-named fields (`numbat@20a5a52:docs/schema/v0.5.0/indicator-record.schema.json:26-27`) | Required UTC bounds for the observation window. |
| `source_agent` | `indicator.source_agent` (`numbat@20a5a52:docs/schema/v0.5.0/indicator-record.schema.json:28-59`) | Required normalized sample agent. |

The whole kind is governed by `urls`: when that switch is false, no indicator
record may leave the machine. Sample IDs and `sample_project_path_hash` are not
projected. The record ID still derives from Numbat's `(run_id,type,value)` tuple
(`numbat@20a5a52:docs/cli.md:192-194`).

### `scan_summary`

The projection contains only `status`, `artifacts_scanned`, `events_emitted`,
`findings_emitted`, `indicators_emitted`, and `diagnostics`, directly from
`numbat@20a5a52:docs/schema/v0.5.0/scan-summary-record.schema.json:23-28`. It
contains no endpoint, run ID, HTTP status, or failure text. The hidden source
`run_id` is used only to derive `record_id`.

### `permission_event`

| TrackAI field | Numbat source | Decision |
|---|---|---|
| `outcome` | `event_type` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:108-111`) | Map `permission.requested`, `.approved`, `.denied` to `requested`, `approved`, `denied`. |
| `tool_name` | `event.tool_name` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:118`) | Optional tool name. |
| `tool_call_id` | `event.tool_call_id` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:122`) | Optional per-action ID. |
| `session_id` | `event.session_id` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:91`) | Optional source session. |
| `source_agent` | `event.source_agent` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:55-86`) | Numbat's normalized agent name. |
| `timestamp` | `event.timestamp` (`numbat@20a5a52:docs/schema/v0.5.0/event-record.schema.json:89`) | Required and valid UTC activity time; an event without one is not uploaded. |
| `join` | Endpoint correlation result | `exact`, `same_session_window`, or `unavailable`; never guessed. |

`join:"exact"` requires `tool_call_id`; `join:"same_session_window"` requires
`session_id`; `join:"unavailable"` makes no linkage claim. Numbat documents
that per-action IDs are absent for several first-wave agents
(`numbat@20a5a52:docs/agent-coverage.md:117-141`). No command, decision reason,
content, tool input/result, evidence, project path, or endpoint identity is
projected.

### `security_status`

This Endpoint-generated snapshot contains `observed_at`, `numbat_version`,
`wired_agents`, `active_bundle_digest`, `lease_id`, `last_record_at`, and
`health`. `active_bundle_digest`, `lease_id`, and `last_record_at` may be `null`
to state that no verified active value or record exists. `health` has exactly
four fields—`hook_status`, `agent_effective_view`, `local_record`, and
`forwarder_ack`—each `ok`, `failed`, or `unavailable`. They correspond in order
to Numbat's four rollout checks
(`numbat@20a5a52:docs/deployment.md:348-356`). An `ok` value is an observation of
that layer, not a claim that monitoring prevented anything.

### `agent_inventory`

This Endpoint-generated snapshot contains `observed_at` and non-empty `agents`.
Each row contains `agent`, `version`, `config`, `artifacts`, and `wired`:

| Field | Values | Source/meaning |
|---|---|---|
| `agent` | bounded string | Numbat `agent` (`numbat@20a5a52:cmd/numbat/agents.go:390`). |
| `version` | bounded string or `null` | Endpoint-observed agent version; `null` means unavailable. Numbat's report does not currently supply a version. |
| `config` | `present`, `absent`, `unavailable` | Projection of Numbat `detected` (`numbat@20a5a52:cmd/numbat/agents.go:395-397`). |
| `artifacts` | `present`, `absent`, `not_supported`, `unavailable` | Projection of `at_rest` plus `at_rest_scan_incomplete` (`numbat@20a5a52:cmd/numbat/agents.go:397,401-406`). |
| `wired` | `yes`, `no`, `not_supported`, `unavailable` | Projection of Numbat `wired` without copying its diagnostic text (`numbat@20a5a52:cmd/numbat/agents.go:399,681-738`). |

The source's `setup_hint` and filesystem-derived text never leave the machine.
The multi-state fields preserve unavailable and unsupported observations instead
of turning them into false.

## Data settings

`trackai.security-data-settings/1` is a closed object containing
`schema_version` and these five required booleans. Every boolean defaults to
`false`; omission is invalid rather than an implicit opt-in or opt-out.

| Switch | Allows only | Default |
|---|---|---:|
| `command_previews` | finding `observed_command` | `false` |
| `file_paths` | finding `observed_file_path` | `false` |
| `urls` | finding `observed_url` and the entire `indicator` kind | `false` |
| `host_identity` | finding `endpoint.hostname` | `false` |
| `user_identity` | finding `endpoint.username` | `false` |

The full versioned data-settings object is embedded in every activation lease.
The server re-checks each record against the tenant's current settings. It
refuses a record containing a disallowed field with
`SECURITY_V2_FIELD_NOT_PERMITTED`; it never silently strips the field.
If the CISO disabled a setting after a record was detected, the Endpoint
projects the rejected source record again under the current settings and
resubmits it with the same `record_id`. Because the rejected record was not
stored, that resubmission is not a record conflict.

## Rule bundle and activation lease

The rule-bundle payload contains `schema_version`, `tenant_id`,
`bundle_version`, `epoch`, `issued_at`, `numbat_pin`, `compiler_version`, and
`agents`. `bundle_version` and `epoch` are positive safe integers. `agents` is a
closed object keyed by normalized Numbat agent name; each value contains
non-empty `files` and unique `enabled_rule_ids`. Each file has a relative POSIX
`path` with no empty, `.` or `..` segment, its lowercase `sha256`, and canonical
padded `content_b64`. Receivers decode and verify every file digest before use.
`epoch` increases monotonically per tenant. The Endpoint refuses a verified
bundle whose epoch is below the last epoch it applied with `EPOCH_REGRESSION`.

The activation-lease payload contains `schema_version`, `tenant_id`,
`machine_id`, `lease_id`, `issued_at`, `expires_at`, `mode`, unique non-empty
`agents`, `bundle_digest`, the full versioned `data_settings`, and
`day_one_scan`. `mode` is `off`, `monitor`, or `monitor_and_pilot_block`.
`expires_at` must be after `issued_at`; issuers normally use the 72-hour validity
and refresh hourly. Expiry, rejected verification, or unavailable verification
means monitoring is off and new uploads stop. Turning monitoring off takes
effect when the next hourly refresh supplies an `off` lease; a disconnected
machine remains governed by its current signed lease until expiry.
The lease's `bundle_digest` must equal the digest of the bundle being applied;
otherwise the Endpoint refuses it with `BUNDLE_DIGEST_MISMATCH`.

Both payloads travel in the existing DSSE envelope from
[`../attesta/envelope.md`](../attesta/envelope.md). The bundle uses purpose
`policy_bundle`, audience `platform`; the lease uses purpose
`activation_lease`, audience `platform` (`../attesta/trust.md`, “Consumers”).
The bundle digest is SHA-256 over the exact decoded DSSE payload bytes—not the
envelope bytes or a re-serialization. A rejected bundle is refused; unavailable
bundle verification keeps the last known good bundle. A rejected or unavailable
lease keeps monitoring off.

## Lease acknowledgement

`trackai.security-acknowledgement/1` contains `schema_version`, `lease_id`,
`bundle_digest`, `result`, and an optional `refusal_code`. `result` is `applied`
or `refused`. `refusal_code` is required for `refused`, forbidden for `applied`,
and is one of `SIGNATURE_REJECTED`, `VERIFICATION_UNAVAILABLE`, `LEASE_EXPIRED`,
`MACHINE_MISMATCH`, `TENANT_MISMATCH`, `EPOCH_REGRESSION`,
`BUNDLE_DIGEST_MISMATCH`, `RULES_CHECK_FAILED`, or `UNSUPPORTED_SCHEMA`. Codes
may be added only additively. Tenant and machine identity still come only from
the machine credential.

## Fleet configuration schema version 3

Version 3 is identical to Task9's version 2 envelope—`configurationId`, `epoch`,
`issuedAt`, `validUntil`, `channel`, `ring`, `repositoryPolicies`,
`clientCompatibility`, `desiredRelease`, and `verification` retain their v2
names and meanings—except `securityActivation` is absent and this required value
takes its place:

```json
{
  "securityLease": {
    "leaseId": "opaque-lease-id",
    "bundleDigest": "64-lowercase-hex-characters",
    "expiresAt": "2026-10-20T12:00:00Z"
  }
}
```

Schema versions 1 and 2 remain valid. Their `securityActivation` is interpreted
as `off`; this contract does not change Task9's current TypeScript or database
check. Task20f implements version 3 and widens the database constraint.

## Privacy boundary

No security-v2 record may contain `tool_input`, `tool_result`, `content`,
message `content_preview`, `evidence_refs`, `project_path`, `project_path_hash`,
`sample_project_path_hash`, `endpoint.uid`, `endpoint.device_id`, a tenant ID, a
machine ID, or any field not explicitly listed by its schema. Numbat's local
records retain richer data; this contract is the smaller allowlist that may
cross the machine boundary.

Fixtures adapted from Numbat are identified in `fixtures/NOTICE.md` and contain
placeholders instead of real paths, hosts, users, or secrets.

## Stage 1 decisions beyond the approved prompt

1. `record_id` hashes a domain-separated source key for every kind. Snapshot
   kinds add `observed_at`, and scan summaries use the source `run_id`, so retries
   are stable without exposing indicator values or source IDs.
2. A permission event without a valid timestamp is not uploaded. `exact` and
   `same_session_window` joins require the identifier they claim to use.
3. Agent inventory uses honest multi-state values and `version:null` because
   Numbat 0.5.0's JSON has `detected`, free-text `at_rest`, `wired`, and
   `at_rest_scan_incomplete`, but no agent version.
4. Rule bundles add `issued_at`, required by the trust consumer's signing-time
   check, and use positive integers for `bundle_version` and `epoch`.
5. The full versioned data-settings object is embedded in the lease, so its
   meaning cannot drift independently of the signed payload.
6. The acknowledgement is versioned and makes `refusal_code` conditionally
   required, so a refusal is actionable without accepting free-text details.

The Task20 lead confirmed these decisions on 2026-10-17 and added the
machine-scoped idempotency key, monotonic indicator upserts, monotonic bundle
epoch, exact bundle-digest binding, and the closed acknowledgement refusal-code
set above.
