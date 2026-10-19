# Q&A question registry (generated)

<!-- Generated from apps/api/src/features/qa/registry.ts by `npm run qa:registry -w apps/api`. Do not edit by hand: a unit test fails when this file is out of date. -->

Registry version 3. 46 questions, 17 gaps. Rules: `README.md` in this folder; the source catalogue is `docs/plan/CUSTOMER_AUDITOR_QA.md`.
Every security answer carries `monitor_only_observed`. No scope or dimension names a person.

## Code questions

| Id | Rank | Phase | Question | Auditor | Kinds (builder) | Gaps | Scopes | Dimensions | Previous period | Wording |
|---|---|---|---|---|---|---|---|---|---|---|
| Q3 | 1 | 1 | Over a period, what share of merged changes in a repository were AI-assisted, by tool and model? | yes | live (T19.3), verifiable (A16.13a), signed (Task15i4) | — | tenant, repository | model, tool, repository | no | unknown_model_explicit |
| Q1 | 2 | 1 | What share of a repository's code was AI-generated as of a date (today: the share of lines changed in a period)? | yes | live (T19.3), verifiable (A16.13a), signed (Task15i4) | G1 | tenant, repository | repository | no | — |
| Q4 | 3 | 1 | Which AI tools and models touched production code, and was each approved at the time? | yes | live (T19.3), verifiable (A16.13a) | G2 | tenant, repository, commit | model, tool, repository | no | unknown_model_explicit |
| Q11 | 4 | 1 | Did the AI sessions behind this code raise security findings, and of what kind? | yes | live (T19.3), verifiable (A16.13a) | G10 | tenant, repository, pull_request, commit | rule_category, severity, repository | no | monitor_only_observed, session_link_partial |
| Q7 | 5 | 1 | Can you prove these records were not changed after the fact? | yes | verifiable (A16.13a) | — | tenant, repository | — | no | — |
| Q16 | 6 | 1 | Export everything for a repository and period, verifiable offline without TrackAI. | yes | verifiable (A16.13a) | — | tenant, repository | — | no | — |
| Q5 | 7 | 1 | Was AI-generated code reviewed by someone other than its author before merge? | yes | live (T19.3), verifiable (A16.13a) | G3 | tenant, repository, pull_request | repository | no | — |
| Q13 | 8 | 1 | How complete is the evidence? Which commits have no AI attribution (no Git AI note, unenrolled machine, unknown lines)? | yes | live (T19.3), verifiable (A16.13a), signed (Task15i4) | — | tenant, repository, commit | repository | no | — |
| Q9 | 9 | 1 | Which AI-assisted changes reached production, when, and through which deployment? | yes | live (T19.3), verifiable (A16.13a), signed (Task15i4) | — | tenant, repository, pull_request | repository | no | merged_not_deployed_proxy |
| Q14 | 10 | 1 | For one pull request, show the chain: prompt, session, commits, pull request, merge, deployment. | yes | live (T19.3), verifiable (A16.13a) | — | pull_request | — | no | metadata_only |
| Q12 | 11 | 1 | What policy was in force for a repository when this change was made? | yes | live (T19.3), verifiable (A16.13a) | G2 | repository, commit | — | no | — |
| Q2 | 12 | 1 | For one line of a file at a commit or date: was it written by AI, by which agent, model and session, and when? | yes | live (Task19d), verifiable (not scheduled) | — | commit | — | no | metadata_only |
| Q6 | 13 | 1 | Who committed, and who merged, each AI-assisted change? | yes | live (T19.3), verifiable (A16.13a) | G4 | repository, pull_request | repository | no | — |
| Q8 | 14 | 1 | When did TrackAI first see this commit, and was the evidence signed then, not rebuilt later? | yes | verifiable (A16.13a) | — | commit | — | no | — |
| Q15 | 15 | 1 | Did any AI-assisted code come from a machine or repository without a valid grant, and was it rejected? | yes | live (T19.3), verifiable (A16.13a) | G5 | tenant, repository | repository, machine | no | — |
| Q10 | 16 | 1 | How much AI code was reworked or deleted before merge, and by AI or by a human? | partly | live (T19.3) | — | tenant, repository, pull_request | repository | no | churned_unavailable |
| Q19 | 17 | 1 | What is the AI acceptance rate (generated, kept, committed)? | no | live (T19.3) | — | tenant, repository, pull_request | model, tool, repository | no | — |
| Q18 | 18 | 1 | What did AI cost (tokens, money) per repository, pull request and model? | no | live (T19.3) | — | tenant, repository, pull_request | model, tool, repository | no | — |
| Q20 | 19 | 1 | Which teams use AI most, and how is it changing? | no | live (T19.3) | — | tenant | team, repository | yes | — |
| Q17 | 20 | 2 | Did AI bring third-party or open-source snippets in (licence risk)? | yes | live (not scheduled), verifiable (not scheduled) | — | tenant, repository | repository | no | — |

