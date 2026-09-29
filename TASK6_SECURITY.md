# Task6 Security — Coding-Agent Security

**Canonical active Task6 Security tracker**

Status: **🟡 ◐ Active planning; implementation has not begun**

Last updated: **2026-09-27**

Portfolio roadmap: [`ROUGH_ROADMAP.md`](ROUGH_ROADMAP.md)

Deferred organization-policy tracker: [`TASK6_POLICY.md`](TASK6_POLICY.md)

Task5 evidence authority: [`TASK5.md`](TASK5.md)

Agent/host coverage authority: [`AGENT_COVERAGE.md`](AGENT_COVERAGE.md)

Implementation handoff: [`docs/handoffs/TASK5_TO_TASK6_SECURITY.md`](docs/handoffs/TASK5_TO_TASK6_SECURITY.md)

## Status and evidence rules

| Symbol | Meaning |
|---|---|
| 🟢 ✅ | Complete for the stated scope and manually verified live where required |
| 🟡 ◐ | Partially implemented, automated-test-only, or awaiting a required live/manual gate |
| 🔴 ☐ | Not implemented or not tested |
| ⚪ — | Explicitly deferred or not applicable |

Implementation and verification are separate columns. Passing a unit test does
not make a live gate green. A wave turns green only when its named exit gate is
recorded with sanitized evidence. Intermediate failures remain in the dated
evidence log until a later green result supersedes them; they are not rewritten
or hidden.

## Purpose

Task6 Security adds local coding-agent threat detection using a curated,
version-pinned subset of Numbat-style rules. The first release is deliberately
small: a tenant administrator may choose **off** or **monitor**, rules execute
locally, and TrackAI receives only privacy-safe finding metadata.

This task does not build the general organization policy engine, Cedar-like
authorization, customer-authored rules, or dynamic signed bundle distribution.
Those designs are retained in [`TASK6_POLICY.md`](TASK6_POLICY.md) and remain
deferred until customer requirements justify them.

## Product boundary

### In scope now

- A closed normalized event and agent-capability contract.
- A reviewed and version-pinned subset of upstream Numbat rules.
- Local evaluation in GitAI with rules shipped in the normal client release.
- Explicit tenant-administrator `off` or `monitor` control.
- Privacy-safe finding upload, tenant isolation, restricted access and audit.
- Honest reporting of pre-action, post-action, partial and unavailable evidence.
- Rule provenance, licensing, positive/negative tests and false-positive review.
- Compatibility testing across the agents, hosts and operating systems that
  TrackAI actually claims to support.

### Not in the initial release

- Blocking or automatic denial.
- Customer-authored or customer-overridden rules.
- Cedar-like organization authorization.
- Policy inheritance, exceptions, approvals or simulation.
- Dynamic rule download, signing, distribution, activation or rollback.
- General capture, upload, redaction, retention, access or export policy.
- Claims of protection for hosts that cannot provide the required event or hook.

Blocking is a separate future gate. It may be piloted only for a small reviewed
rule set on hosts with a verified synchronous pre-action hook and an explicit
recovery contract.

## Inherited safety floor

Task6 Security consumes rather than redefines these contracts:

| Authority | Existing protection Task6 must preserve |
|---|---|
| Task2 | Missing or suppressed evidence is `Unavailable`, never invented zero; observed evidence and corrections remain distinct. |
| Task4 | Tenant/machine/repository/branch authorization, managed credentials, durable delivery, server-side admission, audit and tenant isolation. |
| Task5 | Tenant-admin opt-in for raw OpenCode evidence, always-on secret scanning, envelope-encrypted raw content separate from metadata, administrator/auditor-only audited raw access with `no-store`, content-free logs and complete 30-day deletion propagation. |

Task5 consent is currently tenant-wide and default-off; it is not a
repository-level policy. Task6 Security must not reinterpret that switch as
consent to upload raw security inputs. Prompts, responses, available reasoning,
tool arguments/results, intentions, summaries and embeddings remain sensitive
customer data.

