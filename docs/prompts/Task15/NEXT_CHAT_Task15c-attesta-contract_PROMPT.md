# Handoff prompt: Task15c-attesta-contract (Attesta statement, predicate and outbox contract), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line.
> 3. Checkpoint: after its design summary (step 2.2) it stops and shows you the predicate field table and the outbox table. Answer "go", or name fields to add, drop or rename.
> 4. When it finishes, paste its review request to **Codex** (Codex implements the outbox writes in A15.7, so it reviews the interface it will build against). Push only after "ready to push".

---

You are **Claude**, building **Task15c-attesta-contract** (subtask A15.0) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Attesta (Task15) turns Task2's attribution records into signed, tamper-evident, independently verifiable statements. The primitives (canonical JSON, Merkle trees, DSSE; Task15a) and the signer contract (Task15b) are merged. This session **freezes the interfaces** everything else builds against: the in-toto statement and the `ai-provenance` predicate v1, the `attesta_subjects` outbox Task2 writes, and the design of Attesta's tables, routes and error codes. It ships one small migration (the outbox table) so Codex can start A15.7 at once (AGENTS.md §5). It does not build the ledger, signing worker, anchoring or routes.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Claude works in a clone in its cloud workspace and moves commits with bundles in `~/AIProjects/_bundles` (`CLAUDE.md`); never a worktree from the linked shell. Branch `task/Task15c-attesta-contract`.
- **Handoff:** `docs/handoffs/Task15c-attesta-contract_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §5, §7, §9 items 3, 4, 16–21, §12.4) and `CLAUDE.md`.
2. Ask the founder for folder access to `~/AIProjects/TrackAI-v1`, `~/AIProjects/_bundles` and (read-only) `~/dev/sushicorp`, `~/dev/agent-kit`, in one request. Bundle `main` into the workspace, clone, `npm ci`, `npm test` once (292 expected).
3. Estimate one line against T6. The plan says **about 0.08×**: 0.05× for the contract, raised for the migration (lesson: a contract plus a migration is at least 1.2×).

## 1. Read before writing
- **Inputs that decide the content:** `docs/plan/ATTESTA_QUESTIONS.md` in full, above all "Decisions for A15.0" (1–5), Codex's answers I1–I8 and the gaps G1–G5; `docs/plan/TASK15.md` §1 (R1–R11), §2 (decisions 1–7), §6, §7 (decisions 1–5).
- **Merged code to build on:** `apps/api/src/features/attesta/{canonical,merkle,dsse,signer-contract}.ts` and the handoffs `docs/handoffs/Task15a-attesta-primitives_HANDOFF.md`, `docs/handoffs/Task15b-attesta-signer_HANDOFF.md`.
- **Task2 sources the predicate reads** (read-only; cite `file:line` for every field you map): `apps/api/src/core/db/schema.ts` (`scm_commits`, `scm_commit_files`, `ai_sessions`, `ai_commit_sessions`, `ai_commit_model_attributions`, `scm_pull_requests`, `scm_pull_request_commit_memberships`, `scm_merge_lineage`, `scm_deployments`, `ai_code_lifecycle_events`, `security_findings`, `telemetry_metric_events`, `provider_event_deliveries`), `features/telemetry/{service,authorship-note}.ts`, `features/scm/{scm.routes,lifecycle-service,parser}.ts`.
- **Contract style to match:** `docs/contracts/task6/README.md` and its schemas and `fixtures/manifest.json` (Draft 7, closed objects, a fixture manifest with expected results).

## 2. Scope (approved)
### 2.1 Deliverables
All new files under `docs/contracts/attesta/` are created by this session and frozen when merged.

1. **`README.md`**: what is frozen, the versioning rules (below), the privacy rules, file list.
2. **`statement-v1.schema.json`**: an in-toto Statement v1 (`_type` `https://in-toto.io/Statement/v1`), with subjects:
   - `commit_observed`: one subject `{name: "git+<canonical repo URL>@<sha>", digest: {gitCommit: <sha>}}`;
   - `pr_merged`: the merge (or squash/rebase result) commit as subject, PR reference in the predicate;
   - `deployed`: the deployed commit as subject.
   Settle the exact `name` form and whether the repository URL appears at all (it is customer data; a tenant-scoped repository ID may be safer). Record the choice and why.
