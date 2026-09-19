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
| **T5.2** | Fixed Evidence Safety Contract | Require tenant opt-in, tenant isolation, content/metadata separation, envelope encryption, secret scanning, audited raw access and 30-day deletion on portable PostgreSQL. | 🟡 ◐ | 🟡 ◐ | Security review and live two-tenant acceptance required. | Task4 security foundation | **Wave 2 · 2** | Application controls exist. Database RLS hardening, complete semantic-derived-data deletion and live E5-3/E5-10 remain. |
| **T5.3** | OpenCode Evidence Ingestion and Storage | Ingest idempotent OpenCode prompt, response, reasoning and tool events while preserving provider IDs and GitAI session/trace/checkpoint identities. | 🟡 ◐ | 🔴 ☐ | Controlled local OpenCode run required. | T5.1–T5.2; Task4 managed transport | **Wave 3 · 3** | Server contract and OpenCode row adapter exist. Real GitAI collector wiring, restart/replay and E5-4 remain. Other providers wait for Task13. |
| **T5.4** | Work-Item Linkage | Link GitHub Issues, Jira or Linear only with explicit customer configuration. | ⚪ — | ⚪ — | Customer-led future decision. | Customer configuration and provider authorization | **Deferred** | Deliberately excluded from Task5. Reconsider with a customer or during Task14. |
| **T5.5** | Evidence Graph APIs | Traverse commit, file/line, session, trace, checkpoint, intention and evidence event in both directions with tenant-safe filters and pagination. | 🟢 ✅ | 🟡 ◐ | Live database/query review required. | T5.1–T5.3 | **Wave 4 · 4** | Functional graph and explain APIs exist. E5-2/E5-5 must verify pagination, gaps and exact versus inferred links. |
| **T5.6** | Visual Evidence Explorer | Present plain-language explanation, supporting graph/timeline, reverse navigation, search and privileged raw reveal. | 🟢 ✅ | 🟡 ◐ | Product-manager walkthrough required. | T5.5; Task10 owns polish | **Wave 5 · 5** | Functional dashboard exists. Filter completion, accessibility baseline and E5-6/E5-12 remain. |
| **T5.7** | Pain-Point and Quality Analytics | Explain failures, retries, slow tools, prompt loops, rework, abandoned work and weak outcomes without employee scoring. | 🟢 ✅ | 🟡 ◐ | Analyst interpretation review required. | T5.3, T5.5; Task2 metrics | **Wave 5 · 6** | Deterministic analytics exist. Realistic E5-7 evidence and explanation validation remain. |
| **T5.8** | Code-to-Intention Reverse Engineering | Navigate commit/file/line → GitAI range/checkpoint/trace/session → provider evidence/intention without claiming time proximity as causality. | 🟢 ✅ | 🟡 ◐ | Manual provenance audit required. | T5.1, T5.3, T5.5 | **Wave 4 · 7** | Range-attribution traversal exists. E5-8 must verify exact Git Note lineage and honest missing evidence. |
| **T5.9** | Semantic Intention Review | Provide tenant-isolated intention embeddings, exact and lexical retrieval, cosine retrieval, hybrid fusion, explainable reranking and outcome comparison. | 🟡 ◐ | 🔴 ☐ | Product relevance review and hard-negative labelling required. | T5.2–T5.5 | **Wave 6 · 8** | Current implementation is encrypted token overlap, not embeddings. pgvector, local model inference, hybrid ranking and E5-9 remain. |
| **T5.10** | Continuous Verification | Continuously verify taxonomy, privacy, collector mapping, graph behavior, semantic quality and Task2/Task4 regressions. | 🟡 ◐ | 🔴 ☐ | Live provider, product and security acceptance required. | T5.1–T5.9 | **Wave 7 · 9** | Unit coverage exists. Database/provider/browser/semantic CI and E5-11/E5-12 remain. Customer certification stays in Tasks12/14. |

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
| **E5-3** | Consent, tenant isolation, encryption, secret redaction and raw authorization | T5.2 | 🟡 ◐ | 🟡 ◐ | Unit controls pass; add RLS, live two-tenant and log inspection. | — | Security acceptance |
| **E5-4** | Live synthetic OpenCode collection, replay and unavailable reasoning | T5.3 | 🟡 ◐ | 🔴 ☐ | Server accepts the contract; wire and run the real collector. | — | Local OpenCode run |
| **E5-5** | Forward/reverse graph traversal and pagination | T5.5 | 🟢 ✅ | 🟡 ◐ | Automated graph contracts exist; live query review remains. | — | Query review |
| **E5-6** | “Why does this code exist?” customer workflow | T5.6, T5.8 | 🟢 ✅ | 🟡 ◐ | Functional UI exists; product-manager walkthrough remains. | — | Product acceptance |
| **E5-7** | Failed tools, retries, slow tools, prompt loops, rework and abandoned work | T5.7 | 🟢 ✅ | 🟡 ◐ | Rules exist; realistic synthetic corpus and analyst review remain. | — | Analyst acceptance |
| **E5-8** | File/line → Git Note → checkpoint/trace/session → intention | T5.8 | 🟢 ✅ | 🟡 ◐ | Traversal exists; run exact line-attribution and missing-note cases. | — | Provenance audit |
| **E5-9** | Embeddings, hybrid search, hard negatives and tenant isolation | T5.9 | 🟡 ◐ | 🔴 ☐ | Replace token overlap and meet semantic-quality thresholds. | — | Relevance labelling |
| **E5-10** | Correction, expiry and complete derived-data deletion | T5.2, T5.9 | 🟡 ◐ | 🟡 ◐ | Correction/raw purge exists; include vectors, lexical index and jobs. | — | Deletion review |
| **E5-11** | Task2 metric and Task4 security regression | T5.10 | 🟡 ◐ | 🟡 ◐ | Existing suites pass; rerun after each Task5 wave. | — | Release review |
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
3. A customer selects a commit and asks, “Why does this code exist?”
4. TrackAI shows intention, outcome, friction, learnings and open items.
5. Every statement links to supporting evidence and displays its state and
   availability.