Security rules may inspect transient local fields needed for a decision. That
does not authorize TrackAI to persist or upload those fields. Any later policy
work may make the baseline stricter but may not disable secret scanning, tenant
isolation, encryption, restricted access, safe logging or deletion propagation.

## Numbat adoption contract

Numbat is an upstream input, not an unreviewed product promise. Its built-in
catalog is detection-enabled and does not block by default. A pre-action match
describes a requested action, not a confirmed outcome. The authoritative rule
definitions are the versioned YAML files, not the catalog summary.

The current upstream catalog covers secrets, exfiltration, integrity,
execution, reconnaissance, privilege, lateral movement, impact, source
control, tampering, persistence and ordered sequences. Rules have stable IDs
and rule-owned versions, evaluate normalized events with CEL-like predicates,
and may evaluate one event or an ordered sequence. The upstream `enforce` flag
is separate from severity, and operator rules may replace built-ins by stable
ID. TrackAI will not enable that override mechanism in its initial release.

Enforcement depends on a coding-agent host's synchronous pre-action hook: the
detector requests a native deny, while the host is the actual enforcement
point. Post-action, OTLP and at-rest observations cannot prevent an action that
already happened. Deployment may use user, project or managed/system hook
scopes, but writing configuration is not proof that a host loaded it. TrackAI
must verify activation and record the real capability per route. Numbat is
Apache-2.0 licensed; copied or adapted work must retain required notices and
identify modifications.

References:

