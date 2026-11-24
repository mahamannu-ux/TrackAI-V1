# Task20 lead checkpoint (2026-10-22): state for a fresh lead chat

Written by the Task20 lead (Claude). Start the new chat with `docs/prompts/Task20/NEXT_CHAT_Task20-lead_PROMPT.md`, then read this file, `docs/plan/TASK20.md`, `docs/plan/TASK20_ACCEPTANCE.md` and the previous checkpoint `Task20-lead-checkpoint-2026-10-19_HANDOFF.md`. This file supersedes the earlier one where they differ.

## Sessions
| Session | Agent | State |
|---|---|---|
| Task20a–20i, 20h-a (GitAI #11), 20h-b, 20i-b | Codex, Muse, Claude | merged |
| Task20j-fixes-gitai (lease skew ±60 s on placeholder too, day-one 24-attempt cap, SYNC.md) | Codex | merged (GitAI PR #14) |
| **Task20j-acceptance** | Codex + founder | Checkpoint 1 corrections reviewed (TrackAI `a4155ee` + five runbook fixes: real E20-08 corruption, real work in the week, E20-09 at install, order with the 72 h E20-07 outage last, "Review changes" label). Founder's seven-day run (E20-W) starting 2026-10-22 on the everyday account; local stack `trackai-task20j-pg` port 55432, API 8080, private dir `~/AIProjects/TrackAI-wt/_task20j-week-private` (never delete). Next: the sitting, T19.9 by link, IT sweep, close-out docs (Stage 5). |
| Task17 (GitAI upstream sync) | Codex leads; Task20 lead = product reviewer | Plan branch `docs/Task17-plan` reviewed at `6f67802` (three plan changes requested, see below). **Each review group needs the lead's verdict before its port**; daemon and telemetry waves also need code review of Task20's shared files. |
| Task14a-supabase-database | Codex + founder | prompt `docs/prompts/Task14/NEXT_CHAT_Task14a-supabase-database_PROMPT.md` (uncommitted in the founder's clone); must finish before Task17d's Lab runs. |
| Task9f, Task15n | Codex, other leads | 9f item 3 waits for the end of the week (machine-wide Numbat); 15n then 9f item 4 (signed package, IT-T20f-02). |

## Decisions since 2026-10-19
1. Placeholder = one enabled `expr: 'false'` rule plus 51 disabled same-id overrides; hooks run **with** built-ins; bundles are compact. Never `--no-builtin-rules`.
2. Health layers: `agent_effective_view` stays `unavailable` (hand-checked); `local_record` and `forwarder_ack` from durable tail and upload evidence. Console words: Healthy / Failed / Not checked by the Endpoint / Not reported.
3. Hook latency budget: each hook p95 ≤ 50 ms on the Intel Mac (founder-approved 2026-10-21). Record stripped release binary sizes at close-out.
4. E20 rows defined in the Task20j prompt and runbook (E20-01…12, E20-R rule proof, E20-W week). Testing beyond the five managed agents goes to Task18.
5. Inventory reports `version: null` (Numbat has none); S22 is partial (no MCP config capture). A zero-artifact scan shows "no session files found"; an agent without a summary is "not scanned".
6. Task17: TokenUsage v2 deferred to Task13's checkpoint as product candidate "token and cost reporting" (ccusage MIT); synthetic reflog attribution rejected; no deferrals to finished Tasks; packaging rows owned by Task9f.

## Task17 plan changes requested (6f67802)
1. Waves 1 and 3 must keep `spawn_security_shipper_worker` (`src/daemon/telemetry_worker.rs:489`) behaviour unchanged (2 s tick: policy refresh, shipper poll, status, inventory, flush, day-one spawn); `7b0eead75` restructures that module. Add a wiring test.
2. `ce5c08ceb`/`8824a16b7` add daemon health to the uploaded heartbeat: a TrackAI telemetry contract change (server, privacy). Keep it local-only in Task17 or plan a contract PR; not silently.
3. `d119b617f`/`04d87b7cd` change `bg status`; `mdm/macos/cleanup-endpoint.sh:100-101` greps `"daemon_running": false`. Keep the field or update the script, with an offboarding check in the gates.

## Open follow-ups for the lead
- Review Task20j's sitting results and Stage 5 docs (TASK20 §2/§6/§7/§8, AGENTS.md §9 items 9 and 11).
- Task17 group reviews, in order: daemon reliability, agent/config, telemetry, attribution.
- Uncommitted in the founder's clone (commit with the next docs PR): Task17, Task14a, Task20h-b and Task20j prompts; `scripts/clean-merged-worktrees.sh`.
- Later Task20 items: Task20k (blocking pilot, needs root helper), Task20l (rule wave 2), the agent coverage wave (in Task18), `GET /coverage` batching at fleet scale.
