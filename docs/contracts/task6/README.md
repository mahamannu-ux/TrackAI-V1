# Task6 Security 0.1 data contracts

Status: **Approved Wave 2 contracts; not connected to runtime**

Last updated: **2026-09-29**

Fixture vocabulary approval recorded: **2026-09-29**

Contract-boundary approval recorded: **2026-09-29**

These versioned JSON Schemas turn the approved Wave 2 vocabulary into files a
schema validator can check. They do not add detection, upload, storage, policy
or blocking behavior.

| File | Purpose | Privacy rule |
|---|---|---|
| `security-event.schema.json` | Local event used for on-device evaluation | Its `input` is temporary and must remain on the device. |
| `security-finding-upload.schema.json` | Small client batch allowed to cross the Task4 delivery boundary | Tenant and machine identity are omitted and derived by the authenticated server; unknown fields are rejected. |
| `security-finding.schema.json` | Final finding after authenticated server enrichment | Unknown fields are rejected, including raw commands, paths, URLs and outputs. |
| `rule-fixtures.schema.json` | Closed format for the 32 approved rule and safety cases | Uses safe normalized facts, not executable command strings. |
| `fixtures/manifest.json` | Lists safe examples and their expected result | Valid examples contain placeholders; invalid examples prove raw content and blocking are rejected. |

## Fixed first-release limits

| Area | Allowed in 0.1 |
|---|---|
| Route | `AC-CLI-03` only |
| Agent | OpenCode in terminal CLI mode |
| Customer effect | `monitor` only |
| Approved rules | The three rules approved on 2026-09-29 |
| Server content | Authorized IDs and bounded categories only |

The schemas use JSON Schema Draft 7 so the repository's installed validator can
check them without adding a new dependency. The fixture manifest records the
expected result for every valid and invalid contract example, including
raw-content and client-identity rejection.

These are contract checks only. All 32 approved rule-behavior cases are now in
one machine-checkable fixture set. A future S6.3 evaluator test harness must
consume them without weakening or silently changing their expected outcomes.
Any schema or expected-result change requires another product/security review.
