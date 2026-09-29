# Task6 Security Wave 2 Discovery

Status: **🟡 ◐ Draft for product/security review**

Last updated: **2026-09-29**

This document is the Wave 2 working record for S6.1 and S6.2. The canonical
status remains in [`TASK6_SECURITY.md`](../TASK6_SECURITY.md).

## Boundary

This wave defines vocabulary and reviews candidate rules only. It does not add
an evaluator, upload path, database, tenant setting, dynamic bundle, customer
rule override, enforcement response or blocking behavior.

The first route under review is Task13 route **AC-CLI-03**: OpenCode in a local
terminal/TUI. GitAI's existing plugin observes `tool.execute.before` and
`tool.execute.after` for bounded edit and Bash tool calls. Numbat documents
OpenCode as monitor-only. A before-hook observation proves a request, not an
outcome; an after-hook observation proves only the result fields the host
actually supplies.

## S6.1 closed event and capability vocabulary

### Versioning and invariants

- Contract identifier: `trackai.security-event/0.1`.
- Unknown enum values or fields fail validation; they are not guessed.
- Missing evidence is `unavailable`, never zero, false, success or no-match.
- Request and result are distinct events joined by a bounded correlation ID.
- Agent family, model provider, host surface, host mode, capture channel and OS
  are separate fields.
- Raw command, path, URL and tool arguments are transient evaluator inputs.
  They are never part of the server finding, logs, errors, metrics or audit.
- The only release effects are `off` and `monitor`. Severity cannot change the
  effect, and a match never means an action was blocked.

### Event envelope

| Field | Closed values or constraint | Meaning |
|---|---|---|
| `schemaVersion` | `trackai.security-event/0.1` | Contract version. |
| `eventId` | Local opaque ID, maximum 128 characters | Local identity; never derived from raw content. |
| `occurredAt` | RFC 3339 timestamp | Source observation time. |
| `eventType` | `command_exec`, `command_result`, `file_read`, `file_write`, `file_delete`, `network_indicator`, `tool_call`, `tool_result`, `permission_requested`, `permission_approved`, `permission_denied`, `unavailable` | One normalized action or result class. |
| `phase` | `requested`, `observed_result`, `partial`, `unavailable` | Whether evidence describes intent to act, a later observation, incomplete evidence or no usable evidence. |
| `availability` | `available`, `unavailable`, `redacted`, `expired` | Task2/Task5 evidence availability; no invented values. |
| `completeness` | `complete`, `partial` | Whether all fields required by a candidate rule were exposed. |
| `correlationId` | Optional local opaque ID, maximum 128 characters | Joins a request to results without embedding content. |
| `capability` | Closed capability object below | States exactly what the route can prove. |
| `input` | Typed transient union selected by `eventType` | Evaluated locally and removed before finding projection. |

### Capability object

| Field | Closed values or constraint |
|---|---|
| `routeId` | Existing Task13 route ID; initially `AC-CLI-03` |
| `agentFamily` | Existing Task13 family; initially `opencode` |
| `modelProvider` | Exact provider when observed, otherwise `unavailable` |
| `hostSurface` | Existing Task13 surface; initially `terminal` |
| `hostMode` | Existing Task13 mode; initially `cli` |
| `captureChannel` | Existing Task13 channel; initially `provider-plugin` |
| `operatingSystem` | `macos`, `linux`, `windows`, `wsl`, `unavailable` |
| `timing` | `pre_action`, `post_action`, `at_rest`, `unavailable` |
| `nativeEffect` | `observe_only`, `native_deny_available`, `unavailable` |
| `activation` | `configured`, `loaded`, `observed`, `unavailable` |

`configured` is not proof that a host loaded a plugin. `loaded` is not proof
that a relevant event was observed. Initial OpenCode findings must use
`nativeEffect: observe_only`, even for a pre-action callback.

### Transient input union

Only the fields required for the selected event type may be present:

- command events: bounded command text plus structured command projection;
- file events: one normalized semantic path and operation;
- network indicators: one validated HTTP(S) URL or bounded destination;
- tool events: bounded tool identity and typed arguments needed by an approved
  rule; and
- permission events: bounded decision category, never free-form reason text.

An adapter that cannot provide a required field emits `eventType: unavailable`
or `completeness: partial`. It must not downgrade the requirement or treat the
event as a clean `no_match`.

### Safe finding projection

