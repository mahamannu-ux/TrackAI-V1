# Q&A contract (Task19a, T19.2)

*Frozen once merged: additive changes only. A rename is a breaking change. Owner: Task19 (`docs/plan/TASK19.md`). Source catalogue: `docs/plan/CUSTOMER_AUDITOR_QA.md`.*

Every surface that answers a customer's or an auditor's question uses this contract: the admin **Questions** screen (Task19e), the live answers (Task19b, Task19c, Task19d) and the auditor's verifiable and signed answers (Task16 A16.13). The contract itself answers nothing. Answers plug in through the answerer registry.

| File | What it is |
|---|---|
| `questions.md` | The question registry, **generated** from `apps/api/src/features/qa/registry.ts` (`npm run qa:registry -w apps/api`); a unit test fails when it is stale |
| `answer-v1.schema.json` | The answer envelope (JSON Schema Draft 7, closed objects) |
| `api.md` | The `/api/qa/*` routes, parameters and problems |
| `fixtures/` | One valid envelope per kind × availability, and invalid ones named after what is wrong; the schema tests use them, and A16.13 builds against them |

## The rules in plain words

1. **One registry.** Each question has a stable id (`Q1`…`Q20`, `S1`…`S26`), a family, a rank, an auditor flag, the kinds of answer it offers (and who builds each), its open gaps, the scopes it accepts, the breakdowns it allows, whether it compares with the previous period, and the caveats every answer must show. `QA_REGISTRY_VERSION` goes up whenever an entry or a gap changes, and a unit test pins each version's content. Ids are never reused.
2. **Three kinds of answer.**
   - `live` is a query over today's tables. It proves nothing and is for admins only.
   - `verifiable` is computed only from signed Attesta statements. Each figure lists the statements behind it (`evidence`: count, seqs, digests and an RFC 6962 root, as in RP-1 and `docs/contracts/attesta/period-report.md`). In a verifiable or signed answer, every `recorded` or `partial` figure, in `figures` and in `previous`, **must** carry `evidence`; the schema refuses one without it.
   - `signed` is a signed report: the envelope names its `statement_digest` and `predicate_type`.

   There is no hybrid (TASK19.md D2). A live answer may carry `signed_evidence`, a link to `GET /api/attesta/statements` for the same scope, but never the statements themselves.
3. **Auditors get verifiable and signed answers only.** The server refuses `kind=live` to `tenant_auditor` (rule 9). Hiding it in the UI is not enough.
4. **Honest states.**
   - Every figure says `recorded`, `partial` or `unavailable`, with reasons from a closed list. A `not_captured_yet` reason names its gap.
   - Task16 A16.13 (auditor verifiable/signed answers) added four closed-list codes: `not_sealed_yet` — part of the period is not sealed yet (the settle margin plus the hourly seal), so only the sealed part is counted; `evidence_broken` — a seal or chain check found a break, and the answer is `unavailable`; `report_not_built` — no signed report exists for exactly this scope, and the auditor can request one; `evidence_truncated` — more than 50 000 statements behind one figure, so it is `partial`.
   - `data_setting_off` means the tenant's security data settings keep the needed data on the developer machine.
   - `zero_denominator` means a ratio has no recorded denominator in this period.
   - An unavailable figure has value `null`, **never 0**. A partial live figure may also have `null` when capture has not begun, as Q15 does before its first managed-upload rejection; it must carry a reason. Recorded figures keep a value.
   - A question with no answer built yet still answers: `unavailable`, with `answer_not_built` (or `phase_2`) and its open gaps.
5. **Integers only.** A value is a count, a ratio (numerator and denominator, never a float) or a duration in milliseconds, within ±(2^53 − 1). A share is computed for display only.
6. **Required wording.**
   - Every security answer carries `monitor_only_observed`: findings are "observed", never "blocked" or "prevented" (rule 7).
   - The other caveats (`unknown_model_explicit`, `merged_not_deployed_proxy`, `churned_unavailable`, `session_link_partial`, `requested_not_confirmed`, `metadata_only`) are required where the registry says so. The UI must render each one.
7. **No person.**
   - No scope, dimension or drill-down ever names a person (`developer`, `contributor`, `author`, `committer`, `user` and the like). A unit test refuses one.
   - Team, repository and machine are the finest levels (Task5's no-surveillance rule; Q20, S17).
8. **No raw content.**
   - No envelope field carries a prompt, a command, code, a file path, a diff or a session's text. A `file` drill-down carries the file row's id only. A `session` carries its id only. A label never contains a path separator.
   - Task5's gated raw reveal stays the only way to raw content (rule 6).
9. **Live answers reuse Task2's semantics** (rule 8). They read lifecycle figures only through `features/telemetry/task2-lifecycle-read.ts` and `lifecycle.ts`, the only Task2 files `features/qa/` may import. A figure Task2 has no function for is an open issue for Task2, never a new query.
10. **The server checks every answer.** An envelope that fails the schema or the registry rules (other question, kind or scope; missing wording; `previous` on a question that does not compare, or missing on one that does) never reaches the client. The response is 503 `QA_ANSWER_INVALID`.
11. **Tenant-bound.** Another tenant's repository, pull request or commit gets the same 404 as an unknown one.

## Answerer interface (what Task19b/19c/19d and A16.13 build against)

```ts
import { registerAnswerer } from 'apps/api/src/features/qa/answerers';
registerAnswerer('Q3', 'live', async (ctx) => envelope);
// ctx: { tenantId, questionId, kind, role, scopeLevel, scope: {repository_id?, pull_request_id?, commit_sha?, file_id?, line?, from, to}, breakdown, now }
```

One answerer per question and kind. Registering for a kind the question does not offer, or a second time, throws. `as_of` is the query time (`ctx.now`) for `live`, the newest input statement's `recorded_at` for `verifiable`, and the report's signed time for `signed`. For an unavailable signed answer (no report yet), `signed` may be omitted.
