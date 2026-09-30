# Task6 Security remaining-rule review

Status: **Approved**

Last updated: **2026-09-29**

Approval recorded: **2026-09-29**

The first three rules are already approved. This review covers the other 48
Numbat candidates. The detailed rule-by-rule record remains
[`TASK6_SECURITY_RULE_INVENTORY.md`](TASK6_SECURITY_RULE_INVENTORY.md).

| Recommendation | Count | Simple reason | Example |
|---|---:|---|---|
| Wait for multi-step tracking | 6 | TrackAI cannot yet safely connect several actions over time. | Reading a secret and later sending data elsewhere. |
| Wait for better command understanding | 15 | Similar-looking commands can be either normal work or harmful. | Administrator tools, tunnels and system cleanup. |
| Wait for safer path handling | 10 | Home folders, operating systems and linked worktrees use different paths. | Private keys, startup files and scheduler files. |
| Wait for better agent evidence | 8 | OpenCode does not yet provide enough reliable information. | Cloud metadata, secret-manager and container activity. |
| Wait because normal product work looks similar | 7 | GitAI or ordinary development legitimately performs these actions. | Installing Git hooks, changing remotes or reading `.env`. |
| Leave out of version 0.1 | 2 | The rules depend on Numbat state or a blocking policy TrackAI does not have. | Changing Numbat detector state or disabling host guardrails. |
| **Total** | **48** | **Defer 46; exclude 2.** | **Do not implement these in the first release.** |

## Recommendation

The grouped decisions above were approved on 2026-09-29. Version 0.1 remains
limited to the three high-signal monitor-only rules, avoiding alerts that are
incomplete, misleading or triggered by normal development work.

Approval does not permanently reject the 46 deferred candidates. Each can
return through a later review after its missing evidence, parser, path handling,
sequence safety or false-positive tests exist. The two excluded candidates need
a new TrackAI-specific design before reconsideration.
