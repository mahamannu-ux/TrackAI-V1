# Task6 — Security and Policy Split

**Compatibility index and decision record**

Last updated: **2026-09-26**

Task6 was split because coding-agent security can deliver customer value without
first building the much larger organization-policy control plane.

## Canonical trackers

| Track | Status | Canonical document |
|---|---|---|
| **Task6 Security** | **Active** — local, privacy-safe, monitor-only coding-agent security | [`TASK6_SECURITY.md`](TASK6_SECURITY.md) |
| **Task6 Policy** | **Deferred** — customer-driven organization policy and signed distribution architecture | [`TASK6_POLICY.md`](TASK6_POLICY.md) |

## Where the former combined sections moved

| Former subject | Canonical destination |
|---|---|
| Numbat findings, normalized security events, rule provenance, monitor/enforce distinction and host capability | Task6 Security |
| Capture, upload, redaction, retention, access and export policy | Task6 Policy |
| Cedar-like authorization, inheritance, precedence, exceptions, approvals and simulation | Task6 Policy |
| Signed bundles, trust roots, distribution, epochs, rollback, last-known-good activation and policy rollout | Task6 Policy |
| Task4 migration and client/server policy enforcement architecture | Task6 Policy |
| Security findings, privacy-safe upload and Security verification | Task6 Security |

Task4 remains authoritative for tenant, machine, repository, branch,
credential, delivery and server-admission contracts. Task5 remains authoritative
for the fixed evidence privacy floor. Neither tracker may weaken those controls.

This file intentionally contains no duplicate architecture. Existing links may
continue to target it, while new work should link directly to the appropriate
canonical tracker.
