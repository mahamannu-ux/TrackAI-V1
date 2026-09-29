# Task6 Security 0.1 data contracts

Status: **Review artifacts; not connected to runtime**

Last updated: **2026-09-29**

These versioned JSON Schemas turn the approved Wave 2 vocabulary into files a
schema validator can check. They do not add detection, upload, storage, policy
or blocking behavior.

| File | Purpose | Privacy rule |
|---|---|---|
| `security-event.schema.json` | Local event used for on-device evaluation | Its `input` is temporary and must remain on the device. |
| `security-finding.schema.json` | Small finding allowed to cross the Task4 delivery boundary | Unknown fields are rejected, including raw commands, paths, URLs and outputs. |
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
check them without adding a new dependency. The fixture manifest expects the
two `valid-*` files to pass and the two `invalid-*` files to fail.

These are contract checks only. All 32 approved rule-behavior cases are now in
one machine-checkable fixture set. A future S6.3 evaluator test harness must
consume them without weakening or silently changing their expected outcomes.