Contract identifier: `trackai.security-finding/0.1`.

Allowed fields are limited to authorized Task4 tenant, machine, repository and
session correlation IDs; finding and delivery IDs; rule ID/version, category
and severity; route/capability enums; `monitor` effect; phase, availability and
completeness; result category; occurrence time; and client/rule-pack version.

The projection rejects command text, paths, URLs, prompts, responses,
reasoning, file content, tool arguments/results, previews, detected secret
values and arbitrary maps. IDs have fixed maximum lengths, enums are closed,
and every finding names the immutable rule version that produced it.

## S6.2 pinned upstream inventory

| Item | Pinned value |
|---|---|
| Repository | `https://github.com/perplexityai/numbat` |
| Commit | `f0778c09dc48281aa93a3887d05096c0a1f3f9f7` |
| Commit time | `2026-08-17T21:23:07+01:00` |
| License | Apache-2.0 (`LICENSE` at the pinned commit) |
| Authoritative definitions | `rules/**/*.yaml` |
| Candidate count | 51 enabled built-in rules |
| Adoption form | Not yet decided; copied/adapted work must retain notices and identify modifications |

The 51 candidates were enumerated from the authoritative YAML, not the catalog
summary: chains 6, execution 6, exfiltration 4, impact 4, integrity 2, lateral
movement 1, persistence 6, privilege 6, reconnaissance 3, secrets 8, source
control 2 and tampering 3.

Every candidate now has a draft input, AC-CLI-03 fidelity, false-positive risk
and disposition in
[`TASK6_SECURITY_RULE_INVENTORY.md`](TASK6_SECURITY_RULE_INVENTORY.md). These
are review proposals, not accepted rules: 3 are proposed for first review, 46
are deferred by an explicit reason, and 2 Numbat/policy-specific rules are
proposed for exclusion from v0.1.

### Proposed first review subset

These are proposals for product/security approval, not accepted release rules.

| TrackAI proposal | Upstream identity | Required transient input | AC-CLI-03 fidelity | False-positive focus | Proposed disposition |
|---|---|---|---|---|---|
| `trackai.exec.destructive_recursive_delete` | `exec.destructive_recursive_delete` v1.5 | Pre-action Bash/PowerShell/cmd command plus bounded structured parse | Requested action is available from a loaded OpenCode before-hook; execution outcome requires a later correlated result | Quoted examples, dry-run forms, unresolved home variables and repository-only cleanup must remain negative | **Review for initial subset** |
| `trackai.exec.download_pipe_shell` | `exec.download_pipe_shell` v1.4 | Pre-action command plus bounded pipeline parse | Requested action available; no prevention claim | Local scripts, redirected stdin, comments, examples and non-executing downloads must remain negative | **Review for initial subset** |
| `trackai.exec.reverse_shell` | `exec.reverse_shell` v1.3 | Pre-action command plus bounded executable/argument parse | Requested action available; outcome may be unavailable | Benign socket examples, documentation text and non-executed strings must remain negative | **Review for initial subset** |

All three remain `monitor`, even when the event arrives pre-action. The safe
finding records only the rule identity and bounded categorical result; it does
not include the matching command or parsed arguments.

### Explicit early deferrals

- All six ordered chains are deferred from the first subset until bounded
  per-tenant/machine/session state and expiry behavior are designed.
- Rules that require prompt, response, reasoning or `content_preview` are
  deferred because the initial release does not need conversation content.
- Secret-file and credential-path rules remain under review because path
  fidelity, home expansion, platform behavior and false-positive risk must be
  proven without uploading the path or detected value.
- `persistence.git_hook_write`, `source.git_config_exec` and
  `source.git_remote_tamper` remain under review because legitimate GitAI hook
  installation, credential-helper setup and repository onboarding are expected
  negative controls.
- E6-2 stays yellow because the 51 draft dispositions still require
  product/security review, the three-rule fixture set is not written, and
  Apache-2.0 notice/modification handling is not yet approved.

## Required review before runtime work

1. Confirm the vocabulary distinguishes requested, observed, partial and
   unavailable evidence in customer-safe language.
2. Approve, change or reject the three-rule proposed first subset.
3. Confirm Apache-2.0 notice and modification-marking expectations.
4. Approve or change all 51 draft inventory dispositions and complete fixtures
   for any accepted first-subset rule before any S6.3 evaluator implementation.
