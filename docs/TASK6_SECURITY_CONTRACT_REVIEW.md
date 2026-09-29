# Task6 Security contract review

Status: **Ready for product/security approval**

Last updated: **2026-09-29**

This review covers what TrackAI may understand locally and what it may send to
the server. The exact schemas are under [`contracts/task6`](contracts/task6/README.md).

| Example | Local computer may use | Server may receive |
|---|---|---|
| Large deletion request | Temporary command details needed to evaluate the rule | Rule name, severity, “requested,” approved IDs and time |
| Download followed by execution request | Temporary pipeline structure | Safe alert category only; no command or URL |
| Result was not observed | Request details plus the missing-result state | “Requested; result not observed” |
| Information is incomplete | Available partial details | “Unavailable” or no finding; never “safe” |

## Fixed safety limits

| Limit | Version 0.1 decision |
|---|---|
| Customer action | Monitor and alert only |
| Raw commands, paths, URLs or output on server | Rejected |
| Unsupported agent route | Report unavailable |
| Claim that TrackAI blocked an action | Rejected |
| Initial route | OpenCode terminal route `AC-CLI-03` only |

Approval means these boundaries may be used by a future S6.3 evaluator. It does
not approve an evaluator, upload path, policy engine or blocking.