## Security and policy questions

| Id | Rank | Phase | Question | Auditor | Kinds (builder) | Gaps | Scopes | Dimensions | Previous period | Wording |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 1 | 1 | Give me the register of every high or critical security finding in a period, across all repositories, and prove none was added, changed or removed afterwards. | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G6, G9 | tenant, repository | rule, rule_category, severity, repository | no | monitor_only_observed |
| S2 | 2 | 1 | Was monitoring actually on? Which machines and repositories were covered in a period, and where were the gaps? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G7 | tenant, repository | machine, repository, operating_system | no | monitor_only_observed |
| S3 | 3 | 1 | Did anyone switch off or tamper with the guardrails in a period? | yes | live (T19.4), verifiable (A16.13b) | G8, G9 | tenant | machine, repository | no | monitor_only_observed |
| S4 | 4 | 1 | Did any AI agent read secrets or credentials, and did data leave the machine afterwards? | yes | live (T19.4), verifiable (A16.13b) | G9 | tenant, repository | rule, machine, repository | no | monitor_only_observed |
| S5 | 5 | 1 | For one finding, show the chain: machine, session, agent and model, repository, the commits and pull requests it produced, deployed? | yes | live (T19.4), verifiable (A16.13b) | G6, G10 | tenant, repository | — | no | monitor_only_observed, session_link_partial, metadata_only |
| S6 | 6 | 1 | Did code from a session that raised a high or critical finding get merged or reach production? | yes | live (T19.4), verifiable (A16.13b) | G10 | tenant, repository | repository, severity | no | monitor_only_observed, session_link_partial |
| S7 | 7 | 1 | Which repositories were most affected, by category and severity, and how does the period compare with the previous one? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G6 | tenant | repository, rule_category, severity | yes | monitor_only_observed |
| S8 | 8 | 1 | Which agent or tool, and which model, produced the most findings? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G10 | tenant, repository | agent_family, model | no | monitor_only_observed, unknown_model_explicit, session_link_partial |
| S9 | 9 | 1 | Which platforms (macOS, Linux, Windows, WSL) produced the most findings, and in which categories? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | — | tenant | operating_system, rule_category | no | monitor_only_observed |
| S10 | 10 | 1 | Which rule-pack and detector versions were in force on each machine when findings occurred, and were machines up to date? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G6, G7 | tenant, repository | machine | no | monitor_only_observed |
| S11 | 11 | 1 | Which findings were confirmed outcomes, and which were only requested actions? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G6 | tenant, repository | rule | no | monitor_only_observed, requested_not_confirmed |
| S12 | 12 | 1 | Was anything blocked or prevented, and under which policy version? | yes | live (T19.4), verifiable (A16.13b), signed (Task15p) | G6 | tenant, repository | repository | no | monitor_only_observed |
| S13 | 13 | 1 | What organization policy was in force on each machine when a finding occurred, and did the machine hold a valid activation lease? | yes | live (T19.4), verifiable (A16.13b) | G2, G11 | tenant, repository | machine | no | monitor_only_observed |
| S14 | 14 | 1 | Which policy exceptions or waivers were granted, for how long, and which findings fell under them? | yes | live (T19.4), verifiable (A16.13b) | G12 | tenant | rule | no | monitor_only_observed |
| S15 | 15 | 1 | Who looked at security findings and raw evidence in a period, and is that trail tamper-evident? | yes | live (T19.4), verifiable (A16.13b) | — | tenant | — | no | monitor_only_observed |
| S16 | 16 | 1 | How fast were findings triaged and remediated (time to acknowledge, time to close)? | partly | live (T19.4), verifiable (A16.13b) | G13 | tenant, repository | severity, rule | no | monitor_only_observed |
| S17 | 17 | 1 | Which machines (or teams) generate repeated findings? | partly | live (T19.4) | — | tenant, repository | machine, team | no | monitor_only_observed |
| S18 | 18 | 1 | Which rules fire most, and which are noisy (findings later marked benign)? | no | live (T19.4) | G13 | tenant | rule | no | monitor_only_observed |
| S19 | 19 | 1 | Which AI coding agents are installed on our machines, and which are not on the approved list? | yes | live (T19.4) | G14 | tenant | agent_family, operating_system, machine | no | monitor_only_observed |
| S20 | 20 | 1 | Were we already exposed before TrackAI arrived? What did the day-one scan of existing agent sessions find? | yes | live (T19.4) | G14 | tenant | rule_category, severity | no | monitor_only_observed, requested_not_confirmed |
| S26 | 21 | 1 | How often do agents ask permission, how often do developers approve or deny, and did sessions with findings get approvals? | yes | live (T19.4) | — | tenant | agent_family | no | monitor_only_observed, requested_not_confirmed |
| S23 | 22 | 1 | Which external domains, URLs and addresses did agents reach in a period? | partly | live (T19.4) | — | tenant | agent_family | no | monitor_only_observed, metadata_only |
| S21 | 23 | 1 | Which agents ran in reduced-approval or bypass modes, and how often? | yes | live (T19.4) | G16 | tenant | agent_family | no | monitor_only_observed |
| S22 | 24 | 1 | Which MCP servers are configured and used by agents, and did any send data out? | yes | live (T19.4) | G15 | tenant | agent_family | no | monitor_only_observed |
| S24 | 25 | 1 | What did we block, under which settings version, and what did the developer do next? | yes | live (T19.4) | G17 | tenant | rule, agent_family | no | monitor_only_observed |
| S25 | 26 | 2 | Give me a signed incident case for one session. | yes | signed (not scheduled) | — | tenant | — | no | monitor_only_observed |

