# Task15c-attesta-contract Handoff — Attesta statement, predicate and outbox contract (A15.0)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15c-attesta-contract` (base: `main` at `e54b87b`, rebased after the Codex review).

Freezes the interfaces Attesta builds against: the in-toto statement and `ai-provenance/v1` predicate, the `attesta_subjects` outbox Task2 writes (migration `0016` plus a typed writer), and the designs of the ledger tables, routes, error codes, the SBOM mapping and the new `period_report` statement. It does not build the builder, ledger, signer worker, anchoring or routes.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | §2.1 deliverables 1–11 under `docs/contracts/attesta/` (+ `fields.md`, `period-report.md`) | ✅ |
| Scope | design checkpoint approved 2026-10-12; `period_report` added at the founder's request | ✅ |
| Quality | `npm test` 392 pass (66 from this session), typecheck, lint, `npm run check`, `drizzle-kit check` clean | ✅ |
| Integration | IT-T15c-01 via `scripts/it-db.sh` | 🟡 agent-verified; founder run pending, blocking A15.7 merge |
| Review | review subagent: 4 must-fix, 8 should-fix, then 1 new must-fix on re-check; all fixed (two token cases accepted as residual risk, below) | ✅ · Codex review (fix first): source binding, deployment boundary, rebase; all fixed, re-review pending |

## Implemented interfaces
```
docs/contracts/attesta/: README.md, statement-v1.schema.json, predicate-ai-provenance-v1.schema.json,
  fixtures/ (51 + manifest), fields.md, envelope.md, outbox.md, tables.md, api.md, errors.md,
  mapping.md, period-report.md
apps/api/src/features/attesta/outbox.ts:
  enqueueAttestaSubject(tx, input): Promise<{ id: string; inserted: boolean }>
  normalizeAttestaSubjectInput(input), AttestaOutboxError(code), ATTESTA_SUBJECT_KINDS
  input: commit_observed {tenantId, repositoryId, commitSha, metricEventId, commitId, notBefore?}
       | pr_merged {…, commitSha=merge sha, provider, providerDeliveryId, pullRequestId, notBefore?}
       | deployed {…, commitSha, provider, providerDeliveryId, deploymentId, deploymentExternalId,
                   deploymentStatus:'success', notBefore?}      (event_at is copied from the source row)
apps/api/src/features/attesta/contract-rules.ts: checkStatementRules(statement) → S1–S12 violations
apps/api/src/core/db/schema.ts: attestaSubjects; migration apps/api/drizzle/0016_attesta_subjects.sql
npm run verify:task15c-outbox-live -w apps/api   (IT-T15c-01)
```

## Ported from
SushiCorp @ `0bd67a5` (catalog EV-1, EV-2, RP-1): closed record schema (`decision_record.schema.json`), stored canonical bytes and digest identity, chain guards and anchors kept apart (`0001_initial_schema.py`, handoffs B3, A2b), RP-1 statement-over-report-digest (`services/reporting/signing.py`). Deviations: in-toto + DSSE instead of bare JCS records; a Task2 outbox (SushiCorp had none); Draft 7 to match Task6.

## Founder-approved decisions (2026-10-12)
1. Subject `trackai:repository/<uuid>/commit/<sha>`, no repository URL; predicate carries `url_sha256`.
2. File paths only as `path_sha256`; unsalted hashes are "not disclosed, confirmable by guessing" (HMAC deferred).
3. Predicate type `https://trackai.dev/attesta/ai-provenance/v1`; availability wrapper on every field; G1–G4 forced `unavailable`.
4. `ajv@8.17.1` devDependency (exact), fixture test in strict mode.
5. `note_digest` from the note decoded from the source metric event; per-file unknown lines and `calculation_version` `unavailable` (proposed gap **G6**).
6. Outbox without source foreign keys; tenant bound by `INSERT … SELECT` over the source rows.
7. Developer level never a subject; `period_report` (own predicate type) added to phase 1, schema frozen in A15.9 (A15.9 sized 0.15×).

## Deviations from spec
- Shared files, all pre-approved: `schema.ts` (table only), migration `0016` (generated, with RLS and an identity-guard trigger appended as in 0013/0014), `apps/api/package.json` (script + ajv), `package-lock.json` (generated with npm 11 so the diff is additions only).
- Added `contract-rules.ts` and `contract-fixtures.test.ts` in Task15's own folder (the cross-field rules have one implementation the builder and verifier reuse).
- The outbox helper imports Task2's pure `normalizeRepositoryUrl` (read-only), so the commit binding uses `normalizeCommit`'s URL rule. `pr_merged` key includes `provider`; a deployed row's delivery ID is not compared on replay (a second success delivery is the same observation).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | `tool`, `model`, `model_key`, `operation_kind` are tokens: a short identifier-shaped string (a path, a branch-like name) still fits | Mitigated by "fill only from the named column" + hash fallback (`fields.md`); residual |
| 🟡 | `period_report` completeness proof shows other repositories' record metadata | A15.9 decides on a per-repository proof before repo-scoped sharing |
| ⬜ **FOUNDER:** | Gap G6 (Task2 calculation version) is proposed, not yet in `ATTESTA_QUESTIONS.md` | Non-blocking; add when convenient |

## Test coverage
Unit: every fixture against the schemas, S1–S12 and the manifest (4 valid, 28 schema-invalid, 19 schema-valid "lying"); schema closure and integer bounds walked; outbox validation, getter snapshot, SQL shape and replay/conflict/redelivery branches with a fake executor. Not mocked in IT-T15c-01: real PostgreSQL.

## Integration test impact
> **FOUNDER:** blocking for the A15.7 merge. Prerequisites: Docker or local PostgreSQL 16 with pgvector. Expected: `IT-T15c-01=passed`, under a minute.
> ```bash
> scripts/it-db.sh npm run -s verify:task15c-outbox-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15c-01 | replay, same-tenant event/commit, delivery/PR and delivery/deployment mismatches, stale stored pointer, redelivery, source `event_at`, rollback, concurrent writers, A/B isolation, immutable identity, shape check, RLS | Blocking: A15.7 merge, changes to 0016/`outbox.ts` | 🟡 agent-verified 2026-10-12 · ⬜ founder run |

## Integration notes
- A15.7 can start now (only its merge waits on IT-T15c-01): call `enqueueAttestaSubject(tx, …)` inside the observing transaction (`outbox.md` "Which transaction writes each kind"), `notBefore = now + 5 min` for `pr_merged`.
- A15.8: follow `envelope.md` builder steps and `fields.md` rules B1–B3; mark the row `done` inside the ledger transaction. Decision 2 is refined (digest from the source event), not changed.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.08× | about 0.12× | one session, ~110 turns + 2 review passes | ~3 h | n/a |

Over 1.25×: (1) `period_report` added mid-session (design note + plan changes); (2) the review found real gaps in the cross-field rules and outbox replay (two rounds); (3) 13 contract files plus a migration. Next prompts: budget a contract plus migration at 0.1× minimum, and have the reviewer attack the rules before the docs are written.