3. **`predicate-ai-provenance-v1.schema.json`**: predicate type final URI (`https://trackai.dev/attesta/ai-provenance/v1` unless you have a reason; record it). Required content:
   - `statement_kind` (`commit_observed` | `pr_merged` | `deployed`), `as_of`, `builder` `{name, version}`, `calculation_version` where lifecycle values appear, `source_evidence` (IDs and digests: `telemetry_metric_events.id`, provider delivery ID, `note_digest` per decision 2), `previous` (digests of earlier statements about the same subject, possibly empty), `first_seen_at` with its source;
   - line counts AI / human / unknown per commit and per file path, tools, models, sessions (pseudonymous session IDs), committer and merged-by as pseudonymous IDs, lifecycle stage, PR identity and merge lineage (with its confidence), deployment identity, policy references (repository enrollment, security-monitor setting, rule-pack version), security finding counts by category (monitor-only wording), reviewers/approvals;
   - **availability on every field** (`recorded` | `partial` | `unavailable`), with reviewers, merged-by, org policy and repo snapshot `unavailable` in v1 (decision 5);
   - **numbers are integers within ±(2^53 − 1)**, never floats (Attesta canonicalization accepts some large doubles; the predicate must not rely on that);
   - **no raw prompts, responses, code, diffs, commit messages, file contents or emails**. File paths: decide whether paths are allowed in the predicate or hashed (they can be sensitive); record the decision.
