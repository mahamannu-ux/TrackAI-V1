# Task20 lead checkpoint (2026-10-19): state for a fresh lead chat

Written by the Task20 lead (Claude) so a new lead chat can take over. Start the new chat with `docs/prompts/Task20/NEXT_CHAT_Task20-lead_PROMPT.md`, then read this file, `docs/plan/TASK20.md` and `docs/plan/primers/Task20_PRIMER.md`.

## Sessions
| Session | Agent | State |
|---|---|---|
| Task20a contract, 20b Numbat build, 20c trust verifier, 20d ingest v2, 20e shipper, 20f settings and signing | Codex, Muse, Claude | merged |
| Task20f1 signing-test cap fix (PR #85) | Claude | merged |
| Task20g Endpoint policy apply (GitAI #10) | Codex | merged |
| Task20i-a security reads (PR #89/#90) | Muse | merged |
| **Task20h-a** package and install | Codex + founder Mac | prompt merged (PR #92); not started or running |
| **Task20i-b** security console | OpenCode/VS Code agent | prompt in this PR; can start now |
| Task20h-b inventory upload (S19) and day-one scan (S20) | Muse | prompt not written; write after Task20h-a's checkpoint fixes the binary path and hook lines |
| Task20j acceptance, 20k enforce pilot, 20l rule wave 2 | see TASK20.md §5 | later |
| Related, other Tasks: Task19c (merged, #87), Task19e (merged), Task15op-a/b (merged), Task16h A16.13a/b (Task16 lead writes it) | | |

## Decisions made in the lead chat after the plan (all recorded in prompts or here)
1. Signer cap is 4 MiB + 1 KiB (Task15op0); no settings combination reaches it.
2. Trust documents reach the Endpoint in the package (Task20h-a) in phase 1; distributing new key sets without a reinstall is phase 2. The release root pin list stays empty until Task15n's production root exists, so release builds stay off.
3. `monitor_and_pilot_block` is applied as monitor on the Endpoint until Task20k.
4. Previews (decrypted command, path, URL) are deferred to phase 2 in reads and console.
5. Task20i-a audit details stay `{limit, returned}` (frozen audit contract); route and filter names need a Task16 audit-contract PR (phase 2).
6. Detail-route indicators are "nearby on this machine, not linked"; URL and email values hidden.
7. Before the first bundle and while off, Numbat's hooks point at a placeholder rule set (Copilot CLI denies on a hook crash). Off still writes previews to the developer's own `~/.numbat/records.ndjson`; TrackAI does not upload them (phase 1, stated in the README).

## Open follow-ups for the lead
- **S19–S26 are not in the Q&A registry yet.** Founder ranks them (recommendation below); then a small Task19 session adds them to `docs/contracts/qa/questions.md` and the registry (an additive contract change) and registers answerers as data appears: S26 (permission events, stored since Task20d) and S23 (indicators, collected only when a tenant turns the `urls` data setting on) can be answered now; S19 and S20 after Task20h-b; S21 partly (one of its rules is in the deferred wave 2); S22 needs MCP config capture (check Numbat's inventory output in Task20h-b); S24 after Task20k; S25 (signed case bundles) is deferred with Task15's case-bundle work.
- Recommended ranking: S19, S20, S26, S23, S21, S22, S24, S25.
- GitAI backlog row G8 closed by Task20c: update TrackAI's `GITAI_FUTURE_TODO.md` if not done.
- `GET /coverage` runs six queries per machine; batch when fleets grow.
- A lease refused as `VERIFICATION_UNAVAILABLE` is not retried until the server issues a new lease (about an hour).
- TASK20.md rows T20.9 (Task20g merged), T20.7b (Task20i-a merged) and STATUS_BOARD's Task20 row need updating by the lead after each merge.
