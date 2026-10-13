# Task15h-attesta-builder Handoff — Attesta statement builder (A15.8)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15h-attesta-builder` (base `main` `c5cf7cb`). The worker turns each `attesta_subjects` row into an `ai-provenance/v1` statement, signs it (DSSE, dev signer) and chains it, mapping every outcome to the outbox protocol. No anchoring (A15.5), no routes (A15.9), no production keys (A15.6, A15.12), no migration, no contract edits.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | `SignerResolver` + `devSignerResolver`; `buildStatement` for three kinds; `runBuilderPass`; `attesta:build`, `attesta:requeue` | ✅ |
| Contract | The four `valid-*` fixtures reproduced byte for byte from seeded rows, after the named substitutions and adjustments F1, F3–F5 below | ✅ |
| Quality | `npm test` 502 pass (55 new); API + web typecheck, lint | ✅ |
| Integration | IT-T15h-01…04 pass once in the agent sandbox | 🟡 founder run ⬜ (blocking: A15.8 merge) |
| Review | Independent subagent: 3 must-fix + 9 should-fix; all fixed except the contract items below; cross-agent review (Codex) | ✅ / ⬜ |

## Implemented interfaces
```ts
// signer-resolver.ts
interface SignerResolver { resolve(tenantId: string): Promise<{ adapter: SigningAdapter; credentialId: string } | null> }
devSignerResolver({ credentials?, sharedKeyPem?, env? }): SignerResolver   // refuses NODE_ENV=production
// builder.ts
buildStatement(readTx, subjectRow, { builderVersion, maxPayloadBytes }): Promise<{ statement; canonical; digest; previousSeen }>
class AttestaBuilderError { code; retryable; wait }   // errors.md §Builder codes
// worker.ts
runBuilderPass(db, resolver, { limit, maxAttempts, builderVersion, leaseMs = 600_000 }): Promise<BuilderPassResult>
requeueFailedSubjects(db, { tenantId, code, actorId, confirm, expect? }): Promise<{ dryRun; matched; requeued }>
```
CLIs: `ATTESTA_DEV_SIGNER_KEY_FILE=<p256.pem> npm run attesta:build -w apps/api [-- --loop --limit=50 --max-attempts=8]`; `npm run attesta:requeue -w apps/api -- --tenant <uuid> --code ATTESTA_… --actor <name> [--confirm=REQUEUE --expect=<n>]` (dry-run by default, one audit row per apply). Port from: none for the builder; the worker follows `outbox.md` (SushiCorp `services/anchoring/service.py` @ `0bd67a5`, EV-2); deviations in the `worker.ts` header.