4. **Versioning rules** (in the README): additive minor versions within `…/v1` (new optional fields only); the builder validates its own output strictly against the version it writes; verifiers ignore fields they do not know; a breaking change is a new predicate type `…/v2`. A signed statement never changes: a later fact is a new statement that lists the earlier one in `previous`.
5. **`envelope.md`**: DSSE with `payloadType` `application/vnd.in-toto+json` (`IN_TOTO_PAYLOAD_TYPE`); payload = the exact `canonicalize()` bytes of the statement; signed through `signVerified(adapter, pae, { credentialId, tenantId, requestId })`. **Deduplicate on the statement digest** (SHA-256 of the canonical statement bytes), **never on envelope bytes** (ECDSA signatures are randomized and malleable).
6. **`outbox.md`** and the **`attesta_subjects` table**: columns (tenant, repository, kind, the source IDs per kind, `event_at`, created time, worker fields for later claiming: status, attempts, `claimed_at`, `last_error_code`, `processed_at`), the **unique idempotency key per kind** exactly as decision 4 of `ATTESTA_QUESTIONS.md` says, which transaction writes each kind (Codex's I8 table), the rule that nothing on the ingestion path waits for signing, and the rule that new kinds are additive.
   - Migration (next free number: check `apps/api/drizzle/`; `0016` at the time of writing) generated with `drizzle-kit generate` from a `schema.ts` addition; composite `(tenant_id, …)` foreign keys; RLS enabled with no browser policies; applied once through `scripts/it-db.sh` (AGENTS.md §9 items 3–4; §7).
   - A typed, tenant-bound insert helper for Codex: `apps/api/src/features/attesta/outbox.ts` with `enqueueAttestaSubject(tx, input)`, which takes the caller's open transaction, inserts with `ON CONFLICT DO NOTHING` on the idempotency key and returns the existing or new row ID. Unit tests for input validation; an integration test `IT-T15c-01` through `scripts/it-db.sh` for idempotency on replay and Company A/B isolation.
7. **`tables.md`** (design only, built in A15.3/A15.5): `chain_head`, `attesta_records` (stored canonical bytes, `record_hash`, `prev_hash`, gap-free `seq`, statement digest unique per tenant), `attesta_envelopes`, `attesta_anchor_batches` and `attesta_anchors` (append-only, never changing `record_hash`), with the invariants of `TASK15.md` §6.
8. **`api.md`** (design only, built in A15.9): auditor-readable `GET` routes for statements by subject, kind and time; verify report; evidence-pack export. RFC 7807 problem responses, keyset paging, `X-Request-ID`, `no-store` (catalog AP-1).
9. **`errors.md`**: stable error codes for builder, signer (`SigningUnavailable` vs `SigningRejected` mapping), ledger, anchoring and verification.
10. **`mapping.md`**: how predicate fields map to CycloneDX properties and SPDX 3.0, under a reserved property namespace `trackai:attesta:*`, so a later export (phase 2) is lossless without a predicate v2. Mapping note only; no export code.
11. **`fixtures/`**: synthetic valid statements for each kind and invalid ones (raw content present, float or unsafe integer, missing availability, unknown `statement_kind`, a zero where availability is `unavailable`), with `fixtures/manifest.json` giving the expected result for each. A unit test checks every fixture against the schemas and the manifest. If schema validation needs a dependency not already declared in `apps/api/package.json`, **ask the founder** first; `ajv@6` is in the lockfile only as a transitive dependency, so do not rely on it implicitly.

### 2.2 Design checkpoint (stop once)
Before writing the schemas, send the founder (a) the predicate field table: field, source table and column (`file:line`), availability in v1, the question it serves (Q1–Q20); and (b) the outbox columns and idempotency keys. Wait for "go" or changes.

### 2.3 Port from
- Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` EV-1, EV-2, RP-1.
- SushiCorp @ `0bd67a5`: `contracts/schemas/decision_record.schema.json` (closed record schema style), `db/migrations/versions/0001_initial_schema.py` (chain_head and evidence guards, for `tables.md`), `services/reporting/signing.py` (RP-1 statement-signing pattern), `docs/handoffs/MODULE_B3_HANDOFF.md`, `MODULE_A2b_HANDOFF.md`. Read with `git -C ~/dev/sushicorp show 0bd67a5:<path>`.
- Keep: closed schemas, stored canonical bytes, statement digest as identity, anchoring separate from the record. New: in-toto/DSSE envelope and the outbox (SushiCorp had neither). Record provenance and deviations in the README and the handoff.

### 2.4 Pre-approved files
`docs/contracts/attesta/**` (new), `apps/api/src/core/db/schema.ts` (the `attesta_subjects` table only), one new migration in `apps/api/drizzle/` with its `meta/` snapshot, `apps/api/src/features/attesta/outbox.ts` and `outbox.test.ts`, an integration-test script for `IT-T15c-01` under `apps/api/src/features/attesta/` with its `apps/api/package.json` script entry, `docs/handoffs/Task15c-attesta-contract_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row, integration test registry row), `docs/plan/TASK15.md` (A15.0 status and a pointer to the contract).

### 2.5 Never touch
Every other path under `docs/contracts/`, merged migrations, Task2/Task4 files (`features/telemetry/**`, `features/scm/**`: A15.7 is Codex's), Task15a/15b files (`canonical.ts`, `merkle.ts`, `dsse.ts`, `signer-*.ts`), `apps/web/`, `package.json` dependencies without the founder's yes.

## 3. Working rules
- Commits `Task15c-attesta-contract: …`, explicit staging. Order: README and versioning rules; schemas and fixtures; outbox migration and helper; design notes.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean; `drizzle-kit check` clean; `IT-T15c-01` once through `scripts/it-db.sh` (install `postgresql-16-pgvector` in the workspace; no Docker).
- Before the handoff, one **review subagent** that has not seen the work (`CLAUDE.md`): give it this prompt, `ATTESTA_QUESTIONS.md` and the diff, ask for must-fix and should-fix with `file:line`, with attention to adversarial inputs to every rule (a statement that validates but lies; replayed outbox rows; cross-tenant rows; raw content smuggled in a free-text field).

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 80 lines: the frozen files, the decisions you took (subject name, paths, predicate URI, validator), the outbox interface for Codex, Integration test impact, Effort.
- `TASK15.md` A15.0 🟡 (✅ once merged); status board row; integration test registry row for `IT-T15c-01`.
- Bundle the branch to `~/AIProjects/_bundles` and give the founder the fetch commands. Final reply in the AGENTS.md §12.4 shape, with the review request for Codex in a `text` block.

## Lessons so far
- **Task15a (Muse):** the "check, then use" gap: a value validated in one pass and read again later can change between the two (getters, proxies). Validate and use the same snapshot. Sparse arrays and unsafe integers need explicit refusals.
- **Task15b (Muse):** verify every claim an adapter returns (key type, algorithm, credential, tenant), and treat malformed output as terminal; bind signing to the tenant.
- **adopt-agent-kit, stage2-project-map (Claude):** facts not taken from the code cost review rounds: cite `file:line` for every Task2 field you map.
- **Task15-attesta-questions (Claude):** the review caught current-state claims that contradicted the gap list; say "not captured yet" wherever a field is `unavailable`.
