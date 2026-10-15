# Customer and auditor Q&A

*Renamed 2026-10-14 from `ATTESTA_QUESTIONS.md`; the old path is now a one-line pointer here, because frozen contracts and old handoffs link it. Written 2026-10-11 by the Task15 lead (Claude), working backwards from the customer and the auditor, as the founder asked. Task2's answers added by Codex on 2026-10-12 (audited against `main` at `bb617f6`). Security and policy questions S1–S18 added 2026-10-14 by the Task16 lead. **Owner from 2026-10-14: Task19** (`docs/plan/TASK19.md`), which turns every row to answerable. Input to A15.0, to the admin Q&A (T10.9, now Task19 T19.5) and to the auditor Q&A (Task16 A16.13). A new question is added here first, with its rank, auditor flag, data check and owner. Symbols per AGENTS.md §11.*

## How to read this

- **Rank**: customer priority and impact, 1 = asked first. Code questions keep their `Q` ids, so links stay valid; security questions are numbered in rank order (S1 = rank 1).
- **Auditor**: "yes" means an auditor (SOC 2, ISO 42001, acquirer's counsel, insurer) would ask it, so the answer must be **provable** (see the three kinds of answer below). "no" means an admin or engineering question that needs no proof.
- **Data today**: whether TrackAI **stores** what the answer needs: ✅ stored; 🟡 partly; ⬜ not captured. It says nothing about whether an answer exists yet: **no Q&A query or screen exists for any row**, even a ✅ one. Task2's lifecycle dashboards show some figures (Q3, Q19), but not as answers to these questions.
- **Lives in**: what has to be in a signed predicate for the answer to be provable, or "live query" when a dashboard is enough.
- **Answered by**:
  - *live query*: buildable now from stored data;
  - *new capture*: a gap must be closed first; the gap id is in "Notes", and its owner is in "Gaps found";
  - *Attesta*: built by Task15;
  - *phase 2*.

  A 🟡 row usually has a gap. Some do not: their data is complete enough, but the query is hard (Q2's lineage walk), or a limit is permanent and must be shown honestly (Q11's monitor-only wording, Q18's vendors that report no usage).

### Three kinds of answer

| Kind | What it is | Proves | Who gets it | Built in |
|---|---|---|---|---|
| **Live** | A query over today's tables | Nothing: it shows what TrackAI knows **today** | Customers and admins | Task19 T19.3–T19.5 (ex-T10.9) |
| **Verifiable** | The answer is computed **only from signed Attesta statements**. Every statement it used is listed with its time and anchor, has a verify action, and goes into an evidence pack, so the auditor can recompute it offline | What TrackAI **knew then**, unchanged; the answer itself is not signed, but every input is | Auditors | Task16 A16.13 |
| **Signed** | The answer itself becomes a statement (a period report), chained and anchored like any statement | The figure itself, as of the moment it was signed; a board report or audit file can cite it years later | Auditors, and admins who need a citable figure | Task15 (code: Task15i4; security: Task15p) |

The earlier wording ("signed statements, or a live query whose result links to the statements that back it") described a fourth, **hybrid** kind: run the query on live tables, then attach the statements. **Decision (founder, 2026-10-15, `TASK19.md` D2): drop the hybrid.** A live table can differ from what was signed (a rebuild, a correction, a late enrichment), and then the answer and its "proof" disagree. The auditor gets verifiable answers, plus signed reports for figures that must be cited. Admins get live answers, with a "see the signed evidence" link where statements exist. One query layer serves both: the same question run against the tables (live) or against the statements (verifiable).

## Code questions (ranked by customer priority)

| Rank | # | Question | Auditor | Data today | Lives in | Answered by | Notes / gap |
|---|---|---|---|---|---|---|---|
| 1 | Q3 | Over the last 12 months, what share of **merged** changes in repo X were AI-assisted, by tool and model? | yes | ✅ | predicate (PR-merged statement) | live query | Lifecycle Merged by model (T2.12, T2.23). `Unknown model` stays explicit. Also **signed** now: the Task15i4 period report's merged-lines-by-tool-and-model figure (T19.1). |
| 2 | Q1 | What % of `payments-service` code was AI-generated **as of a date**? | yes | 🟡 | predicate (per-commit AI/human/unknown lines) + a repo snapshot | new capture (G1) for the whole repository; **signed** "% of lines changed in a period" now (period report, Task15i4) | AI lines per commit and per file are stored (`scm_commits`, `scm_commit_files`). The **repo's total line count at a date is not**, so the denominator is missing. Today we can answer "% of lines **changed** in a period". **Gap G1:** a periodic per-repo (and per-path) line-count snapshot. |
| 3 | Q4 | Which AI tools and models touched production code, and was each **approved** at the time? | yes | 🟡 | predicate (tools, models; policy reference) | live query (models); new capture for approval (G2) | Models and tools per commit are stored (`ai_commit_model_attributions`). **No approved-model list exists** (organization policy is deferred Task6.b). **Gap G2.** |
| 4 | Q11 | Did the AI sessions behind this code raise **security findings**, and of what kind? | yes | 🟡 | predicate (finding counts by category, rule-pack version) | live query | Task6 findings are stored per session and repository (`security_findings`). They are **monitor-only**: worded as "observed", never "blocked" or "prevented". Remediation is not tracked. Expanded in S1–S18 below. |
| 5 | Q7 | Can you prove these records were not changed after the fact? | yes | ✅ (Attesta) | Attesta ledger + anchors | Attesta (built) | Built: hash chain and ledger guards (Task15d), Rekor and RFC 3161 anchoring (15f, 15f2), verify (15i, 15i3), offline verifier (15j). **Pending:** live gates on real KMS, Rekor and TSA (A15.13, Task15n). |
| 6 | Q16 | Export everything for repo X and period Y, verifiable offline without TrackAI. | yes | ✅ (Attesta) | evidence pack (A15.9, A15.10) | Attesta (built) | Built: evidence packs, `full` and `repository_only` (Task15i2), offline verifier (15j), period reports in packs (15i4). **Pending:** clean-machine verification (A15.13). The Priya story in `TASK15.md`. |
| 7 | Q5 | Was AI-generated code **reviewed by someone other than its author** before merge? | yes | ⬜ | predicate (reviewers, approvals) | new capture (G3) | Not captured: no review or approval events (business review R9). **Gap G3:** GitHub `pull_request_review` events. Until then the statement says `Unavailable`. |
| 8 | Q13 | How **complete** is the evidence? Which commits have no AI attribution (no Git AI note, unenrolled machine, unknown lines)? | yes | ✅ | predicate (availability per field) | live query | `observed_unknown_lines`, commits materialized from a push without a note, reachability. Answering this honestly is what keeps us credible (R2). Also **signed**: the period report's unknown-lines figure (T19.1). |
| 9 | Q9 | Which AI-assisted changes reached **production**, when, and through which deployment? | yes | ✅ | predicate (deployment statement) | live query | `scm_deployments` (production flag, status) and the Production stage (T2.19). The merged-but-not-deployed proxy keeps its own label. Also **signed**: the period report's production-deployments figure (T19.1). |
| 10 | Q14 | For one PR, show the chain: prompt → session → commits → PR → merge → deploy. | yes (metadata only) | ✅ | predicate links statements by digest | live query | All links are stored (sessions, PR membership snapshots, merge lineage with confidence). The auditor sees metadata, never prompt text. |
| 11 | Q12 | What **policy** was in force for repo X when this change was made? | yes | 🟡 | predicate (policy reference and version) | live query (partial); new capture for org policy (G2) | Present: repository enrollment and machine grants (Task4), security-monitor setting and rule-pack version (Task6). Missing: an organization AI-usage policy object (Gap G2). |
| 12 | Q2 | For line *N* of file *F* at a commit or date: was it written by AI, by which agent/model/session, when, and what was the change? | yes | 🟡 | predicate (per-file attribution ranges digest) | live query (range + lineage walk) | `scm_commit_files.attribution_ranges` maps line ranges to AI sessions or a human at each commit, and lineage carries ownership across rewrites. **TrackAI stores no code (rule 6)**, so "the diff" is a link to the customer's SCM diff; the prompt is visible only through Task5's gated raw reveal. Point-in-time blame needs more than ranges plus lineage: TrackAI keeps no line-offset history, so the walk starts from the provider's blame (GitHub GraphQL `blame`) and maps each blamed commit through merge lineage to its stored ranges (T19.1; `Task19d-qa-line-walk`, Codex, about 0.12×). |
| 13 | Q6 | Who committed, and who **merged**, each AI-assisted change? | yes | 🟡 | predicate (pseudonymous IDs) | live query (committer); new capture for merger (G4) | Commit author and PR author are stored; **`merged_by` is not** (`scm_pull_requests` has no column). **Gap G4:** small, since GitHub's merge webhook carries it. |
| 14 | Q8 | When did TrackAI first see this commit, and was the evidence signed **then**, not rebuilt later? | yes | ✅ | predicate (`first_seen_at`, `observed_at`) + timestamp token | Attesta | `scm_commits.first_seen_at`; every statement carries its signed time and anchor (Task15h, 15f). A statement signed later (backfill) says so (`signed_late`). |
| 15 | Q15 | Did any AI-assisted code come from a machine or repository **without a valid grant**, and was it rejected? | yes | ⬜ | live query; rejection count in the batch statement | new capture (G5) | Task4 enforcement works, but rejected events are dropped before storage, so there is no countable, provable record (Codex, I6). **Gap G5:** an append-only, content-free rejection audit event. |
| 16 | Q10 | How much AI code was **reworked or deleted** before merge, and by whom (AI or human)? | partly | ✅ | live query; count in predicate | live query | Reworked by actor (T2.18). **Churned is always `Unavailable`** (never written). Mostly a quality and Task10 question. |
| 17 | Q19 | What is the AI acceptance rate (generated vs kept vs committed)? | no | ✅ | live query | live query | Generated, Accepted and Committed (T2.12). Task10. |
| 18 | Q18 | What did AI cost (tokens, money) per repository, PR and model? | no | 🟡 | live query | live query | `ai_session_usage`; Copilot and Antigravity gaps stay `Unavailable` (T2.11e, T2.11g). Task10. |
| 19 | Q20 | Which teams use AI most, and how is it changing? | no | 🟡 | live query, aggregated | live query | Identity linking is partial (T2.20). **No team mapping exists** (T19.1: no team table or column), so by-team answers `unavailable` until one does; by repository works now. Never per developer: Task5's no-surveillance rule. |
| 20 | Q17 | Did AI bring third-party / open-source snippets in (licence risk)? | yes | ⬜ | phase 2 enrichment | phase 2 | SCANOSS fingerprints, opt-in per tenant (R10). By design not in phase 1. |

**Auditor-relevant:** Q1–Q9 and Q11–Q17 (Q10 partly). **Task10 only:** Q18–Q20.

The three kinds of answer above replace the earlier "live query versus provable answer" note.

## Security and policy questions (added 2026-10-14)

*Added by the Task16 lead (Claude) at the founder's request, from the CISO's and the auditor's side. Facts checked against `main` at `63d8ddc` (`file:line` below). Ranked from most to least valuable: S1 is what a CISO asks first. Columns as above.*

**What Task6.a stores today.** One row per finding in `security_findings` (`apps/api/src/core/db/schema.ts:474-560`). Each row is metadata only, with no command text:
- **What and where:** machine, repository, session (a text id), rule id, version, category and severity.
- **Which agent, which platform:** agent family, operating system.
- **What happened:** timing (`pre_action` / `post_action`), phase (`requested` / `observed_result`), result category.
- **Which versions:** client and rule-pack versions.

Three limits shape every answer below:
1. **Three rules only.** Database checks (`schema.ts:525-533`) allow only three rules, all in the execution category, at high/critical severity: `exec.destructive_recursive_delete`, `exec.download_pipe_shell` and `exec.reverse_shell`. The [Numbat catalog](https://github.com/perplexityai/numbat/blob/main/docs/rule-catalog.md) has 51 rules in 12 categories: secrets, exfiltration, integrity, execution, reconnaissance, privilege, lateral movement, impact, source control, tampering, persistence and sequences. Codex reviewed all 51 and deferred 48 for stated reasons (see "Task6.a status" at the end), so this is a decision, not an oversight.
2. **One validated route, monitor only.** The only validated route is OpenCode in a macOS terminal, observe-only (`AC-CLI-03`; AGENTS.md §9 item 11). Every finding is `effect = monitor`.
3. **Findings are not signed on their own.** They enter Attesta only as per-commit counts inside the `ai-provenance` predicate, joined by the session text id with no key (`docs/contracts/attesta/fields.md:40`). A finding from a session that never produced a commit is not signed at all.

| # | Question | Auditor | Data today | Lives in | Answered by | Notes / gap |
|---|---|---|---|---|---|---|
| S1 | Give me the **register of every high/critical security finding** in period P, across all repositories, and prove none was added, changed or removed afterwards. | yes | 🟡 | `finding_observed` statement per finding + **security period report** | new capture (G6) + Attesta | The CISO's first question, and the only one that can carry an incident review. Rows exist, but they are signed only when their session produced a commit. **Gap G6.** Always worded "observed", never "blocked". |
| S2 | **Was monitoring actually on?** Which machines and repositories were covered in P, and where were the gaps (monitor off, expired, revoked, client stopped or out of date)? | yes | 🟡 | security period report (coverage figures) | new capture (G7) | "Zero findings" means nothing without coverage, so S1 and S2 are always shown together. Today `tenant_security_monitor_settings` has one mutable row per tenant (`schema.ts:291-302`, unique per tenant) and `fleet_machine_states` holds current per-machine state only (`schema.ts:385-407`). Neither keeps history. **Gap G7.** |
| S3 | **Did anyone switch off or tamper with the guardrails** in P? Monitor turned off; agent hooks, settings or `.mcp.json` changed; reduced-approval or sandbox-bypass modes; detector state written; Git hooks bypassed; shell history cleared. | yes | ⬜ | `finding_observed` statements + audit events | new capture (G8, G9) | The Numbat rules for this (`tamper.*`, `integrity.*`, `exec.agent_runtime_bypass_flags`, `chain.permission_denied_then_runtime_bypass`) are not ported (G9). The monitor setting has **no writer in the API** (only read: `features/security-findings/activation.ts:73` and `storage-service.ts:212`, T19.1), so a change leaves no audit event (G8). |
| S4 | Did any AI agent **read secrets or credentials**, and did data **leave the machine** afterwards? | yes | ⬜ | `finding_observed` statements | new capture (G9) | The highest real-world risk. Needs Numbat's `secrets.*`, `exfil.*` and `chain.secret_read_then_egress` rules (G9). The answer names the rule and the file class, never the secret or the command. |
| S5 | For one finding, show the **chain**: machine → session → agent and model → repository → the commits and PRs that session produced → deployed? (blast radius) | yes (metadata only) | 🟡 | statements linked by digest | live query now (partial); Attesta after G6, G10 | Machine and repository are foreign keys (`schema.ts:511-520`). The session link to commits is a text join with no key (`fields.md:40`), so it is `partial`. **Gap G10.** Command text stays behind Task5's gated reveal only. |
| S6 | Did code from a session that raised a high/critical finding **get merged or reach production**? | yes | 🟡 | `ai-provenance` predicate (`security_findings_observed`) + `pr_merged` / `deployed` statements | Attesta (partial now) | Answerable from statements signed today, with the `partial` session-linkage caveat. The strongest security answer Attesta gives before G6. |
| S7 | **Which repositories were most affected**, by category and severity, and how does P compare with the previous period? | yes | ✅ (live) | security period report figures | live query now; provable after G6 | `repository_id`, `rule_category` and `rule_severity` are columns, with an index on repository and time (`schema.ts:521-522`). |
| S8 | **Which agent or tool, and which model,** produced the most findings? | yes | 🟡 | security period report figures | live query (agent); new capture for model (G10) | `agent_family` is a column (only `opencode` today, `schema.ts:534-541`). The model is **not** on the finding; it is reachable only through the session text join to Task2's sessions. **Gap G10.** `Unknown model` stays explicit. |
| S9 | **Which platforms** (macOS, Linux, Windows, WSL) produced the most findings, and in which categories? | yes | 🟡 | security period report figures | live query | `operating_system` is a column (`schema.ts:542-543`), but only macOS is validated (D6.2). Until D6.2 lands, Linux and Windows show as **not monitored**, never as zero. |
| S10 | Which **rule-pack and detector versions** were in force on each machine when findings occurred, and were machines up to date? | yes | 🟡 | `finding_observed` predicate; coverage figures | live query (machines with findings); new capture for the others (G7) | `rule_version`, `rule_pack_version` and `client_version` are on every finding. A machine with no finding has only current fleet state, not history (G7). |
| S11 | Which findings were **confirmed outcomes**, and which were only **requested** actions? | yes | ✅ | `finding_observed` predicate | live query; provable after G6 | `timing`, `phase` and `result_category` are columns (`schema.ts:544-560`). A pre-action request is not proof the action ran. Keeping these apart is what keeps the register honest (AGENTS.md rule 7). |
| S12 | **Was anything blocked or prevented?** Under which policy version? | yes | ✅ (answer: no) | security period report (`blocked` figure) | live query now; Task6.b later | Today the honest answer is "none: monitor-only", enforced by `effect = monitor` (`schema.ts:548`). After Task6.b, decisions carry the policy version, and the figure splits into observed / warned / blocked. |
| S13 | What **organization policy** (approved agents and models, blocked actions, required modes) was in force on each machine when a finding occurred, and did the machine hold a valid **activation lease**? | yes | ⬜ | `finding_observed` predicate (policy and lease references) | new capture (G2, G11) | Needs Task6.b policy bundles (G2) and D6.1 leases (G11). Task16b reserves the lease and bundle audit events. |
| S14 | Which **policy exceptions or waivers** were granted, by whom, for how long, and which findings fell under them? | yes | ⬜ | audit events + predicate reference | new capture (G12) | Task6.b. Without it, an auditor cannot tell an approved exception from a gap. |
| S15 | **Who looked at** security findings and raw evidence in P, and is that trail tamper-evident? | yes | ✅ | audit events, sealed into Attesta (A16.4) | live query now; provable after A16.4 | `security_findings.read` and `evidence.raw.read` are already audit events (`docs/contracts/audit/catalog.md` once Task16b merges). Task16e seals them. |
| S16 | How fast were findings **triaged and remediated** (time to acknowledge, time to close), and by whom? | partly | ⬜ | audit events (triage) + live query | new capture (G13) | No triage or disposition state exists (Q11's note: remediation not tracked). A common CISO KPI. |
| S17 | Which **machines (or teams)** generate repeated findings? | partly | 🟡 | live query, aggregated | live query | `machine_id` is a column. Teams: no team mapping exists (as Q20), so by-team is `unavailable`. Never per developer: Task5's no-surveillance rule. |
| S18 | Which rules fire most, and which are noisy (findings later marked benign)? | no | 🟡 | live query | live query (counts); new capture for disposition (G13) | A tuning question for Task10. A false-positive rate needs G13's disposition field. |

**Auditor-relevant:** S1–S15 (S16, S17 partly). **Task10 only:** S18. **Answerable with signatures before any new capture:** S6, plus S15 after A16.4. **Answerable live today:** S7, S9, S11, S12, S17, and S5, S8, S10 partly. Everything else waits on G6–G13.

### A security period report: yes, as its own predicate

The founder asked whether security findings get a `period_report` like Task15's code report. Yes, but **not** by extending `period-report/v1`. That predicate is frozen, scoped to one repository, and its figures are AI-line figures (`docs/contracts/attesta/period-report.md`). The same RP-1 pattern applies to a new, additive predicate type:

| Part | Proposal |
|---|---|
| Prerequisite | **G6:** a `finding_observed` statement per finding. Task6 writes the outbox row in the `/worker/security` upload transaction. The predicate `security-finding/v1` holds the content-free finding metadata, the repository, machine and session references, the rule-pack version and the activation state. The rule is the same as Task15's: report figures come **only from signed statements**, never from live tables. |
| Predicate type | `https://trackai.dev/attesta/security-period-report/v1` |
| Scope | the tenant (all repositories) or one repository; `from`, `to` |
| Figures (integers) | findings by severity, category, rule, repository, agent family, operating system, phase and result; `blocked` (0 and labelled monitor-only until Task6.b); rule-pack versions seen |
| Coverage figures | machines expected vs monitored, and monitor-days. `unavailable` (`not_captured_yet`) until G7 |
| Inputs | count and RFC 6962 root over the `finding_observed` digests in the period, plus the chain range, exactly as `period-report/v1` |
| Answers | S1, S2, S7–S12; it ships in evidence packs like the code report |

**Owner (founder, 2026-10-14):** Attesta, as two Task15 follow-up sessions: **Task15o** (G6: `finding_observed` statements, with Task6 writing the outbox row) and **Task15p** (`security-period-report/v1`). They run after Task15n. A16.13b then answers the S questions from these statements. A new predicate type changes Attesta's ledger guards, as Task15i4 did with migration 0022, and Task16 never builds its own signer (D1).

## Where the Q&A module lives

| Subtask | Owner Task | What it does | Depends on |
|---|---|---|---|
| **T19.2** Q&A contract | Task19 | One question registry as code (id, rank, audience, kinds of answer, availability rules) and one answer envelope (value, availability, kind, backing statement digests), shared by both surfaces below | this file |
| **T19.3–T19.5** Admin Q&A (ex-Task10 T10.9) | Task19 | Every question as a live answer: one query per question; drill-down from aggregate to PR, commit, file and line; honest `Unavailable` states; Task5's no-surveillance defaults for per-developer views; "see the signed evidence" where statements exist | Task2 / Task6 data; the gaps for *new capture* rows; AP-1 conventions |
| **A16.13** Auditor Q&A | Task16, built on T19.2 | The auditor-flagged questions as **verifiable** answers: each answer lists the statements behind it, their times and anchors, a verify action and an export to an evidence pack. Signed period reports where the figure must be citable. Read-only. Split into A16.13a (code questions) and A16.13b (security questions, after Task15o/15p) | T19.2; Task15 A15.9 (evidence API, packs); A16.6; A16.8 |

Task19 owns this file and the delivery matrix in `docs/plan/TASK19.md`. Every surface reads its question list from here.

## What this means for the design

**Three terms, often confused:**

| Term | What it is | Example | Who defines it |
|---|---|---|---|
| **Subject** | What a statement is *about*: the identity being attested, by digest | commit `a14936b…`; merge commit plus PR #4 | in-toto, fixed by A15.0 |
| **Predicate** | What we *claim* about the subject: all the rich fields | AI 432 / human 19 / unknown 0 lines; tools; models; sessions; policy; findings; availability per field | Attesta, versioned (`…/ai-provenance/v1`, v1.1, …) |
| **`attesta_subjects` (outbox)** | Task2's "something happened, please attest it" row, written in the same transaction as the event | `{tenant, repository, kind: commit_observed, sha, event_at, source ids}` | interface A15.0 freezes; Codex implements (A15.7) |

**The outbox stays a thin pointer; the predicate grows.** Task2 writes only the kind of event and the IDs. Attesta's builder then reads Task2's tables to fill the predicate. So adding a field that is available at an existing observation (merged-by on `pr_merged`, for example) changes **the builder and the predicate version, not Task2's trigger**. A genuinely new observation (a review, a repo snapshot) needs a new outbox kind; kinds are additive, so the existing ones and their rows never change. That is the flexibility asked for: the interface Codex builds against can freeze now, while the predicate is discovered question by question.

**Predicate rules that keep it flexible:**
1. Every field carries availability (`recorded` / `partial` / `unavailable`); a field Task2 cannot fill yet is present and `unavailable`, never missing or zero.
2. New fields are additive minor versions (v1.1, v1.2); verifiers ignore fields they do not know. A breaking change is a new predicate type (v2).
3. A signed statement never changes. A fact learned later (merge, deployment, a review) is a **new statement** about the same subject that references the earlier one by digest. Re-attesting old commits with new fields is a backfill statement that says it was signed later.

**Statement kinds (phase 1):** `commit_observed`, `pr_merged`, `deployed`. Later kinds, each additive: `repo_snapshot` (G1), `review_recorded` (G3), `correction` (a Task2 correction overlay, referencing the statement it supersedes), and possibly `commit_discovered` (push-only, before the Git AI note; only if the product needs proof at that instant).

## Task2 interview (questions for Codex, owner of Task2)

The founder relays these; the answers decide predicate v1's fields and which start as `unavailable`.

| ID | Question for Codex | Feeds |
|---|---|---|
| I1 | At commit observation, which fields are reliably filled (author, committed time, per-file ranges, sessions, models, tools), and which can arrive late (push enrichment)? Should Attesta wait for enrichment, or sign what it has and add a later statement? | Q2, Q8, Q13 |
| I2 | Is the authorship note's text stable enough to hash (byte-identical on re-delivery)? Is `scm_commits.authorship_note` the exact bytes Git AI wrote? | predicate `note_digest` |
| I3 | Can `merged_by` be stored from the GitHub merge webhook (Gap G4)? Cost? | Q6 |
| I4 | Can PR review and approval events be captured (Gap G3), and who owns that: Task2, Task7 or Task4? | Q5 |
| I5 | Can Git AI or the GitHub app give a per-repo, per-path line count at a commit (Gap G1), without per-commit Git spawns (gotcha 7)? | Q1 |
| I6 | Are rejected uploads (unenrolled repository or machine) kept as countable evidence anywhere? | Q15 |
| I7 | Which events are final, and which can still be revised by a rebuild (`task2-lifecycle-rebuild`, corrections overlay)? Attesta must sign only stable facts, or sign the correction as its own statement. | all |
| I8 | For each outbox kind, which transaction writes the row, and is it idempotent on replay (provider re-delivery, rebuilds)? | A15.7 |

### Task2 answers (Codex, 2026-10-12)

These answers were audited against current `main` at `bb617f6`, which includes the merged Task2, Task4, Task5, Task6.a, Task15a and Task15b foundations. They describe what the code does today, not the intended A15.0/A15.7 design.

#### I1 — What is reliable at commit observation, and should Attesta wait?

There are currently **two different observations of a commit**:

1. A GitHub push can create the commit first. At that point TrackAI can reliably store tenant, repository, SHA, branch, reachability, author name/email when GitHub supplies them, subject/body, authored/committed times, and `first_seen_at`. This path deliberately does **not** claim attribution, sessions, models, tools or rewrite lineage (`apps/api/src/features/scm/lifecycle-service.ts:37-72`).
2. A later Git AI commit-note event enriches the same `(tenant, repository, SHA)` row with the authorship note, added/deleted lines, AI/human/unknown counts, per-file ranges, sessions, exact tool/model attribution, operation kind and rewrite lineage (`apps/api/src/features/telemetry/service.ts:756-1004`). Any field the provider did not supply can still be null or `Unknown`.

Attesta should **not wait after the Git AI note has been durably normalized**. For phase 1, `commit_observed` should mean “commit observed with its Git AI authorship evidence,” matching `TASK15.md`; A15.7 should write the outbox row in that successful normalization transaction. The signed predicate records field availability and the original `first_seen_at`, so it can honestly show that GitHub saw the commit before attribution arrived.

If the product also needs cryptographic proof at the earlier push-only instant, that is a distinct future statement such as `commit_discovered`; do not overload `commit_observed`. Later enrichment or correction is a new statement referencing the earlier statement, never a mutation of a signed statement.

#### I2 — Is the authorship note byte-stable and exact?

**Stable as stored text, but not provably byte-identical to the original HTTP payload.** Git AI sends the note as a JSON string. TrackAI decodes it and stores the resulting JavaScript string in `scm_commits.authorship_note`; the raw metric event is retained as PostgreSQL `jsonb` (`schema.ts:851-870, 950-979`). JSON decoding and `jsonb` do not preserve original wire whitespace or escape spelling, so neither column is an original-byte archive.

For `note_digest`, A15.0 should define one canonical rule: SHA-256 over the UTF-8 bytes of the exact stored `authorship_note` string, with no Unicode or newline normalization, and include the digest algorithm, encoding and `source_event_id`. The same stored event will reproduce that digest. A distinct later event for the same SHA can update the normalized note, and a rewritten commit legitimately has a different SHA/note; either case requires a new statement rather than silently changing the old digest.

#### I3 — Can `merged_by` be stored, and at what cost?

Yes. GitHub's closed/merged pull-request payload carries `pull_request.merged_by`, and TrackAI already retains that full webhook in `provider_event_deliveries.raw_event`. The current parser extracts the PR author, merge SHA and merge time but not `merged_by`; `scm_pull_requests` also has no merger columns (`parser.ts:173-225`; `schema.ts:809-833`).

This is a **small bounded Task2/SCM change**: add pseudonymous merger provider ID/login fields (or a provider-identity reference), parse them, project them idempotently, backfill retained GitHub merge deliveries where available, and add parser/tenant-isolation/live merge tests. It is small in code, but it still requires a migration and acceptance test; roughly a short subtask rather than a one-line fix.

#### I4 — Can reviews/approvals be captured, and who owns it?

Yes, but they are **not captured today**. The parser only accepts push, deployment/deployment-status and selected pull-request actions; `pull_request_review` currently returns unsupported before a provider-delivery row is claimed (`parser.ts:3, 106-225`). Therefore historical review events that were rejected cannot be reconstructed from TrackAI.

For GitHub phase 1, ownership should be **Task2/SCM semantics with Task7's provider-neutral contract in mind**: subscribe the GitHub App/webhook to `pull_request_review`, normalize an immutable review/approval record keyed by tenant/provider/repository/provider-review-ID, retain reviewer pseudonymous identity, state, submitted time, reviewed commit SHA and dismissal/update state, and add replay/tenant tests. Task4 supplies secure delivery, installation permissions and deduplication primitives; it should not own the business meaning of “reviewed.” Task7 later implements equivalent provider adapters. Until this lands, the predicate field remains `Unavailable`.

#### I5 — Can we obtain repo/path line-count snapshots without per-commit Git spawns?

Not from the current Git AI note or TrackAI tables. Commit Notes describe changed-file attribution ranges, not a complete repository tree (`service.ts:724-752`). A synchronous full-repository count inside every commit hook would violate the bounded-work rule and should not be added.

The safe design is an **asynchronous, capped `repo_snapshot` producer** triggered by a default-branch update or schedule. It should read one immutable tree SHA, enumerate the tree once, batch blob reads (or use a customer CI job), apply a versioned file/language/binary/exclusion policy, and store repository and path-prefix physical-LoC totals plus method/version/availability. It may use the GitHub App where installation permissions and rate limits permit, or a Git AI/CI-side batched implementation; it must never spawn Git once per file/commit. Task2 owns denominator semantics, while the Git AI/SCM adapter owns collection. Snapshot failure remains `Unavailable`, not an estimate.

#### I6 — Are rejected unenrolled uploads retained as countable evidence?

**No.** Repository/machine policy is evaluated first, and rejected event indexes are removed from the batch before `ingestMetricsBatch` stores the batch or its metric events (`ingest.routes.ts:57-73`; `repository-enforcement.ts:180-191`). The caller receives per-event errors, but there is no durable rejection ledger or count that Attesta can prove later. Q15's current `Data today` should therefore be treated as ⬜ for provable rejection evidence, despite enforcement itself working.

Closing this gap requires a privacy-minimized, append-only rejection audit event written independently of the rejected payload: tenant, authenticated machine/grant reference when available, repository/enrollment reference or safe digest, reason code, event count, request/delivery idempotency key and observed time—never prompt/code content or an untrusted repository URL as authority. Task4 should own the security/audit capture contract; Task16 can expose it; Task15 may then include the count/digest in a batch statement.

#### I7 — What is final versus revisable?

“Final” must mean **an immutable observation at a stated time**, not the current normalized row.

| Evidence class | Stability today | Attesta treatment |
|---|---|---|
| Git AI raw metric event (`event_fingerprint`, `raw_event`, event time) | Retry-deduplicated source observation; intended immutable | Safe source reference/digest. Sign the observation and its availability. |
| Provider delivery (`provider`, `delivery_id`, fingerprint, raw event, provider/received time) | Delivery identity/raw payload is stable; processing status is mutable | Sign source identity/digest, not mutable processing status as an eternal fact. |
| Commit `first_seen_at` | Preserved when push and note paths upsert the same SHA | Safe point-in-time field, while clearly identifying its observation source. |
| `scm_commits`, file ranges, session/model links, reachability, PR membership and merge lineage | Normalized projections; can be enriched as evidence arrives | Sign an `as_of` observation with source IDs, builder/predicate version and availability. Later enrichment is a new statement. |
| Generated/Committed/Reworked/Merged/Production lifecycle rows and model projections | Rebuildable projections. The lifecycle rebuild can delete/relink derived rows and replay raw commit events (`service.ts:1253-1335`); the model rebuild upserts derived projections (`task2-model-rebuild.ts:68-80`). | Never call these globally final. Sign the calculated value, calculation version and source evidence set; a rebuild/backfill emits a new statement only when explicitly requested. |
| Corrections | Separate audited overlays; observed values remain available (`schema.ts:1525-1541`; `audit.ts:10-17`) | Correction is its own signed statement referencing the superseded observation; never rewrite the original signature. |

This preserves the value of early proof without freezing incomplete data forever.

#### I8 — Which transaction writes each outbox row, and is replay idempotent?

No `attesta_subjects` table or trigger exists yet, so **none of the three required atomic mappings exists today**. A15.7 must not simply append calls after the current functions; it must make the projection and outbox write share one database transaction and enforce a unique source-derived idempotency key.

| Kind | Current transaction boundary | Required A15.7 boundary and idempotency |
|---|---|---|
| `commit_observed` | Batch row, metric-event row, commit/file/session/model/lifecycle projections, and normalization-status update are currently separate operations (`service.ts:1424-1496`). A failed normalization is retried by the reconciler. | Make commit-note normalization transaction-aware and write the outbox row in the same transaction that completes the commit attribution projection. Unique key should include tenant + kind + `telemetry_metric_event.id` (or its stable event fingerprint). A retry returns the same row; a rebuild does not create another observation statement. |
| `pr_merged` | The mutable PR projection is inside `projectProviderDelivery`'s transaction (`scm.routes.ts:222-395`), but PR snapshots and merge lineage/API enrichment run afterward (`scm.routes.ts:416-470`). | Write the initial `pr_merged` outbox pointer in the provider-projection transaction, keyed by tenant + kind + provider-delivery ID and pointing to PR/repository/delivery. The builder must tolerate lineage fields being unavailable. If the contract requires lineage in the first predicate, add a separate atomic readiness transaction after enrichment; do not hold the webhook transaction open for GitHub API calls. |
| `deployed` | `recordDeployment` runs after provider projection and performs deployment plus lifecycle writes without a shared encompassing transaction (`scm.routes.ts:473-480`; `lifecycle-service.ts:433-502`). | For a successful production status, wrap the deployment observation and outbox insert together. Key by tenant + kind + provider + external deployment ID + status (or the stored deployment row ID). Failure and success statuses are distinct observations; only a qualifying success emits `deployed`. |

Provider re-delivery already has a strong unique key `(tenant, provider, delivery_id)`, and metric ingestion already deduplicates batches/events by payload hash/fingerprint (`schema.ts:835-930`). `attesta_subjects` still needs its own database uniqueness constraint because retries can occur after either source ledger has been claimed. The outbox remains a thin pointer; signing stays asynchronous and never blocks ingestion.

## Decisions for A15.0 from the interview (lead, 2026-10-12)

1. **`commit_observed`** means "commit observed with its Git AI authorship evidence": the outbox row is written in the transaction that completes Git AI note normalization. The predicate carries the original `first_seen_at` and its source, so a push seen before attribution stays visible. A push-only `commit_discovered` is not in phase 1. (I1)
2. **`note_digest`** = SHA-256 over the UTF-8 bytes of the stored `scm_commits.authorship_note` string, no normalization; the predicate records algorithm, encoding and `source_event_id`. A different note for the same SHA is a new statement. (I2)
3. **Signed facts are observations "as of" a time.** Every statement carries `as_of`, its source evidence IDs, the builder version and, for lifecycle values, the calculation version. Lifecycle projections are never called final; a rebuild emits a new statement only when explicitly requested; a correction is its own statement. (I7)
4. **Outbox idempotency keys** (a database uniqueness constraint on `attesta_subjects`, not only the source ledgers): `commit_observed` = tenant + kind + `telemetry_metric_events.id`; `pr_merged` = tenant + kind + provider delivery ID, written inside the provider-projection transaction, with merge lineage allowed to be `unavailable` in the first statement; `deployed` = tenant + kind + provider + external deployment ID + status, only for a successful production status, written together with the deployment observation. (I8)
5. **Predicate v1 fields that start `unavailable`:** reviewers and approvals (G3), merged-by (G4) until Task2 adds it, approved-model policy (G2), repo snapshot reference (G1).

## Gaps found (owners confirmed in Task19 T19.1, 2026-10-15)

| ID | Gap | Questions | Likely owner | Phase |
|---|---|---|---|---|
| G1 | Repo/path line-count snapshot (denominator for "% AI as of a date") | Q1 | Task2 + GitAI | 1 if cheap, else 2 |
| G2 | Organization AI-usage policy (approved tools and models) | Q4, Q12, S13 | Task6.b | later; reference `unavailable` until then |
| G3 | PR review and approval capture (`pull_request_review` webhook; not subscribed today, so past reviews cannot be recovered) | Q5 | Task2 (semantics), Task7 (other providers), Task4 (delivery) | before production (founder, 2026-10-12); predicate field ready now |
| G4 | `merged_by` on pull requests (in the stored webhook, not parsed; migration + backfill) | Q6 | Task2 | before production, small |
| G5 | Content-free rejection audit event for refused uploads (unenrolled repository or machine) | Q15 | Task4 (capture), Task16 (expose), Task15 (count in batch statement) | 1 |
| G6 | Security findings are not signed on their own: only as per-commit counts, joined by session text (`fields.md:40`); a session with no commit leaves its findings unsigned | S1, S5, S7, S10–S12 | Task15 (new `finding_observed` kind and `security-finding/v1` predicate), Task6 (outbox row in the upload transaction) | before A16.13's security answers |
| G7 | Monitoring coverage history: per machine and day, monitor mode, activation, client and rule-pack version, service state. Today one mutable row per tenant (`schema.ts:291-302`) and current fleet state only (`schema.ts:385-407`) | S2, S10 | Task6 + Task9 (capture), Task15 (signed) | with G6 |
| G8 | The security-monitor setting has no API writer and no audit event; changes leave no trace (`activation.ts:73` only reads) | S3 | Task6 (writer), Task16 (event `security.monitor.changed`, reserved in Task16b) | 1 |
| G9 | Rule coverage: 3 of Numbat's 51 rules ported, execution only (`schema.ts:525-533`); the other 48 deferred by Codex for stated reasons ("Task6.a status" above); secrets, exfiltration, tampering, persistence, privilege and sequence rules missing | S1, S3, S4 | Task6.a follow-up (contract and check-constraint change: a migration); rule selection overseen by Task19 T19.7 | next Task6 wave |
| G10 | Model and session key on a finding: the model is reachable only through a session text join, with no key to `ai_sessions` | Q11, S5, S6, S8 | Task6 + Task2 | with G6 |
| G11 | D6.1 activation lease issue and refuse events | S13 | Task6.b (events reserved in Task16b) | with D6.1 |
| G12 | Policy exceptions and waivers object | S14 | Task6.b | with Task6.b |
| G13 | Finding triage, disposition and remediation state (append-only, audited) | S16, S18 | Task6 (state), Task16 (event `security.finding.triaged`, reserved in Task16b), Task10 (UI) | 2 |

## Task6.a status and what it means for these questions (Codex's report, 2026-10-14)

**Summary.** Codex's status report agrees with the code (checked against `schema.ts:474-560`).
- **What exists:** a small, privacy-safe, **monitor-only** foundation. It covers three high-confidence execution patterns, on one route (OpenCode terminal on macOS). It uploads only fixed metadata, and both admins and auditors can see the findings.
- **The other 48 Numbat rules were deferred on purpose, by reason:**

  | Reason | Rules |
  |---|---|
  | Need better command understanding | 15 |
  | Need reliable path handling across platforms | 10 |
  | Need better agent evidence | 8 |
  | Conflict with normal development | 7 |
  | Need multi-step tracking | 6 |
  | Depend on Numbat state or on blocking | 2 |

- **No Numbat code was ported,** rightly. Only three behaviours were needed, raw commands may not leave the machine, and the licence overhead was not worth it.

For this Q&A, that means three things:
1. **The security register is honest but thin.** S1, S7, S9 and S11 can be answered, but only for those three rules on one platform.
2. **The CISO's most valuable questions wait on rule work that is genuinely hard.** S3 (guardrail tampering) and S4 (secrets read, then data sent out) depend on exactly the deferred classes: path handling, agent evidence, multi-step sequences. Expanding the rules (G9) is engineering, not configuration.
3. **Blocking is far off.** It needs D6.1 signed activation, Task13's synchronous hooks, D6.2 per route, Task9 rollback and Task14 certification. So S12's answer stays "none blocked: monitor-only" for a long time, and every surface must say "observed".

The cheapest useful step is the **founder acceptance walkthrough** Codex proposes:

| Step | What to show |
|---|---|
| 1 | Monitoring off: no finding appears |
| 2 | Turn monitoring on |
| 3 | Trigger one synthetic safe pattern |
| 4 | The admin sees the finding and its audit entry |
| 5 | The auditor has read-only access |
| 6 | The developer is denied |
| 7 | The action was not blocked, and no raw command appears |

It should run before Task15o signs findings, because Task15o builds on this foundation.

| Capability | State (Codex) | Effect on questions |
|---|---|---|
| Detection | ✅ 3 high-confidence execution patterns | S1, S7, S9, S11 answerable for these only; S3, S4 wait on G9 |
| Effect | ✅ monitor and alert; no blocking | S12 = "none blocked" until a blocking pilot (Task6.b + Task13 + Task9 + Task14) |
| Privacy | ✅ fixed safe metadata only | Every answer is metadata; command text only through Task5's gated reveal |
| Route | ✅ OpenCode terminal on macOS only | S9: other platforms "not monitored" until D6.2 (Task13 builds, Task9 ships, Task14 certifies) |
| Activation | 🟡 short-lived, in-memory server value | S2, S13 need D6.1 signed, machine-bound activation (Task6.b, on Task15's trust layer A15.12) |
| Customer policy | ⬜ deferred | Q4, Q12, S13, S14 need Task6.b (G2, G12) |
| Founder acceptance | 🟡 working-session walkthrough only | Run the 7-step walkthrough (Task19 T19.7) |

## What the planned Task15 and Task16 work delivers

Planned order:
1. Task16 runs to A16.12: 16b, then 16c, then 16e and 16f, then the walkthrough. Task15m and Task15n run alongside.
2. Then **Task15o**, then **Task15p**.
3. Then **A16.13**. Its code half, A16.13a, needs only 16f and T19.2, so it can start before Task15o. Its security half, A16.13b, waits for Task15p.

| Step | What it builds | Questions it moves |
|---|---|---|
| Task16 to A16.12 | Audit contract and catalog, one emitter, audit read API, audit events sealed into Attesta, signed audit export, auditor console, read-only database role | **S15** becomes verifiable and signed. Reserves the events that S3 (G8), S13 (G11), S14 (G12) and S16 (G13) need; the owning Tasks then emit them |
| Task15n | Live gates: real KMS signing, Rekor and TSA anchoring, a clean-machine offline check | **Q7, Q8, Q16** proven on real infrastructure, not only in tests |
| Task15o + Task15p | `finding_observed` statements, `security-period-report/v1` | **S1** (except coverage), **S7, S9, S11, S12** signed; **S10** partly; **S5** linkage stays partial (G10) |
| A16.13a | Verifiable code answers in the auditor console | **Q3, Q7, Q8, Q9, Q13, Q14, Q16**; **Q1** (share of changed lines, through the period report); **Q11** partly. Q4, Q5, Q6, Q12 and Q15 show `Unavailable` with their gap |
| A16.13b | Verifiable security answers | **S1, S6, S7, S9, S10, S11, S12, S15** |

**Together:** about 17 of the 31 auditor-flagged rows get a verifiable or signed answer: 9 code rows (two of them partial) and 8 security rows.

**Not delivered by this work,** and owned by Task19:
- every **live** admin answer (38 rows, ex-T10.9);
- the capture gaps G1–G5 and G7–G13;
- Q2's line-level walk;
- Q17 (phase 2).
