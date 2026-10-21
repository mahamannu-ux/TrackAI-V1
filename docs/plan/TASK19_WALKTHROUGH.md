# Task19 founder walkthrough (T19.9)

*Written 2026-10-21 by the Task19 lead (Claude) for the joint sitting with Task20j. Task20j's runbook, `docs/plan/TASK20_ACCEPTANCE.md` (to be written by Task20j), links here. Symbols per AGENTS.md §11. **Results are recorded in `docs/plan/TASK19.md`** (§3 status symbols and §8 "T19.9 results"), not in this file.*

## What T19.9 covers

**Ten questions, code and security, five each**, in rank order. Each one is checked in the **Questions** screen, as the admin (live answers) and as the auditor (verifiable or signed answers), for Company A, with Company B as the isolation check.

| # | Question | Why it is in the ten |
|---|---|---|
| 1 | **Q3** share of merged changes that were AI-assisted, by tool and model | Code rank 1 |
| 2 | **Q1** share of changed lines that were AI-generated | Code rank 2 |
| 3 | **Q4** AI tools and models that touched production, and approval | Code rank 3 |
| 4 | **Q11** security findings behind AI code | Code rank 4; joins code and security |
| 5 | **Q7** proof the records were not changed | Code rank 5; auditor only |
| 6 | **S1** register of high and critical findings, provably complete | Security rank 1; auditor answers only (no live answer yet) |
| 7 | **S7** repositories most affected by findings, versus the previous period | Highest-ranked security question with a live answer |
| 8 | **S19** AI agents installed on machines | Founder's Numbat rank 1; data from this sitting's Endpoints |
| 9 | **S20** what the day-one scan found | Founder's Numbat rank 2; data from this sitting's day-one scan |
| 10 | **S26** permission requests, approvals and denials | Founder's Numbat rank 3; data from this sitting's agent use |

S2–S4 are skipped: they have no live answer yet. Step 13 checks that one of them is honestly unavailable.

## Before the sitting
1. **Company A and Company B tenants, each with one admin and one auditor** (the Task20j stack).
2. **A GitHub test repository with the TrackAI GitHub App installed for Company A: yes, required.**
   - Q3, Q1, Q4 and Q11 read commits with Git AI notes and merged pull requests, which arrive through the App's webhooks.
   - GitHub events never reach `localhost` (AGENTS.md §9 item 13), so use a tunnel or the reconciliation command, as in Task19g's step 4.
   - The repository needs **one merged PR containing at least one AI-assisted commit** made with an agent Task20 monitors (Claude Code, Codex or Cursor), so that the same session also produces Numbat events.
   - Company B needs **no** GitHub App: it is the isolation tenant.
3. **Attesta on the local stack** for the auditor answers: statements built and anchored, and one period report for Company A's test repository covering the sitting's period. Use the commands in `docs/handoffs/Task15n-attesta-live-gates_HANDOFF.md`, with no new setup.
4. **Task20j's endpoint steps** produce the security data: the day-one scan (opt-in in Company A's data settings), at least one finding, and at least one permission request that the founder approves and one that he denies.

## Steps
Period: **Last 30 days** in the Questions screen, unless a step says otherwise. "Recorded / partial / unavailable" is the status badge on each answer and figure.

| Step | Role | Question | Expected answer |
|---|---|---|---|
| 1 | Admin A | Q3, live | **Recorded or partial.** `merged_ai_lines` is greater than 0 for the test repository; the breakdown by model includes the agent's model, or `unknown` with the "some model identities are unknown" note |
| 2 | Auditor A | Q3, verifiable, then signed | Verifiable: the same figure family, with "N statements" evidence and a verify action. Signed: the period report's digest. Live is **not offered** to the auditor |
| 3 | Admin A | Q1, live | `ai_share_of_changed_lines` is a ratio (shown as a percentage). `ai_share_of_repository` is **unavailable**, "This information is not being captured yet." (G1) |
| 4 | Admin A | Q4, live | `models_in_production` and `production_ai_lines` are shown. `approved_at_the_time` is **unavailable** (G2) |
| 5 | Admin A, then Auditor A | Q11 | Admin live: the note "Links between sessions and findings are partial.". Auditor verifiable: answers, with evidence |
| 6 | Auditor A | Q7, verifiable | **Recorded:** the chain is intact, with a verify action. There is no live kind |
| 7 | Auditor A | S1, verifiable, then signed | The high/critical findings register for the period, with the note "Observed in monitor mode; nothing was blocked." and evidence. Signed: the security period report |
| 8 | Admin A | S7, live | Counts by repository, category and severity, with the previous period beside them, and the same "Observed in monitor mode" note |
| 9 | Admin A | S19, live | `machines_reporting` ≥ 1, and `agents_detected` and `agents_wired` match what Task20j installed. `agent_versions` is **unavailable** ("The provider does not report this information."). `agents_not_on_approved_list` is **unavailable** (G2) |
| 10 | Admin A | S20, live | `machines_scanned` ≥ 1 and `findings_at_rest` is shown. An agent with no session files appears under **"scans with no session files found for this agent"**, not as a failure. "Requested actions are not confirmed outcomes" is shown |
| 11 | Admin A | S26, live | `permission_approved` ≥ 1 and `permission_denied` ≥ 1, matching what the founder did, and `approval_rate` as a ratio. `sessions_with_finding_and_approval` is **partial** ("Some related records cannot be linked with confidence.") |
| 12 | Auditor A | S19, S20, S26 | Live is **not offered**. They have only a live kind, so the screen offers the auditor no answer for them, and a direct `kind=live` API call gets **403** |
| 13 | Admin A | S3, live | **Unavailable**, "This answer has not been built yet.", never zero |
| 14 | Admin B | Q3, S19, S26, live | None of Company A's repositories, machines or counts appear. S19 and S26 show only Company B's own Endpoint data, or **unavailable** (S19: "This platform or activity is not monitored.") if B has none |
| 15 | Admin B | Q3 with Company A's repository id in the URL (`…/answer?kind=live&repository_id=<A's id>`) | **404** `QA_SCOPE_NOT_FOUND`, exactly as for an unknown id. Never 403, and no data |

Throughout, check: no prompt, command, file path, URL, domain, login or email appears in any answer or drill-down.

## Pass rule
- **Pass:** all fifteen steps match.
- A step that does not match is recorded in `TASK19.md` §8 with the question, the role and what was seen. The lead turns it into a fix.
- Each passed question's **Live** or **Auditor** cell in `TASK19.md` §3 moves to ✅ only for the audience the step checked (live for admins; verifiable or signed for auditors).