## Field sources (`fields.md`, checked row by row) and interpretations
Every field is read only from its named source, with tenant-bound SQL (no `withTenant`: the joins, the microsecond times and in-database hashing need raw SQL, as in `ledger.ts`/`outbox.ts`). URLs, emails and the stored note are hashed or matched inside PostgreSQL. The only raw content read is the source event's note (and its session attributes), to derive digests; nothing raw is logged, stored or put in an error. Where `fields.md` is silent, I chose:
1. `commit_observed` sessions/models/findings: only the identities its own note named (Task2 never deletes earlier notes' rows; B1 applied to attribution).
2. `pr_merged`/`deployed` sessions, models, tools, lifecycle and findings: the merge lineage's source commits that Git AI normalized, plus the subject itself if normalized; `partial`/`only_some_sources_reported` when a source was not.
3. The subject's own Git AI columns (operation kind, times, lines, committer) need a Git AI observation (`committed` lifecycle row); otherwise `source_missing`. `files` and `note_digest` for these kinds: `source_missing` (no anchoring event).
4. Findings always `partial`/`linked_by_session_string_not_key`; monitor mode = the one in force (Task6 activation rule). `delayed_build` after 24 h. `deployed.pull_request`: exactly one merged PR naming the sha, else `source_missing`.

## Contract findings (frozen files not touched; for the orchestrator)
| ID | Finding | What the code does |
|---|---|---|
| F1 | `valid-*` fixtures carry placeholder digests (`2222…`, `sha256:9999…`) nothing hashes to | Fixture test maps computed → placeholder by name |
| F2 | Schema limits `previous` kinds per kind; the ledger needs every earlier statement. A later note about an already-deployed commit (or a PR built after its deployment) can never be signed | Orders kinds within a subject (waits, no attempt spent); otherwise fails `SCHEMA_INVALID` by name. **Needs a decision** |
| F3, F4 | Fixtures say findings `recorded` (`fields.md`: `partial`) and list a rule pack with zero findings | Follows `fields.md`; lists none |
| F5 | `valid-pr-merged` lifecycle `partial`/`lineage_still_being_enriched` while lineage is recorded | `recorded` |
| F6 | `outbox.md` claim (`IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`) claimed 6 rows with n = 3 (IT-T15h-02) | `MATERIALIZED` CTE |
| F7 | `model_key` (S8) longer than a token (two hashed values, long ARNs) cannot be represented | Row left out, `only_some_sources_reported` |
| F8 | `previous` ≤ 64, sessions/models ≤ 500 fail beyond; no `errors.md` code for "crashed at the attempt limit" | Terminal `SCHEMA_INVALID`; lease limit uses `ATTESTA_LEDGER_CLAIM_LOST` |

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | `ajv` is a devDependency but the worker validates at runtime | Move to `dependencies` before production (one-line PR, approve) |
| 🟡 | Dev signer only; schemas read from `docs/contracts/attesta` at runtime | A15.6/A15.12 add production resolvers; Task14 must ship `docs/contracts/attesta` |
| 🟡 | `pr_merged`/`deployed` sources' projections accumulate across notes (no anchoring event) | Reported as Task2 holds them |
| 🟡 | An unexpected error (DB loss, bug) leaves the row claimed for the 10-minute lease | Bounded by `maxAttempts` at recovery |

## Test coverage
Unit (no DB; database seeded, worker build/chain stubbed, signer real): fixture reproduction; every availability branch; rules 1–3; hashing; truncation and `TOO_LARGE`; each code → pending / failed / stop / left claimed; claim-guarded releases; waits; commit-time errors; re-queue; every query checked per table for tenant binding and for never selecting URL, email or note columns. Live: all real.

## Integration test impact
> **FOUNDER:** blocking for the A15.8 merge. Prerequisites: Docker or local PostgreSQL 16 + pgvector. Expected: 4 passed, under a minute.
> ```bash
> scripts/it-db.sh npm run verify:task15h-builder-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15h-01 | Task2 ingestion of a commit note, merged PR (with lineage) and production deployment → 3 chained statements; envelopes and `verifyChain` ok with the dev key; PR lineage names the commit statement, deployment `previous` names the PR; note, ranges, URL digests and a Task6 finding match the stored rows | Blocking: A15.8 merge | 🟡 agent-verified · ⬜ founder run |
| IT-T15h-02 | Second pass adds nothing; two notes for one sha sign only what each proves; crash after signing → lease recovery → one statement; lease taken over → `CLAIM_LOST`; two parallel workers (3/3) chain each row once | Blocking: A15.8 merge | 🟡 · ⬜ |
| IT-T15h-03 | No credential → `failed`; re-queue CLI dry-run, stale confirm refused, confirm + audit row → done; `SigningUnavailable` → pending with 30 s backoff; build CLI runs | Blocking: A15.8 merge | 🟡 · ⬜ |
| IT-T15h-04 | Company A/B: each builds from and chains into its own data only; a forged B row naming A's commit fails `SOURCE_MISSING` | Blocking: A15.8 merge | 🟡 · ⬜ |

## Integration notes
A15.9 reads `attesta_records` (statements link through `previous` and `merge_lineage[].source_statement_digest`); A15.5 anchors them (`verify-chain.ts` untouched). Production (Task14): schedule `attesta:build` with a production `SignerResolver`, `--lease-ms` ≥ 60 s, `TRACKAI_GIT_COMMIT` set.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens |
|---|---|---|---|---|
| about 0.25× (plan 0.2×) | about 0.3× | ~120 turns + 1 review round | ~4 h | n/a |
Over 1.25× the plan: (1) reconciling three fixtures with `fields.md` and the ledger (F1–F5, F2); (2) the review found three must-fix items (note scoping, F2, F7); (3) the live test exposed the claim over-claim (F6). Next builder-like prompts: budget a fixture-vs-source reconciliation pass before coding.