6. The customer drills from commit or file/line to GitAI attribution and then
   to session/provider evidence.
7. Approved administrators/auditors may explicitly reveal raw evidence; normal
   metadata and summary views never expose it.
8. Similar-intention search compares prior outcomes and friction while exact
   commit, file, session, tool and model filters remain available.
9. Corrections create audited versions; expiry creates a visible gap rather
   than a fabricated explanation.

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
| Current Task5 implementation checkpoint | `2fcfc9b` |

## Wave 1 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| 2026-09-19 | Initial Task5 evidence overlay | 🟡 ◐ | Commit `2fcfc9b` adds schema, OpenCode server contract/adapter, safety controls, graph/explain/search/friction APIs, functional Evidence Explorer and 106-test baseline. It does not yet provide real embeddings or live provider/customer acceptance. |
| 2026-09-19 | Canonical documentation consolidation | 🟡 ◐ | `TASK5.md` becomes the sole Task5 status/gate authority; the semantic design is subordinate and the prior standalone explorer note is removed. Next: automated baseline and Wave 2 schema/security work. |

## Wave 2 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | Schema, RLS, retention and semantic storage | 🔴 ☐ | Record sanitized fresh/upgrade migration, RLS and deletion results here. |

## Wave 3 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | OpenCode/GitAI live collection | 🔴 ☐ | Record collector checkpoint and E5-4 result here. |

## Wave 4 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | Graph and reverse provenance | 🔴 ☐ | Record E5-2/E5-5/E5-8 result here. |

## Wave 5 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | Customer Explorer and analytics | 🔴 ☐ | Record E5-6/E5-7 customer/analyst result here. |

## Wave 6 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | Semantic intention search | 🔴 ☐ | Record model revision, relevance metrics and E5-9/E5-10 result here. |

## Wave 7 implementation evidence

| Date | Scope | Status | Evidence / next gate |
|---|---|---:|---|
| — | Release verification | 🔴 ☐ | Record E5-11/E5-12, final regression counts and completion decision here. |
