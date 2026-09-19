# Task5 — GitAI-Based Evidence Explorer and Intention Intelligence

**Authoritative Task5 tracker**  
Last updated: **2026-09-19**

Task5 turns GitAI provenance into a permission-aware customer investigation
experience. [`Task2.md`](Task2.md) remains authoritative for lifecycle metric
meaning, and [`TASK4.md`](TASK4.md) remains authoritative for delivery,
encryption, authorization, retention and operations. The portfolio summary is
the [Task5 section of `ROUGH_ROADMAP.md`](ROUGH_ROADMAP.md#task5--evidence-explorer-and-intention-intelligence).

Historical input is retained in
[`docs/handoffs/TASK4_TO_TASK5.md`](docs/handoffs/TASK4_TO_TASK5.md). It is not a
current tracker. Detailed semantic design is documented in
[`docs/TASK5_SEMANTIC_EVIDENCE_DESIGN.md`](docs/TASK5_SEMANTIC_EVIDENCE_DESIGN.md).
This file is the only source of truth for Task5 status, gates and completion.

## Status legend

| Symbol | Meaning |
|---|---|
| 🟢 ✅ | Complete for the stated scope and manually verified live |
| 🟡 ◐ | Partially implemented, automated-test-only, or further verification remains |
| 🔴 ☐ | Not implemented or not tested |
| ⚪ — | Deferred or not applicable |

“Verified” means the behavior was observed through a controlled Task5 customer
workflow. A related component or passing unit test alone is not a live pass.

## Master Task5 matrix

| ID | Milestone | Implementation and portability | Implemented | Tested & verified | Manual involvement | Dependencies | Priority/order | Evidence / remaining work |
|---|---|---|---:|---:|---|---|---|---|
| **T5.1** | Evidence Taxonomy and Identity | Preserve GitAI commit, session, checkpoint and trace identities. Add separate evidence events, intentions, versioned relationships, evidence states and availability without redefining Task2 data. | 🟢 ✅ | 🟡 ◐ | Review terminology and final many-to-many fixture. | Task2 identity and lifecycle contracts | **Wave 2 · 1** | Schema and APIs distinguish `observed`, `inferred`, `corrected` from `available`, `unavailable`, `redacted`, `expired`. Final E5-1/E5-2 regression evidence remains. |
| **T5.2** | Fixed Evidence Safety Contract | Require tenant opt-in, tenant isolation, content/metadata separation, envelope encryption, secret scanning, audited raw access and 30-day deletion on portable PostgreSQL. | 🟢 ✅ | 🟡 ◐ | Security review and live two-tenant acceptance required. | Task4 security foundation | **Wave 2 · 2** | RLS deny-by-default, tenant-composite semantic FKs, encryption, consent, audit and complete derived-data purge are implemented. Live E5-3/E5-10 remain. |
| **T5.3** | OpenCode Evidence Ingestion and Storage | Ingest idempotent OpenCode prompt, response, reasoning and tool events while preserving provider IDs and GitAI session/trace/checkpoint identities. | 🟢 ✅ | 🟡 ◐ | Controlled local OpenCode-to-TrackAI run required. | T5.1–T5.2; Task4 managed transport | **Wave 3 · 3** | Isolated GitAI collector reads OpenCode SQLite, redacts locally and uses tenant/repository-bound managed delivery. Synthetic mapping/upload passes; live server replay remains. Other providers wait for Task13. |
| **T5.4** | Work-Item Linkage | Link GitHub Issues, Jira or Linear only with explicit customer configuration. | ⚪ — | ⚪ — | Customer-led future decision. | Customer configuration and provider authorization | **Deferred** | Deliberately excluded from Task5. Reconsider with a customer or during Task14. |
| **T5.5** | Evidence Graph APIs | Traverse commit, file/line, session, trace, checkpoint, intention and evidence event in both directions with tenant-safe filters and pagination. | 🟢 ✅ | 🟡 ◐ | Live database/query review required. | T5.1–T5.3 | **Wave 4 · 4** | Common PR/commit/intention work stories and exact file/line explanation now project the graph without redefining GitAI identities. E5-2/E5-5 still require live pagination and gap review. |
| **T5.6** | Visual Evidence Explorer | Present plain-language explanation, supporting graph/timeline, reverse navigation, search and privileged raw reveal. | 🟢 ✅ | 🟡 ◐ | Leader/developer/security walkthroughs required. | T5.5; Task10 owns later styling only | **Wave 5 · 5** | The unified Evidence Workspace is PR-led, perspective-aware and progressively reveals changes, insights and low-level evidence. Existing lifecycle/session/commit/PR/repository/contributor views remain available for diagnostics. E5-6/E5-12 remain. |
| **T5.7** | Pain-Point and Quality Analytics | Explain failures, retries, slow tools, prompt loops, rework, abandoned work and weak outcomes without employee scoring. | 🟢 ✅ | 🟡 ◐ | Analyst interpretation review required. | T5.3, T5.5; Task2 metrics | **Wave 5 · 6** | Work stories combine friction, rework, evidence gaps, unresolved signals and deterministically identified tests. Realistic E5-7 evidence and explanation validation remain. |
| **T5.8** | Code-to-Intention Reverse Engineering | Navigate commit/file/line → GitAI range/checkpoint/trace/session → provider evidence/intention without claiming time proximity as causality. | 🟢 ✅ | 🟡 ◐ | Manual provenance audit required. | T5.1, T5.3, T5.5 | **Wave 4 · 7** | The workspace supports file/line entry and labels only a GitAI `attributed_to` range edge as exact; a missing range is an explicit gap. Live E5-8 remains. |
| **T5.9** | Semantic Intention Review | Provide tenant-isolated intention embeddings, exact and lexical retrieval, cosine retrieval, hybrid fusion, explainable reranking and outcome comparison. | 🟢 ✅ | 🟡 ◐ | Product relevance review, pinned model installation and hard-negative labelling required. | T5.2–T5.5 | **Wave 6 · 8** | Hybrid intention matches now roll up to PR/direct/unfinished customer stories; exact PR/branch/SHA/path/tool/model/error matching, filters and similar-outcome cards exist. Live model/relevance E5-9 remains. |
| **T5.10** | Continuous Verification | Continuously verify taxonomy, privacy, collector mapping, graph behavior, semantic quality and Task2/Task4 regressions. | 🟡 ◐ | 🟡 ◐ | Live provider, product and security acceptance required. | T5.1–T5.9 | **Wave 7 · 9** | Automated API/security/metric/collector checks and pgvector CI workflow exist. Live database/provider/browser/semantic gates and E5-12 remain. Customer certification stays in Tasks12/14. |

## Execution waves

| Wave | Scope | Subtasks | Exit gate |
|---|---|---|---|
| **1** | Canonical documentation and baseline | All | One authoritative tracker, semantic design reference and clean automated baseline |
| **2** | Schema, RLS, retention and semantic storage | T5.1, T5.2, T5.9 | Fresh/upgrade migrations and security gates pass |
| **3** | OpenCode/GitAI live collection | T5.3 | Controlled evidence reaches TrackAI idempotently after replay/restart |
| **4** | Graph, explanation and reverse provenance | T5.5, T5.8 | Commit/file/line traversal is exact and gaps are explicit |
| **5** | Customer Explorer and analytics | T5.6, T5.7 | Product-manager workflow and analyst interpretation pass |
| **6** | Semantic intention search | T5.9 | Embedding, hybrid-search, privacy and relevance gates pass |
| **7** | Release verification | T5.10 | Task2/Task4 regressions and all Task5 gates pass |

## Controlled evidence-gate register

| Gate | Scenario | Main mapping | Implemented | Tested & verified | Sanitized result / remaining work | Checkpoint | Manual involvement |
|---|---|---|---:|---:|---|---|---|
| **E5-1** | One session with zero, one and multiple commits | T5.1 | 🟢 ✅ | 🟡 ◐ | Many-to-many schema exists; complete deterministic fixture and live review. | — | Terminology review |
| **E5-2** | One commit with multiple sessions, traces and checkpoints | T5.1, T5.5 | 🟢 ✅ | 🟡 ◐ | Graph paths exist; verify pagination and exact edge bases. | — | Provenance review |
| **E5-3** | Consent, tenant isolation, encryption, secret redaction and raw authorization | T5.2 | 🟢 ✅ | 🟡 ◐ | Static/unit controls pass, including RLS and tenant-composite semantic references; live two-tenant and log inspection remain. | `44de334`, `2a3e528` | Security acceptance |
| **E5-4** | Live synthetic OpenCode collection, replay and unavailable reasoning | T5.3 | 🟢 ✅ | 🟡 ◐ | GitAI synthetic SQLite-to-upload test covers local redaction, exact tenant/repository binding and unavailable reasoning; live authenticated TrackAI replay remains. | GitAI `a8d93aa20` | Local OpenCode run |
| **E5-5** | Forward/reverse graph traversal and pagination | T5.5 | 🟢 ✅ | 🟡 ◐ | Automated graph contracts exist; live query review remains. | — | Query review |
| **E5-6** | “Why does this code exist?” customer workflow | T5.6, T5.8 | 🟢 ✅ | 🟡 ◐ | Unified workspace, perspective lenses, PR-first stories and progressive evidence tree compile/build; active-versus-historical PR membership and exact-range semantics have focused tests. Three controlled customer walkthroughs remain. | `11a4025`, `056c475`, `016b207` | Product acceptance |
| **E5-7** | Failed tools, retries, slow tools, prompt loops, rework and abandoned work | T5.7 | 🟢 ✅ | 🟡 ◐ | Story insights and deterministic test recognition exist; realistic synthetic corpus and analyst review remain. | `2a3e528`, `11a4025` | Analyst acceptance |
| **E5-8** | File/line → Git Note → checkpoint/trace/session → intention | T5.8 | 🟢 ✅ | 🟡 ◐ | File/line UI and exact-range-only classification exist; run live exact and missing-attribution cases. | `11a4025` | Provenance audit |
| **E5-9** | Embeddings, hybrid search, hard negatives and tenant isolation | T5.9 | 🟢 ✅ | 🟡 ◐ | Local BGE/pgvector/FTS/RRF plus customer-level exact metadata/intention search, filters and outcome comparison exist; exact intention search remains available when the vector model is offline. Pinned artifact, two-tenant negatives and relevance thresholds remain. | `44de334`, `2a3e528`, `11a4025`, `31df089` | Relevance labelling |
| **E5-10** | Correction, expiry and complete derived-data deletion | T5.2, T5.9 | 🟢 ✅ | 🟡 ◐ | Corrections preserve source expiry; purge removes vectors, lexical rows, jobs, old token documents, intentions and summaries. Live deletion inspection remains. | `44de334` | Deletion review |
| **E5-11** | Task2 metric and Task4 security regression | T5.10 | 🟢 ✅ | 🟡 ◐ | TrackAI API/security/metric suite passes 114/114; API/web TypeScript, web lint and production build pass. GitAI focused Task5 tests pass. Its full suite reports 2,166 passes and 17 existing local-listener failures because this sandbox forbids listener creation; lint reports 11 pre-existing errors in untouched files under Rust 1.97. | TrackAI `11a4025`, `056c475`, `016b207`; GitAI `a8d93aa20` | Rerun GitAI full suite/lint in supported CI, then release review |
| **E5-12** | Complete product-manager acceptance walkthrough | T5.6–T5.10 | 🟡 ◐ | 🔴 ☐ | Run after E5-1–E5-11 pass. | — | Product/security acceptance |

## GitAI identity and terminology contract

| Term | TrackAI/GitAI meaning | Non-negotiable rule |
|---|---|---|
| Commit | Independent Git outcome identified by repository and SHA | May contain work from many sessions, traces and checkpoints |
| Session | One provider conversation or agent work session | May produce zero, one or many commits |
| GitAI checkpoint | Point-in-time observation of working-tree edits | Low-level evidence, not a customer work package |
| Trace | Identifier for a checkpoint call or attributed edit path | Detailed provenance, not a business outcome |
| Prompt | Actual human or system instruction | Never silently rewritten as an intention |
| Intention | Explicit or inferred goal behind work | Stored/versioned independently from prompts |
| Evidence event | Prompt, response, reasoning, tool call/result or checkpoint | Retains source, time, provider ID and availability |
| Evidence link | Relationship between evidence objects | Always carries basis, confidence and evidence state |
| Work narrative | Customer-facing explanation over the graph | A derived view, never a new identity/container |

`evidenceState` is `observed`, `inferred` or `corrected`. `availability` is
`available`, `unavailable`, `redacted` or `expired`. Unavailable evidence is not
a type of inference.

## Customer workflow and expected experience

1. A tenant administrator explicitly enables OpenCode raw-evidence collection.
2. OpenCode/GitAI records provider events, sessions, traces, checkpoints and
   commit attribution without changing their identities.
3. A customer starts from a PR, intention, direct commit, file/line or global search result.
4. TrackAI shows four compact answers: why, outcome, key insight and separate evidence-quality dimensions.
5. Every statement links to supporting evidence and displays its state and
   availability.
6. The customer drills from commit or file/line to GitAI attribution and then
   to session/provider evidence.
7. Approved administrators/auditors may explicitly reveal raw evidence; normal
   metadata and summary views never expose it.
8. Similar-intention search compares prior outcomes and friction while exact
   PR, branch, commit SHA, file, tool, model and safe-error matching remains available.
9. Corrections create audited versions; expiry creates a visible gap rather
   than a fabricated explanation.

## Unified customer evidence workspace

The workspace is the default customer surface. It leads with PRs, then keeps
direct commits and unfinished intentions in secondary expandable groups. A
Leader, Developer or Security perspective changes ordering and default
expansion only; it never changes evidence or authorization.

The investigation uses one collapsible tree and one contextual detail pane:
overview → intentions → lifecycle → changes → insights → evidence details.
Sessions, checkpoints, traces and tools appear only below evidence details.
Code Lifecycle, Sessions, Commits, Pull Requests, Repositories and Contributors
remain in the left navigation during Task5 for debugging and regression review.

Deferred from this workspace are “what went well” semantic interpretation,
agent CLI/handoff, previous/next checkpoint navigation, session-first customer
navigation and full source-code indexing.

## Semantic design summary

The embedding represents a versioned, redacted intention—not every prompt.
Embeddings are created when an explicit or inferred intention is created,
meaningfully revised, corrected, or finalized with a changed fingerprint.
Search combines PostgreSQL full-text ranking and local 384-dimensional BGE
embeddings in pgvector using Reciprocal Rank Fusion (`k = 60`), followed by an
explainable deterministic reranker. Full diagrams, storage boundaries and
algorithms are in
[`docs/TASK5_SEMANTIC_EVIDENCE_DESIGN.md`](docs/TASK5_SEMANTIC_EVIDENCE_DESIGN.md).

## Security and privacy invariants

- Raw collection is disabled until a tenant administrator opts in.
- OpenCode is the only Task5 raw-content provider.
- Raw content and derived intention text are envelope-encrypted separately from
  operational metadata.
- Secret scanning runs before storage and cannot be disabled by Task6 policy.
- Raw retrieval is limited to approved administrator/security roles, audited
  and `no-store`.
- Metadata, vectors and lexical indexes are tenant-bound and RLS-protected.
- Raw content, intentions, summaries, lexical indexes, embeddings and jobs use
  the source record's 30-day expiry. Re-indexing never extends retention.
- No prompt, response, reasoning, tool payload, vector, database content or
  credential may appear in logs, errors, fixtures or committed artifacts.
- Insights explain systems and workflows. They are not employee scores.

## Task2 metric invariants

- Task5 reads existing commit/session/checkpoint/range and lifecycle evidence;
  it does not recalculate Task2 metrics.
- Generated, Committed, In-PR, Merged, Production, Reworked and Final AI keep
  their Task2 meanings.
- Missing evidence remains `Unavailable`, never zero.
- Time proximity is an inferred fallback and never observed causality.
- Git Notes/range attribution remains authoritative for final file/line claims.

## Task4 compatibility requirements

- Reuse tenant-bound identity, managed-machine credentials, enrollment/grants,
  envelope encryption, audit and retention contracts.
- Ingestion remains idempotent and fail-closed under missing or revoked scope.
- Task5 migrations are append-only and must pass both fresh and upgrade paths.
- No semantic feature may bypass consent, tenant filters, RLS or deletion.
- Customer-grade evidence bundles, certification and large export storage stay
  in Tasks12/14.

## Brief regression watchlist

| Risk | Required guard |
|---|---|
| Session accidentally treated as commit-bounded | E5-1/E5-2 many-to-many fixtures |
| Time correlation displayed as fact | Evidence-state assertion and UI badge |
| Raw content leaks into metadata/logs | Contract rejection and captured-log tests |
| Cross-tenant semantic result | SQL tenant filter, RLS and two-tenant negative test |
| Correction overwrites observation | Append-only intention version and correction link |
| Re-indexing extends retention | Source expiry copied unchanged into all derived rows |
| Semantic model unavailable | Explicit unavailable state; no external fallback |
| Search relevance hides evidence quality | Separate relevance, match reasons, state and confidence |
| Task2 totals change | Pre/post lifecycle snapshot comparison |
| Task4 authorization weakens | Full security regression and revoked-credential probes |

## Task ownership and deferred boundaries

| Work | Owner |
|---|---|
| Lifecycle metric and attribution meaning | Task2 |
| Reliable delivery, credentials, RLS foundation, retention and operations | Task4 |
| Work-item/Jira/Linear linkage | T5.4, deferred to customer/Task14 review |
| Configurable policy language and signed policy bundles | Task6 |
| Design-system polish and scaled interaction design | Task10 |
| Public API/SDK productization | Task11 |
| Providers other than OpenCode | Task13 |
| Deployment certification, scale tuning and large exports | Task14 |

## Completion boundary

Task5 completes when T5.1–T5.3 and T5.5–T5.10 are implemented, E5-1–E5-12
pass, live/manual results and checkpoint commits are recorded here, Task2 and
Task4 regressions remain green, semantic search uses real embeddings, and the
customer workflow works without raw database inspection. T5.4 remains deferred
and does not block completion.

## Working directories and checkpoints

| Purpose | Location / checkpoint |
|---|---|
| TrackAI Task5 branch | `feature/task5-evidence-explorer` |
| TrackAI working copy | `/Users/manishmahajan/Documents/Codex/2026-09-19/trackai-task5/work/TrackAI-V1` |
| Required Task4 TrackAI ancestor | `91e5724269789f4aa1b357d0665f88bd01af8852` |
| Required GitAI Task4 client ancestor | `2d240fb939313f0cfbe43b71b779a1ac683dfb5d` |
| TrackAI implementation checkpoints | `2fcfc9b`, `44de334`, `2a3e528`, `11a4025`, `056c475`, `31df089`, `016b207` |
| GitAI Task5 branch | `feature/task5-opencode-evidence` |
| GitAI isolated working copy | `/Users/manishmahajan/Documents/Codex/2026-09-19/trackai-task5/work/git-ai-task5` |
| GitAI OpenCode collector checkpoint | `a8d93aa20` |

## Step-by-step verification plan

Use only synthetic prompts, tool payloads, repository data and credentials in
this verification. Never paste customer evidence into a terminal, fixture,
test log or issue.

### Phase A — automated baseline

1. In the TrackAI working copy, run `npm ci` if dependencies are absent.
2. Run `npm test --workspace=apps/api`. This protects Task2 metrics, Task4
   security and Task5 contracts together.
3. Run `npx tsc --noEmit -p apps/api/tsconfig.json` and
   `npx tsc --noEmit -p apps/web/tsconfig.json`.
4. Build the web application with non-secret local public Supabase placeholders.
   The build must compile, type-check and prerender; the placeholders must not
   be committed.
5. In the isolated GitAI working copy, run the targeted evidence tests, then
   `task test`, `task fmt` and `task lint`. If repository-main lint fails on
   untouched files, record those exact baseline findings rather than changing
   unrelated code.

### Phase B — fresh and upgrade database gates

1. Start an ephemeral PostgreSQL 16 instance with pgvector. Never point these
   tests at a customer or shared database.
2. Apply all migrations to an empty database with
   `npm run db:migrate --workspace=apps/api`.
3. Run `npm run verify:task5-schema --workspace=apps/api`. Confirm pgvector,
   384 dimensions, GIN lexical index, intention version constraints, nine
   RLS-enabled evidence tables, zero browser policies and zero plaintext
   semantic columns.
4. Repeat from the Task4 schema checkpoint and apply only the later migrations
   to prove the upgrade path and legacy-intention backfill.
5. Create two synthetic tenants. Prove a semantic row/job cannot point to the
   other tenant's intention and that every search result remains in the active
   tenant. This is the live portion of E5-3/E5-9.

### Phase C — controlled OpenCode collection

1. Create a disposable OpenCode SQLite fixture containing synthetic prompt,
   response, reasoning, tool-call, tool-result and unavailable-reasoning cases.
2. Enrol a disposable repository/machine and install the owner-only delivery
   policy/keyring. Confirm the policy contains the exact TrackAI repository UUID.
3. Enable OpenCode collection through the tenant-admin UI.
4. Run `git-ai evidence sync-opencode --database <fixture> --session <synthetic-id> --repository-url <enrolled-url>`.
5. Repeat the same command. The second run must report duplicates server-side
   and create no duplicate provider event, intention or semantic job.
6. Disable consent, revoke repository access and revoke the machine credential
   in separate runs. Each condition must fail closed with no raw content in
   logs. These steps complete E5-3/E5-4.

### Phase D — identity, graph and reverse provenance

1. Build synthetic GitAI fixtures for: a session with zero commits, one commit
   and multiple commits; then one commit with multiple sessions/traces/checkpoints.
2. Query graph roots from commit, session, trace, checkpoint, event and
   intention. Follow every `nextCursor` and check that no page invents edges.
3. Pick an attributed file/line and verify the exact chain:
   file/line → Git Note range → trace/checkpoint → session → intention/events.
4. Remove a Note, trace and raw event in separate fixtures. The Explorer must
   show an honest gap, never a time-based observed claim. These steps complete
   E5-1/E5-2/E5-5/E5-8.

### Phase E — customer Explorer and analytics

1. In Leader perspective, open a concerning PR and confirm intention, outcome,
   friction, evidence quality and similar outcomes are understandable without
   expanding sessions or inspecting the database.
2. In Developer perspective, expand a commit/file, enter an attributed line and
   follow its exact GitAI range to intention, tests/tools and provenance. Repeat
   with a missing range and confirm no time-based claim is presented as exact.
3. In Security perspective, review observed/inferred/corrected plus
   available/redacted/unavailable/expired labels. Reveal one raw event as an
   approved administrator/auditor, confirm the `no-store` response and audit
   record, then confirm an unapproved role fails.
4. Search by PR title, branch, commit SHA, file path, tool/model, safe error and
   semantic intention. Exercise repository, branch, date, agent/model, outcome
   and result-type filters and navigate each result to its parent customer story.
5. Load failed/retried/slow tools, prompt loops, rework, abandoned work, test
   success/failure and an intention without a commit. Confirm no person ranking
   exists and that direct/unfinished work remains in secondary groups.
6. Switch perspectives and prove that only ordering/default expansion changes;
   facts, states, results and permissions remain identical. These steps complete
   E5-6/E5-7 and the customer portion of E5-8/E5-9.

### Phase F — semantic and deletion gates

1. Install the pinned local `BAAI/bge-small-en-v1.5` artifact and record its
   immutable revision/checksum; configure the local adapter and start the
   semantic worker. Network access must remain disabled.
2. Confirm an intention milestone creates one normalized 384-dimensional row.
   Later prompts alone must not create new intention versions. An explicit
   revision or audited correction must create a version/job without extending
   the original expiry.
3. Run lexical-only, semantic-only, hybrid, exact phrase and hard-negative
   queries. Record Recall@10, MRR@10, nDCG@10 and top-five hard-negative error.
4. Change to a second pinned model revision and call the admin semantic-reindex
   endpoint. Search must switch revisions only after the planned backfill gate.
5. Advance the synthetic clock beyond 30 days and purge. Inspect that encrypted
   raw content, intentions, summaries, embeddings, lexical documents and jobs
   are gone while permitted metadata/audit gaps remain. These steps complete
   E5-9/E5-10.

### Phase G — product-manager acceptance

Run the entire path without database inspection: enable collection → collect
synthetic OpenCode work → create a multi-commit PR → inspect it as Leader →
trace a file/line as Developer → audit a gap/raw reveal as Security → search a
similar intention and compare outcomes → correct an intention → observe expiry.
Record sanitized screenshots, gate results and checkpoint commits in this file.
Only then may E5-12 and the Task5 completion boundary become green.

## Wave 1 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Initial Task5 evidence overlay | 🟡 ◐ | Commit `2fcfc9b` adds schema, OpenCode server contract/adapter, safety controls, graph/explain/search/friction APIs, functional Evidence Explorer and 106-test baseline. It does not yet provide real embeddings or live provider/customer acceptance. |
| 2026-09-19 | Canonical documentation consolidation | 🟡 ◐ | `TASK5.md` becomes the sole Task5 status/gate authority; the semantic design is subordinate and the prior standalone explorer note is removed. Next: automated baseline and Wave 2 schema/security work. |
| 2026-09-19 | Automated implementation baseline | 🟡 ◐ | TrackAI `2a3e528` passes 111/111 API/security/metric tests, API compilation and the production web build. Live database, local-model and customer acceptance evidence remains required. |

## Wave 2 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Schema, RLS, retention and semantic storage | 🟡 ◐ | TrackAI `44de334` and `2a3e528` add append-only migrations, pgvector storage, intention versioning, durable semantic jobs, deny-by-default RLS and tenant-composite foreign keys. Static tests pass; fresh/upgrade pgvector migration and live two-tenant/deletion inspection remain. |

## Wave 3 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | OpenCode/GitAI collection | 🟡 ◐ | GitAI `a8d93aa20` adds `evidence sync-opencode`, read-only SQLite extraction, pre-serialization redaction, stable provider IDs, unavailable-reasoning representation and exact policy binding. Forty-one OpenCode-focused tests plus the evidence-binding test pass; live authenticated TrackAI replay remains. |

## Wave 4 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Graph and reverse provenance implementation | 🟡 ◐ | TrackAI `2fcfc9b` provides graph/explain/range-attribution APIs with explicit basis, state, confidence and availability. E5-1/E5-2/E5-5/E5-8 live fixtures and pagination review remain. |

## Wave 5 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Customer Explorer and analytics implementation | 🟡 ◐ | TrackAI `2fcfc9b` and `2a3e528` provide the functional explanation, graph/timeline, filters, raw reveal, semantic health and visible friction cards. Product-manager and analyst acceptance remain. |
| 2026-09-19 | Unified customer Evidence Workspace | 🟡 ◐ | TrackAI `11a4025` adds PR-led work stories, Leader/Developer/Security perspectives, direct/unfinished secondary groups, a hierarchical evidence deep dive, exact file/line “Why?”, deterministic tests, customer-level search and similar-outcome cards. `056c475` retains all diagnostic dashboard views. Three controlled browser walkthroughs remain. |

## Wave 6 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Semantic intention search implementation | 🟡 ◐ | TrackAI `44de334` and `2a3e528` replace token overlap with PostgreSQL FTS, exact pgvector cosine retrieval, RRF `k=60`, deterministic reranking, revision-aware jobs/reindex and a local-only BGE adapter. A pinned model run and relevance/deletion lab remain. |
| 2026-09-19 | Customer-level hybrid search projection | 🟡 ◐ | TrackAI `11a4025` rolls semantic intentions and exact PR/branch/SHA/path/tool/model/error matches up to PR, direct-change or unfinished-work results, with outcome comparison and compact filters. `31df089` preserves exact intention search when the local vector model is offline. Live pinned-model relevance remains. |

## Wave 7 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Automated release verification | 🟡 ◐ | TrackAI: 114/114 tests, API/web compilation, web lint and production build pass. Focused workspace tests protect active PR membership, legacy fallback and exact GitAI range attribution. GitAI: Task5-focused tests pass; the full run has 2,166 passes and 17 sandbox listener failures, while lint has 11 untouched baseline errors under Rust 1.97. E5-12 and all live portions remain, so Task5 is not yet complete under the completion rule. |