## Gaps

| Gap | What is missing | Owner | Open | Questions |
|---|---|---|---|---|
| G1 | Repository and path line-count snapshot | Task2 + GitAI | yes | Q1 |
| G2 | Organization AI-usage policy (approved tools and models) | Task6.b | yes | Q4, Q12, S13 |
| G3 | Pull request review and approval capture | Task2 (semantics), Task7 (other providers), Task4 (delivery) | yes | Q5 |
| G4 | merged_by on pull requests | Task2 | no | Q6 |
| G5 | Content-free rejection audit event for refused uploads | Task4 (capture), Task16 (expose), Task15 (count) | no | Q15 |
| G6 | Security findings signed on their own (finding_observed) | Task15 (Task15o), Task6 (outbox row) | yes | S1, S5, S7, S10, S11, S12 |
| G7 | Monitoring coverage history | Task6 + Task9 (capture), Task15 (signed) | yes | S2, S10 |
| G8 | Security-monitor setting writer and audit event | Task6 (writer), Task16 (event) | yes | S3 |
| G9 | Rule coverage beyond three execution rules | Task6.a (rule selection overseen by T19.7) | yes | S1, S3, S4 |
| G10 | Model and session key on a finding | Task6 + Task2 | yes | Q11, S5, S6, S8 |
| G11 | D6.1 activation lease issue and refuse events | Task6.b | yes | S13 |
| G12 | Policy exceptions and waivers | Task6.b | yes | S14 |
| G13 | Finding triage, disposition and remediation state | Task6 (state), Task16 (event), Task10 (UI) | yes | S16, S18 |
| G14 | Agent inventory and day-one scan uploads from the endpoint | Task20 (Task20h-b) | yes | S19, S20 |
| G15 | MCP server configuration and per-call MCP identity on findings | Task20 (later) | yes | S22 |
| G16 | Deferred rule wave 2 (the 7 normal-development rules, including exec.agent_runtime_bypass_flags) | Task20 (later wave) | yes | S21 |
| G17 | Opt-in blocking pilot (enforcement decisions) | Task20 (Task20k) | yes | S24 |
