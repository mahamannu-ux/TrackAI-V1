# Attesta: the questions customers and auditors ask

*Written 2026-10-11 by the Task15 lead (Claude), working backwards from the customer and the auditor, as the founder asked; Task2's answers added by Codex on 2026-10-12 (audited against `main` at `bb617f6`). Input to `Task15c-attesta-contract` (A15.0) and to the Q&A modules T10.9 (Task10, customer/admin) and A16.13 (Task16, auditor). The question list is a living document: the founder will add questions from Task5, Task6.a and Task6.b. Symbols per AGENTS.md §11.*

## How to read this

- **Auditor**: "yes" means an auditor (SOC 2, ISO 42001, acquirer's counsel, insurer) would ask it, so the answer must be **provable**. Provable means signed in an Attesta statement at the time, not computed from live tables on the day of the audit. "no" means it is a Task10 admin/engineering question and needs no signature.
- **Data today**: ✅ Task2 (or Task4/5/6) stores what is needed; 🟡 part of it; ⬜ not captured.
- **Lives in**: what has to be in the signed **predicate** for the answer to be provable, or "live query" when a dashboard is enough.
- **Answered by**: *live query* (buildable now from stored data; no query exists yet), *new capture* (a gap must be closed first, see Gaps), *Attesta* (built by Task15), *phase 2*.

## The questions

| # | Question | Auditor | Data today | Lives in | Answered by | Notes / gap |
|---|---|---|---|---|---|---|
| Q1 | What % of `payments-service` code was AI-generated **as of a date**? | yes | 🟡 | predicate (per-commit AI/human/unknown lines) + a repo snapshot | new capture (G1); live query for "% of changed lines" now | AI lines per commit and per file are stored (`scm_commits`, `scm_commit_files`). The **repo's total line count at a date is not**, so the denominator is missing. Today we can answer "% of lines **changed** in a period". **Gap G1:** a periodic per-repo (and per-path) line-count snapshot. |
| Q2 | For line *N* of file *F* at a commit or date: was it written by AI, by which agent/model/session, when, and what was the change? | yes | 🟡 | predicate (per-file attribution ranges digest) | live query (range + lineage walk) | `scm_commit_files.attribution_ranges` maps line ranges to AI sessions or a human at each commit, and lineage carries ownership across rewrites. **TrackAI stores no code (rule 6)**, so "the diff" is a link to the customer's SCM diff; the prompt is visible only through Task5's gated raw reveal. Point-in-time blame needs a server-side walk of ranges plus lineage (Task10 feature). |
| Q3 | Over the last 12 months, what share of **merged** changes in repo X were AI-assisted, by tool and model? | yes | ✅ | predicate (PR-merged statement) | live query | Lifecycle Merged by model (T2.12, T2.23). `Unknown model` stays explicit. |
| Q4 | Which AI tools and models touched production code, and was each **approved** at the time? | yes | 🟡 | predicate (tools, models; policy reference) | live query (models); new capture for approval (G2) | Models and tools per commit are stored (`ai_commit_model_attributions`). **No approved-model list exists** (organization policy is deferred Task6.b). **Gap G2.** |
| Q5 | Was AI-generated code **reviewed by someone other than its author** before merge? | yes | ⬜ | predicate (reviewers, approvals) | new capture (G3) | Not captured: no review or approval events (business review R9). **Gap G3:** GitHub `pull_request_review` events. Until then the statement says `Unavailable`. |
| Q6 | Who committed, and who **merged**, each AI-assisted change? | yes | 🟡 | predicate (pseudonymous IDs) | live query (committer); new capture for merger (G4) | Commit author and PR author are stored; **`merged_by` is not** (`scm_pull_requests` has no column). **Gap G4:** small, since GitHub's merge webhook carries it. |
| Q7 | Can you prove these records were not changed after the fact? | yes | ⬜ (Attesta) | Attesta ledger + anchors | Attesta | The core of Attesta: hash chain, timestamp authority token, Rekor anchor, offline verifier. |
| Q8 | When did TrackAI first see this commit, and was the evidence signed **then**, not rebuilt later? | yes | ✅ | predicate (`first_seen_at`, `observed_at`) + timestamp token | Attesta | `scm_commits.first_seen_at`; Attesta adds the signed time. A statement signed later (backfill) must say so. |
| Q9 | Which AI-assisted changes reached **production**, when, and through which deployment? | yes | ✅ | predicate (deployment statement) | live query | `scm_deployments` (production flag, status) and the Production stage (T2.19). The merged-but-not-deployed proxy keeps its own label. |
| Q10 | How much AI code was **reworked or deleted** before merge, and by whom (AI or human)? | partly | ✅ | live query; count in predicate | live query | Reworked by actor (T2.18). **Churned is always `Unavailable`** (never written). Mostly a quality and Task10 question. |
| Q11 | Did the AI sessions behind this code raise **security findings**, and of what kind? | yes | 🟡 | predicate (finding counts by category, rule-pack version) | live query | Task6 findings are stored per session and repository (`security_findings`). They are **monitor-only**: worded as "observed", never "blocked" or "prevented". Remediation is not tracked. |
| Q12 | What **policy** was in force for repo X when this change was made? | yes | 🟡 | predicate (policy reference and version) | live query (partial); new capture for org policy (G2) | Present: repository enrollment and machine grants (Task4), security-monitor setting and rule-pack version (Task6). Missing: an organization AI-usage policy object (Gap G2). |
| Q13 | How **complete** is the evidence? Which commits have no AI attribution (no Git AI note, unenrolled machine, unknown lines)? | yes | ✅ | predicate (availability per field) | live query | `observed_unknown_lines`, commits materialized from a push without a note, reachability. Answering this honestly is what keeps us credible (R2). |
| Q14 | For one PR, show the chain: prompt → session → commits → PR → merge → deploy. | yes (metadata only) | ✅ | predicate links statements by digest | live query | All links are stored (sessions, PR membership snapshots, merge lineage with confidence). The auditor sees metadata, never prompt text. |
| Q15 | Did any AI-assisted code come from a machine or repository **without a valid grant**, and was it rejected? | yes | ⬜ | live query; rejection count in the batch statement | new capture (G5) | Task4 enforcement works, but rejected events are dropped before storage, so there is no countable, provable record (Codex, I6). **Gap G5:** an append-only, content-free rejection audit event. |
| Q16 | Export everything for repo X and period Y, verifiable offline without TrackAI. | yes | ⬜ (Attesta) | evidence pack (A15.9, A15.10) | Attesta | The Priya story in `TASK15.md`. |
| Q17 | Did AI bring third-party / open-source snippets in (licence risk)? | yes | ⬜ | phase 2 enrichment | phase 2 | SCANOSS fingerprints, opt-in per tenant (R10). By design not in phase 1. |
| Q18 | What did AI cost (tokens, money) per repository, PR and model? | no | 🟡 | live query | live query | `ai_session_usage`; Copilot and Antigravity gaps stay `Unavailable` (T2.11e, T2.11g). Task10. |
| Q19 | What is the AI acceptance rate (generated vs kept vs committed)? | no | ✅ | live query | live query | Generated, Accepted and Committed (T2.12). Task10. |
| Q20 | Which teams use AI most, and how is it changing? | no | 🟡 | live query, aggregated | live query | Identity linking is partial (T2.20). Kept at team/repository level by default: Task5's no-surveillance rule applies to per-developer views. |

**Auditor-relevant:** Q1–Q9 and Q11–Q17 (Q10 partly). **Task10 only:** Q18–Q20.

**Live query versus provable answer.** Most 🟡 items can be answered in real time by a live query over Task2's tables; those queries do not exist yet and are the bulk of T10.9's work. A live query shows what TrackAI knows *today*. An auditor needs what TrackAI knew *then*, unchanged: the auditor-flagged questions are therefore answered in A16.13 from signed Attesta statements (or a live query whose result links to the statements that back it, with a verify action). The questions marked *new capture* cannot be answered by any query until their gap is closed.

## Where the Q&A module lives

| Subtask | Owner Task | What it does | Depends on |
|---|---|---|---|
| **T10.9** Questions & answers (customer/admin) | Task10 | All questions in this file as an interactive, graphical Q&A surface: one query per question, drill-down from aggregate to PR, commit, file and line, honest `Unavailable` states, Task5 no-surveillance defaults for per-developer views. | Task2 data; the gaps for the *new capture* questions; Task11 paging/error conventions |
| **A16.13** Auditor Q&A | Task16 | The auditor-flagged questions answered from signed statements: each answer shows the statements behind it, their timestamps and anchors, a verify action and an export to an evidence pack. Read-only. | Task15 A15.9 (Evidence API, pack), A16.6 (audit read API), T10.9's queries where shared |

Both modules read this file as their question catalogue; a new question is added here first, with its auditor flag, data check and owner.

## What this means for the design

**Three terms, often confused:**

| Term | What it is | Example | Who defines it |
|---|---|---|---|
| **Subject** | What a statement is *about*: the identity being attested, by digest | commit `a14936b…`; merge commit plus PR #4 | in-toto, fixed by A15.0 |
| **Predicate** | What we *claim* about the subject: all the rich fields | AI 432 / human 19 / unknown 0 lines; tools; models; sessions; policy; findings; availability per field | Attesta, versioned (`…/ai-provenance/v1`, v1.1, …) |
| **`attesta_subjects` (outbox)** | Task2's "something happened, please attest it" row, written in the same transaction as the event | `{tenant, repository, kind: commit_observed, sha, event_at, source ids}` | interface A15.0 freezes; Codex implements (A15.7) |

**The outbox stays a thin pointer; the predicate grows.** Task2 writes only the kind of event and the IDs. Attesta's builder then reads Task2's tables to fill the predicate. So adding a field later (reviewers, merged-by, repo snapshot) changes **the builder and the predicate version, never Task2's trigger**. That is the flexibility asked for: the interface Codex builds against can freeze now, while the predicate is discovered question by question.

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

## Gaps found (owners to confirm)

| ID | Gap | Questions | Likely owner | Phase |
|---|---|---|---|---|
| G1 | Repo/path line-count snapshot (denominator for "% AI as of a date") | Q1 | Task2 + GitAI | 1 if cheap, else 2 |
| G2 | Organization AI-usage policy (approved tools and models) | Q4, Q12 | Task6.b | later; reference `unavailable` until then |
| G3 | PR review and approval capture (`pull_request_review` webhook; not subscribed today, so past reviews cannot be recovered) | Q5 | Task2 (semantics), Task7 (other providers), Task4 (delivery) | before production (founder, 2026-10-12); predicate field ready now |
| G4 | `merged_by` on pull requests (in the stored webhook, not parsed; migration + backfill) | Q6 | Task2 | before production, small |
| G5 | Content-free rejection audit event for refused uploads (unenrolled repository or machine) | Q15 | Task4 (capture), Task16 (expose), Task15 (count in batch statement) | 1 |