- [Built-in rule catalog](https://github.com/perplexityai/numbat/blob/main/docs/rule-catalog.md)
- [Writing rules](https://github.com/perplexityai/numbat/blob/main/docs/rules.md)
- [Normalized event model](https://github.com/perplexityai/numbat/blob/main/docs/event-model.md)
- [Enforcement behavior](https://github.com/perplexityai/numbat/blob/main/docs/enforcement.md)
- [Deployment guidance](https://github.com/perplexityai/numbat/blob/main/docs/deployment.md)
- [Apache-2.0 license](https://github.com/perplexityai/numbat/blob/main/LICENSE)

For every accepted rule, record:

| Field | Required evidence |
|---|---|
| Source | Upstream repository, path, commit SHA and license. |
| Identity | Stable TrackAI ID, upstream ID and upstream rule version. |
| Modification | Whether the rule is copied, adapted or independently implemented. |
| Inputs | Required event types and fields, including whether sensitive transient content is needed. |
| Fidelity | Agents/hosts that provide pre-action, post-action, incomplete or no usable evidence. |
| Effect | `monitor` in the initial release. Severity never implies blocking. |
| Certainty | Requested action, observed result or incomplete/ambiguous evidence. |
| Output | Exact safe finding fields; raw matching content is excluded. |
| Tests | Positive, negative, ambiguous, malformed, bypass, false-positive and compatibility fixtures. |

The accepted inventory and rule count are discovery outputs. Documentation must
not promise that every upstream rule is supported.

## Runtime model

```text
agent/host activity
  → host adapter and capability label
  → closed normalized event
  → local embedded rule evaluator
  → local finding with rule and evidence certainty
  → privacy-safe projection
  → existing Task4 authenticated durable delivery
  → authoritative server tenant admission
  → tenant-isolated finding, audit and admin/auditor view
```

Rules are pinned and shipped with the GitAI release. Upgrading a rule requires a
normal reviewed client release with provenance and regression evidence. This
avoids building the deferred signing/distribution control plane before it is
needed.

### Local decision states

| State | Meaning |
|---|---|
| `off` | Tenant administrator has not enabled security monitoring; no finding is produced or uploaded. |
| `no_match` | Required evidence was available and no enabled rule matched. This normally stays local. |
| `monitor_match` | A rule matched; no action was blocked. |
| `unavailable` | The host or adapter did not expose enough evidence to evaluate correctly. |
| `error` | The rule pack, parser or evaluator failed safely; no successful protection claim is made. |

### Safe server finding

The initial upload contract may contain only bounded metadata such as:

- tenant, machine, repository and session correlation IDs already authorized
  by Task4;
- rule ID and version;
- rule category and severity;
- source agent/host and capability class;
- `monitor` decision;
- requested/observed/unavailable certainty;
- result category, occurrence time and client/rule-pack version; and
- deduplication and delivery identifiers.

It must not contain raw commands, prompts, responses, reasoning, file content,
tool arguments/results, detected secret values or arbitrary content previews.
Logs, errors, metrics and audit details follow the same restriction.

## Master Task6 Security matrix

| ID | Workstream | Implemented | Tested & verified | Manual involvement | Dependencies | Priority/order | Evidence / remaining work |
|---|---|---:|---:|---|---|---|---|
| **S6.1** | Event and capability contract | 🟡 ◐ | 🔴 ☐ | Review customer-safe vocabulary and unsupported-capability wording. | Task2 semantics; Task13 taxonomy | **Wave 2 · 1** | Draft `trackai.security-event/0.1` and `trackai.security-finding/0.1` vocabularies are recorded in [`docs/TASK6_SECURITY_WAVE2_DISCOVERY.md`](docs/TASK6_SECURITY_WAVE2_DISCOVERY.md). Schema fixtures and product/security review remain. |
| **S6.2** | Numbat inventory and rule selection | 🟡 ◐ | 🔴 ☐ | Security review of every accepted/rejected rule and its false-positive risk. | S6.1; upstream pinned source/license | **Wave 2 · 2** | Numbat commit `f0778c09` and its 51 YAML candidates are pinned. Three high-signal command rules are proposed for review; the other 48 still require per-rule dispositions. |
| **S6.3** | Embedded local evaluator | 🔴 ☐ | 🔴 ☐ | Review resource limits and monitor-only behavior before live execution. | S6.1–S6.2; GitAI architecture | **Wave 3 · 3** | Deterministic bounded evaluation of the release-pinned rule set with `off`/`monitor` only. |
| **S6.4** | Privacy-safe finding delivery | 🔴 ☐ | 🔴 ☐ | Controlled offline/restart, revocation and two-tenant verification. | S6.1, S6.3; Task4 delivery | **Wave 4 · 4** | Use Task4 credentials and immutable scope binding without uploading source content. |
| **S6.5** | Server storage, access, audit and UI | 🔴 ☐ | 🔴 ☐ | Administrator, auditor and ordinary-user walkthrough. | S6.4; Task4 authorization; Task5 privacy | **Wave 5 · 5** | Tenant-isolated findings with clear certainty/capability labels and restricted audited access. |
| **S6.6** | Agent and OS conformance | 🔴 ☐ | 🔴 ☐ | Real supported agent/host/OS experiments; customer wording review. | S6.1–S6.5; Task13 matrix | **Wave 6 · 6** | Every claimed route passes; unsupported routes are labelled honestly. |
| **S6.7** | Optional blocking pilot | ⚪ — | ⚪ — | Separate product/security approval is mandatory. | Completed monitor release; verified synchronous hook | **Deferred** | Not part of the initial release. Requires recovery, bypass, false-positive and host-confirmation gates. |

## Execution waves

| Wave | Scope | Subtasks | Implemented | Tested & verified | Exit gate |
|---|---|---|---:|---:|---|
| **1** | Canonical tracker, handoff and clean baselines | All | 🟡 ◐ | 🟡 ◐ | Both repositories start from verified merged checkpoints; tracker and evidence register are authoritative. |
| **2** | Security vocabulary and rule discovery | S6.1–S6.2 | 🟡 ◐ | 🔴 ☐ | Event/capability schema and reviewed pinned rule inventory are accepted before runtime work. |
| **3** | Local monitor evaluator | S6.3 | 🔴 ☐ | 🔴 ☐ | Deterministic `off`/`monitor` evaluation passes positive, negative, ambiguous and resource-limit tests. |
| **4** | Safe durable delivery | S6.4 | 🔴 ☐ | 🔴 ☐ | Findings contain only approved metadata and survive offline/restart/replay without crossing tenant or repository scope. |
| **5** | Server and customer surface | S6.5 | 🔴 ☐ | 🔴 ☐ | RLS, role access, audit, safe logs and understandable monitor-only UI pass. |
| **6** | Route/platform conformance | S6.6 | 🔴 ☐ | 🔴 ☐ | Every claimed agent/host/OS route has live evidence; missing capability is shown as unavailable. |
| **7** | Release regression and handoff | S6.1–S6.6 | 🔴 ☐ | 🔴 ☐ | Task2, Task4 and Task5 regressions plus all required E6 gates pass; exact supported matrix is recorded. |

### Wave 1 starting checkpoints

| Repository | Remote `main` SHA | Task6 branch | Worktree state | Baseline status |
|---|---|---|---|---:|
| TrackAI | `957ba318482a244840e785e6b1e79fcd3d196f8c` | `feature/task6-security` | Clean isolated worktree | 🟡 ◐ |
| GitAI | `0097645d3179d4baa3b6bff043149b08dbf79155` | `feature/task6-security` | Clean isolated worktree | 🟡 ◐ |

## Controlled evidence-gate register

| Gate | Scenario | Main mapping | Implemented | Tested & verified | Required sanitized evidence | Manual involvement |
|---|---|---|---:|---:|---|---|
| **E6-1** | Normalized event and capability contract | S6.1 | 🟡 ◐ | 🔴 ☐ | Draft v0.1 vocabularies distinguish request, result, partial and unavailable evidence and keep raw evaluator input out of findings. Versioned schema fixtures remain. | Vocabulary review |
| **E6-2** | Pinned Numbat inventory and license/provenance | S6.2 | 🟡 ◐ | 🔴 ☐ | Upstream commit/license and all 51 candidate identities are pinned; three proposed rules have initial fidelity/privacy review. Per-rule disposition for the remaining 48 and legal/security review remain. | Security/legal review |
| **E6-3** | Deterministic monitor-only evaluator | S6.3 | 🔴 ☐ | 🔴 ☐ | Positive, negative, ambiguous, malformed, bypass, sequence and false-positive fixtures. | Rule-result review |
| **E6-4** | Privacy-safe finding contract | S6.4 | 🔴 ☐ | 🔴 ☐ | Captured request/log/database inspection proves no raw command, prompt, payload or secret. | Controlled content review |
| **E6-5** | Durable authenticated delivery and replay | S6.4 | 🔴 ☐ | 🔴 ☐ | Offline/restart/retry/replay, partial acknowledgement and revocation outcomes. | Physical-machine restart |
| **E6-6** | Company A/Company B isolation | S6.4–S6.5 | 🔴 ☐ | 🔴 ☐ | Cross-tenant credential, repository, finding, audit and UI access all fail closed. | Two-tenant live gate |
| **E6-7** | Role-safe server/API/UI experience | S6.5 | 🔴 ☐ | 🔴 ☐ | Admin/auditor access, ordinary-user denial, `no-store`, safe logs and clear monitor wording. | Browser walkthrough |
| **E6-8** | Unsupported and incomplete capability | S6.1, S6.6 | 🔴 ☐ | 🔴 ☐ | Unsupported route reports `unavailable`; post-action evidence is never presented as prevention. | Real host comparison |
| **E6-9** | Supported agent/OS conformance | S6.6 | 🔴 ☐ | 🔴 ☐ | Task13 route IDs map to exact tested agent, host, capture channel and OS combinations. | Real platform runs |
| **E6-10** | Task2/Task4/Task5 release regression | S6.1–S6.6 | 🔴 ☐ | 🔴 ☐ | Lifecycle semantics, delivery/security and evidence privacy/deletion remain unchanged. | Final release review |

Add dated implementation-evidence rows below this register as work proceeds.
Each row must name the checkpoint/PR or command, sanitized result, remaining
work and whether manual verification is still required.

### Dated implementation evidence

| Date | Wave / gate | Checkpoint or command | Sanitized result | Remaining work | Manual verification |
|---|---|---|---|---|---|
| 2026-09-26 | Wave 1 start | Remote `main` fetch, exact-SHA worktree creation and `git status --short --branch` | TrackAI `957ba318` and GitAI `0097645d3` resolved from their hosted `main` branches into separate clean `feature/task6-security` worktrees. The canonical tracker, deferred-policy boundary and handoff are present on TrackAI `main`. | Run current TrackAI and GitAI automated baselines and record all pass/failure evidence without hiding failures. | None for checkpoint resolution; live gates remain pending. |
| 2026-09-26 | Wave 1 TrackAI baseline failure | `npm run build --workspace=apps/web` with no local environment file | Compilation and type checking passed, but static page generation failed closed because the clean worktree had no Supabase URL or public anonymous key. No credential was copied from an older worktree. | Rerun with bounded synthetic build-only values; retain this failure history. | None. |
| 2026-09-26 | Wave 1 TrackAI baseline | API build, web build with synthetic process-only values, `drizzle-kit check`, and `npm audit --json` | API build passed 129 tests and TypeScript; web production build passed without creating an environment file; Drizzle reported a valid schema. Dependency audit reported 41 existing advisories: 13 moderate, 27 high and 1 critical, including direct `next`, `express`, `postcss`, `autoprefixer`, ESLint and Drizzle toolchain findings. | Review dependency remediation separately; complete GitAI test/build/lint baseline. | None for automated results. |
| 2026-09-26 | Wave 1 GitAI baseline failure | `task test` inside the Codex sandbox | Compilation and 2,184 library tests passed. The run stopped in `async_mode`: 8 tests passed and 6 daemon tests failed because GitAI correctly refuses daemon startup when `CODEX_SANDBOX` is set. The failure is environmental and remains recorded. | Rerun the full suite outside the Codex sandbox; do not bypass the safeguard here. | One bounded local terminal run required. |
| 2026-09-26 | Wave 1 GitAI build/lint | `task build`; `task lint` | Build passed. Lint failed on 11 pre-existing Clippy findings under local Homebrew Rust 1.97.1; GitAI documents Rust 1.93.0 and this machine has no `rustup`, so the required toolchain-equivalent lint gate remains unverified. GitAI worktree stayed unchanged. | Run lint with the documented Rust 1.93.0 toolchain or the repository CI image, then record the result. | Toolchain-controlled lint run required. |
| 2026-09-27 | Wave 1 GitAI physical-machine rerun failure | User-run `task test` outside Codex after an earlier full-suite run appeared stuck and was interrupted with Ctrl-C | The subsequent run reached `daemon_mode`: 73 tests passed and 2 failed. `await_waits_for_metrics_and_notes_flush` observed no notes upload, and `daemon_marks_repository_filtered_session_events_delivered_without_uploading_them` did not observe the allowed session upload. The prior interruption may have left daemon or temporary delivery state, so this is retained as failure evidence but is not treated as a clean full-suite baseline. The GitAI Task6 worktree had no code changes. | Run both failing tests individually to distinguish a deterministic regression from residual-state or full-suite concurrency/timing interference. Keep this red row even if focused reruns pass. | Focused physical-machine rerun required. |
| 2026-09-27 | Wave 1 GitAI focused rerun | `task test TEST_FILTER=daemon_marks_repository_filtered_session_events_delivered_without_uploading_them CARGO_TEST_ARGS="--test daemon_mode"` outside Codex | Green: 1 passed, 0 failed, 74 filtered out in 186.01 seconds. The earlier full-suite failure is therefore not deterministic in isolation, but its long runtime and concurrency sensitivity remain baseline evidence. | Run the second focused notes-flush test, then decide whether a serial full-suite confirmation or test stabilization is required. | One focused physical-machine test remains. |
| 2026-09-27 | Wave 1 GitAI focused notes-flush failure | `task test TEST_FILTER=await_waits_for_metrics_and_notes_flush CARGO_TEST_ARGS="--test daemon_mode"` outside Codex | Red: 0 passed, 1 failed, 74 filtered out in 191.74 seconds. Metrics upload was observed, but notes upload count was zero. A separate Codex-local diagnostic run also failed before completion evidence, with zero metrics uploads; because that environment is sandbox-constrained, it is diagnostic only. Together these results show that the test's delivery setup is unstable and that `await` can report completion without both expected request classes being observed. | Diagnose note creation/queueing versus await-flush ordering without weakening durable delivery, authentication, repository filtering or privacy behavior. Require a focused physical-machine green rerun before accepting the gate. | Focused physical-machine rerun required after a reviewed stabilization or fix. |
| 2026-09-27 | Wave 1 GitAI instrumented focused rerun | GitAI `383408e78`; focused `await_waits_for_metrics_and_notes_flush` outside Codex | Green: 1 passed, 0 failed, 74 filtered out in 196.06 seconds. This run enabled daemon debug logging and added failure-only request/log diagnostics. Because debug logging can alter scheduling, the pass narrows the issue to timing or residual-state sensitivity but does not supersede the earlier clean focused failure. | Remove the timing-affecting debug setting, retain failure context, and rerun the original focused behavior once before deciding whether a clean serial full-suite run is justified. | One clean focused physical-machine rerun required. |
| 2026-09-27 | Wave 1 GitAI clean focused confirmation | GitAI `2d7648a75`; focused `await_waits_for_metrics_and_notes_flush` outside Codex | Green: 1 passed, 0 failed, 74 filtered out in 158.06 seconds with debug logging removed. Both tests from the earlier two-failure run now pass independently. The original run followed an interrupted suite, so residual state or concurrent `daemon_mode` interaction remains the leading explanation; no production delivery change has been made. | Run one clean `daemon_mode` suite at its normal configured concurrency. If it fails again, use a serial run to isolate cross-test concurrency before any full-suite rerun. | One clean `daemon_mode` physical-machine run required. |
| 2026-09-29 | Wave 1 GitAI clean concurrent `daemon_mode` rerun | `task test CARGO_TEST_ARGS="--test daemon_mode"` outside Codex | 74 passed and 1 failed in 308.20 seconds. Both earlier failing await/upload tests passed in the suite. The only failure was `daemon_debug_logging_does_not_reupload_ureq_logs`; the supplied output did not include its assertion block, so it is not yet known whether startup logs were absent or a `ureq` target was re-uploaded. | Run only the new failing test and capture its full assertion block before changing code. | One focused physical-machine rerun required. |
| 2026-09-29 | Wave 1 GitAI focused debug-log rerun and test stabilization | Focused `daemon_debug_logging_does_not_reupload_ureq_logs`; GitAI `8d41c5733` | The focused test passed: 1 passed, 0 failed, 74 filtered out in 160.75 seconds. Review found a fixed two-second startup-log observation window in a test that failed only under 12-thread suite load. The test-only stabilization raises that bounded poll to the existing 10-second `await` limit and adds captured request paths on failure; the assertion rejecting all `ureq` and `ureq::*` uploads is unchanged. Formatting and compile-only `daemon_mode` checks pass. | Rerun the clean concurrent `daemon_mode` suite to verify the stabilization under the context that exposed it. | One clean concurrent `daemon_mode` physical-machine run required. |
| 2026-09-29 | Wave 1 GitAI concurrent `daemon_mode` stabilization rerun | `task test CARGO_TEST_ARGS="--test daemon_mode"` outside Codex at GitAI `8d41c5733` | 74 passed and 1 failed in 236.54 seconds. The stabilized debug-log test passed. `await_waits_for_metrics_and_notes_flush` recorded only `/worker/metrics/upload`; its daemon log showed the notes upload failed with `HTTP request failed: io: Peer disconnected`, followed milliseconds later by a successful two-event metrics upload. The note was created and its upload attempted; the single-threaded test mock dropped the connection under suite scheduling pressure. | Verify the bounded mock-server read-timeout stabilization under normal suite concurrency. | One clean concurrent `daemon_mode` physical-machine run required. |
| 2026-09-29 | Wave 1 GitAI mock delivery stabilization | GitAI `25d5339e0` | The test mock's per-connection read timeout now matches the delivery tests' bounded 10-second await interval instead of dropping accepted requests after two seconds. This is test-harness-only; production note retry, authentication, durable delivery and privacy behavior are unchanged. Formatting and compile-only `daemon_mode` checks pass. | Rerun the clean concurrent `daemon_mode` suite; preserve any enhanced request/log failure evidence. | One clean concurrent `daemon_mode` physical-machine run required. |
| 2026-09-29 | Wave 1 GitAI concurrent mock root cause | Concurrent `daemon_mode` rerun at GitAI `25d5339e0`; GitAI stabilization `3caa111b3` | The suite again produced 74 passes and 1 failure in 247.74 seconds, but the failure inverted: `/worker/notes/upload` succeeded while metrics failed with `Peer disconnected`. This proves the single-threaded mock server was serializing simultaneous daemon connections and starving whichever request waited behind an accepted connection. The mock now handles accepted connections concurrently, joins handlers cleanly, and retains the bounded read timeout. Both delivery assertions and all production behavior remain unchanged. Formatting and compile-only checks pass. | Rerun the clean concurrent `daemon_mode` suite under the same 12-thread context. | One clean concurrent `daemon_mode` physical-machine run required. |
| 2026-09-26 | Wave 2 / E6-1 draft | [`docs/TASK6_SECURITY_WAVE2_DISCOVERY.md`](docs/TASK6_SECURITY_WAVE2_DISCOVERY.md) | Draft closed event, capability and safe-finding vocabularies preserve requested-versus-observed, partial/unavailable evidence, Task13 dimensions and the raw-content boundary. | Add executable schema fixtures and obtain vocabulary review before S6.3. | Product/security vocabulary review required. |
| 2026-09-26 | Wave 2 / E6-2 discovery | Numbat `f0778c09dc48281aa93a3887d05096c0a1f3f9f7`, `LICENSE`, `rules/**/*.yaml` and agent/enforcement documentation | Apache-2.0 source pinned; 51 built-ins enumerated. OpenCode is monitor-only. Three command rules are proposed; chains, content rules, path-sensitive rules and Git configuration/hook rules remain unaccepted. | Complete 48 per-rule decisions, provenance/modification plan, fixtures and security/legal review. | Product/security approval of the first subset required. |

## Verification gates

### Automated

- deterministic rule loading and evaluation;
- malformed, duplicate and unsupported rule rejection;
- positive, negative, ambiguous, bypass and false-positive fixtures per rule;
- single-event and ordered-sequence isolation by tenant/machine/session;
- requested-action versus observed-outcome assertions;
- `off`, `monitor_match`, `unavailable` and evaluator-error behavior;
- no raw content or secret value in findings, logs, errors, metrics or audit;
- size, expression, sequence-window, memory and latency bounds;
- immutable rule/version provenance on queued findings;
- offline persistence, replay deduplication and partial acknowledgement;
- revoked credential, repository/branch denial and cross-tenant rejection;
- administrator/auditor access and ordinary-user denial;
- Task2 lifecycle, Task4 security and Task5 privacy/deletion regressions.

### Manual/live

1. Enable monitor mode for a controlled tenant and keep another tenant off.
2. Run one benign non-match, one reviewed match and one ambiguous case.
3. Verify the coding action is not blocked and the UI says monitor-only.
4. Verify findings contain only the approved metadata fields.
5. Disconnect the network, restart the client and confirm durable delivery once.
6. Revoke repository, machine and credential access independently and confirm
   server denial remains authoritative.
7. Attempt Company A/Company B crossing and confirm isolation in both directions.
8. Exercise an unsupported host/route and verify `unavailable`, not a false
   prevention claim.
9. Capture client, API and UI logs and verify no customer content or secret.
10. Disable monitoring and verify new findings stop without rewriting history.

## Completion boundary

The initial Task6 Security release completes when S6.1–S6.6 pass for the exact
supported agent/host/OS matrix, privacy-safe monitor findings work end to end,
and Task2/Task4/Task5 regressions remain green. S6.7 blocking is optional and
does not block the monitor-only release.

Customer-authored rules, organization policy, dynamic signed bundles and
general enforcement remain deferred to [`TASK6_POLICY.md`](TASK6_POLICY.md).
