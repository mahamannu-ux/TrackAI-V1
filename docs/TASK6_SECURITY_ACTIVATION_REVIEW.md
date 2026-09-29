# Task6 Security activation review

Status: **Ready for product/security approval**

Last updated: **2026-09-29**

The local evaluator works, but it is not connected to live OpenCode requests.
The tenant administrator must remain the authority for `off` or `monitor`.

| Situation | Proposed behavior |
|---|---|
| Authorized tenant setting is `monitor` | Evaluate the request locally and produce a safe monitor result. |
| Authorized tenant setting is `off` | Do not produce a security finding. |
| Setting is missing, expired or revoked | Stay off and report capability unavailable; never claim protection. |
| Local file or environment asks for `monitor` | Ignore it in production; it cannot override the tenant setting. |
| Automated test supplies `monitor` | Allow test-only injection without changing production activation. |

Raw commands remain on the computer in every mode. No finding upload, server
storage, blocking or Policy engine is part of this approval.

Recommendation: approve this boundary, but keep the production hook disconnected
until a tenant-authorized setting can reach GitAI through the existing managed
credential and machine scope.
