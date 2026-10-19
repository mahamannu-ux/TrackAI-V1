# Handoff prompt: Task16h-auditor-qa (the auditor's verifiable and signed answers, A16.13a + A16.13b), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR, then run, in order:
>    1. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`
>    2. `make worktree M=Task16h-auditor-qa`
>    3. `cd ~/AIProjects/TrackAI-wt/Task16h-auditor-qa && npm ci && opencode`
>
>    Or reuse an idle Muse worktree: `git fetch origin && git switch -c task/Task16h-auditor-qa origin/main && npm ci`.
> 2. Pick Muse Spark, keep permission prompts on, and paste everything below the line.
> 3. When it finishes, run IT-T16h-01, then paste its review request to the **Task16 lead Claude chat**. Push only after "ready to push".

---

You are **Muse**, building **Task16h-auditor-qa** (Task16 A16.13a + A16.13b) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

The Q&A contract (`docs/contracts/qa/`, Task19a) has one registry of 38 questions and one answer envelope with three kinds:
- `live`: today's tables, admins only. Task19b and Task19c built these for the code and security rows.
- `verifiable`: computed **only from signed Attesta statements**. Every figure carries `evidence`: count, seqs, digests and an RFC 6962 root.
- `signed`: a signed period report named by its statement digest.

The auditor may ask only for `verifiable` and `signed` answers (TASK19.md D2). Today **no verifiable or signed answerer is registered**, so every auditor answer says `answer_not_built`. The Questions screen (Task19e) already renders all three kinds, the evidence and the caveats, and it requests a kind as soon as an answerer for it is registered.

This session registers the auditor's answerers, the code ones and the security ones, by reusing the computations Attesta already signs. **Every decision is made below.**
- No migration.
- No web change.
- No change to Attesta's signing, statements or reports.

- **Worktree:** `~/AIProjects/TrackAI-wt/Task16h-auditor-qa` (or a reused one), branch `task/Task16h-auditor-qa`. **Handoff:** `docs/handoffs/Task16h-auditor-qa_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 6–9, §4, §9 items 16–23, §11, §12.4).
2. Check your location and branch: `pwd && git branch --show-current` must show the worktree above and `task/Task16h-auditor-qa`, branched from the latest `origin/main`. Set the git identity for this worktree only.
3. Run `npm test` once. Estimate in one line against T6. The plan says **about 0.2×**; say so if you see more than 0.26×.

## 1. Read
- **The Q&A contract:** `docs/contracts/qa/README.md` (rules 1–11, "Answerer interface"), `api.md`, `answer-v1.schema.json` (`evidence`, `figure`, `reason`, the `allOf` rules), `questions.md`, `fixtures/valid-verifiable-*.json` and `fixtures/valid-signed-*.json`.
- **Code Task19 already built:** `apps/api/src/features/qa/answerers.ts` (`registerAnswerer`), `envelope.ts`, `answer-schema.ts`, `service.ts`, `answers/` (the live code answerers, the house style), `security-answerers.ts` (the pure `computeS5…computeS18`, `computeQ11` over a `SecurityContext`) and `security-read.ts` (`SecurityContext`, `toFindingRow`).
- **Attesta, read only, reused:**
  - `features/attesta/period-report-rules.ts`: `computeReportDocument`, `digestsRoot`, `Figure`, `DocumentFigure.contributions {count, records[{seq, digest}]}`.
  - `features/attesta/period-report-service.ts`: `pgReportStore(...).readSnapshot(tenantId, scope)`.
  - `docs/contracts/attesta/period-report.md`, especially the rule "one statement per subject".
  - `features/attesta/security-seal-service.ts`: `readSecurityRows`, `checkSecuritySealRows`, `parseSecuritySealDocument`, `pgSecuritySealStore`.
  - `features/attesta/security-report-service.ts` (`pgSecurityReportStore`, `SecurityReportReadStore`) and `docs/contracts/attesta/security-period-report.md`.
  - `features/attesta/audit-seal-service.ts` (`auditRowDigest`, `pgSealStore`) and `docs/handoffs/Task16e-audit-tamper_HANDOFF.md`.
  - `features/attesta/read-service.ts` (`pgReadStore`: statements by subject and range, verify) and `docs/contracts/attesta/fields.md` (which predicate field answers which question).
- **Handoffs:** `Task19a…19e` ("Implemented interfaces"), `Task15i4-attesta-period-report_HANDOFF.md`, `Task15op-attesta-security_HANDOFF.md`, `Task15op-b-attesta-security-report_HANDOFF.md` ("For Task19 … and A16.13b").

## 2. Scope (approved)
### 2.1 Where the code goes
- New folder `apps/api/src/features/qa/auditor/` (Task16-owned):
  - `evidence.ts`: evidence helpers;
  - `code-verifiable.ts`, `security-verifiable.ts`, `signed.ts`;
  - `register-auditor.ts`: one `registerAuditorAnswerers()` that registers every answerer below;
  - `auditor-answers.test.ts`;
  - `task16h-auditor-qa-live-verify.ts`.
- Call `registerAuditorAnswerers()` exactly where Task19 registers the live answerers (find the call to `registerSecurityAnswerers()` and the import of `answers/register-code.ts`). That one line is the only edit in Task19's files, apart from the contract addition in item 2.

### 2.2 Decisions
1. **Evidence (`evidence.ts`).**
   - `evidenceOf(records: {seq, digest}[])` returns `{count, statements_root, records}`, with:
     - records sorted by `seq` and de-duplicated;
     - `statements_root` = `digestsRoot(digests)` from `period-report-rules.ts`, the same root Attesta signs;
     - at most 50 000 records. Above that, the figure is `partial` with the first 50 000 records, and the answer gets reason `evidence_truncated` (item 2).
   - Every `recorded` or `partial` figure **must** carry evidence; the schema refuses one without it.
   - `as_of` = the newest input record's `recorded_at`. If there is no input, `as_of` is the query time and the answer is `unavailable`.
2. **Contract addition** (additive, Task19's contract, lead-approved; `QA_REGISTRY_VERSION` unchanged). Add four reason codes to the `reason.code` enum in `answer-v1.schema.json` and a line each in `README.md` rule 4:

   | Code | Meaning |
   |---|---|
   | `not_sealed_yet` | Part of the period is not sealed yet (the settle margin plus the hourly seal), so only the sealed part is counted |
   | `evidence_broken` | A seal or chain check found a break; the answer is `unavailable` and names nothing else |
   | `report_not_built` | No signed report exists for exactly this scope; the auditor can request one |
   | `evidence_truncated` | More than 50 000 statements; the figure is `partial` |

   Add one valid fixture per new code (`valid-verifiable-not-sealed.json`, `valid-signed-report-not-built.json`), and extend the schema tests.
3. **Code questions, verifiable (A16.13a).** Use the **period-report computation** on the statements in range: `pgReportStore(db).readSnapshot(tenantId, {repository_id, from, to})`, then `computeReportDocument`.
   - Each report figure's `contributions.records` becomes that figure's evidence.
   - **Tenant scope:** run the computation once per repository that has statements in the range (at most 200; above that, the answer is `partial` with `evidence_truncated`), and sum the values. The evidence is the union.
   - Mapping (figure keys in snake_case; values are counts or ratios as integers; never a float):

     | Question | Scopes | Figures (from the report document) | Wording and gaps |
     |---|---|---|---|
     | Q1 | tenant, repository | `ai_lines_changed`, `human_lines_changed`, `unknown_lines_changed`, `ai_share_of_changed_lines` (ratio) | G1: the whole-repository share is not a figure; add the `not_captured_yet` G1 reason |
     | Q3 | tenant, repository | `prs_merged`, `merged_ai_lines` with breakdown by `model` and `tool` (from the report's "merged AI lines by tool and model"), `ai_share_of_merged_lines` (ratio) | `unknown_model_explicit` |
     | Q9 | tenant, repository, pull_request | `production_deployments` | `merged_not_deployed_proxy` |
     | Q13 | tenant, repository, commit | `commits_observed`, `unknown_lines_changed`, plus the report's completeness counts as figures `inputs_partial` and `inputs_unavailable` | — |

     For `pull_request` and `commit` scopes, filter the snapshot's inputs to that subject before computing. Follow "one statement per subject": the latest statement in range counts.
   - **Built from statements directly** (`pgReadStore` subject and range reads, then parse each statement's predicate per `fields.md`):

     | Question | Figures | Notes |
     |---|---|---|
     | Q4 | `commits_by_model` (breakdown `model`, `tool`) | `approval` is `unavailable` with `not_captured_yet` G2; `unknown_model_explicit` |
     | Q7 | `statements_checked`, `breaks` | Run the same verify as `/api/attesta/verify` over the scope's seq range (at most `MAX_VERIFY_RANGE`). The evidence is the checked records. If there are any breaks, `breaks` is recorded and the answer still returns: the break count is the honest answer. If signatures or anchors could not be checked, `partial` |
     | Q8 | commit scope only: `statements` (count), `first_seen_to_signed_ms` (duration, from the predicate's `first_seen_at` to the record's `recorded_at`), `signed_late_statements` (count) | — |
     | Q11 | `findings_observed` with breakdown `rule_category` and `severity`, from `security_findings_observed` | `partial`, reason `partial_linkage`; `monitor_only_observed`, `session_link_partial` |
     | Q14 | pull_request scope: `commits_with_statements`, `pr_merged_statements`, `deployed_statements`; drill-down items = the commits (ids only) | `metadata_only` |
     | Q16 | `statements_in_scope` (count, evidence) | No action field: the screen's evidence link opens the Attesta workspace, which exports the pack |

   - **Not built here:** Q5, Q6, Q12 and Q15. Their default answer stays `answer_not_built` plus their gaps. List them in the handoff.
4. **Security questions, verifiable (A16.13b).**
   - **Load sealed rows:** read the tenant's `attesta_security_finding_seals` overlapping `[from, to)`. For each seal window, read the rows with `readSecurityRows` and run `checkSecuritySealRows(document, sealDigest, rows)`.
     - Any break: the answer is `unavailable` with `evidence_broken`.
     - Only rows inside sealed windows count. If `to` is after the last seal's `window.to`, the figures are `partial` with `not_sealed_yet`. If no seal overlaps, the answer is `unavailable` with `not_sealed_yet`.
   - **Evidence** for every figure = the covering seal records: each seal's ledger record `seq` and `statement_digest`.
   - **Compute:**
     - Convert the verified rows to Task19's `SecurityFindingRow` with `toFindingRow` (or an equivalent mapping over the same metadata allow-list, never a preview column).
     - Build a `SecurityContext` holding those findings only, with the other arrays empty.
     - Call Task19c's pure `computeS7 … computeS12` on it.
     - Then set `kind: 'verifiable'`, add the evidence to every `recorded` or `partial` figure, and add the reasons above.
     - A figure the compute marks `unavailable` stays unavailable.
   - **Questions built this way:**
     - **S7** (with `previous`, where the previous window gets its own seal check and evidence);
     - **S8, S9, S10, S11, S12**;
     - **S1** (new pure compute in `security-verifiable.ts`): `high_or_critical_findings` with breakdowns `rule`, `rule_category`, `severity`, `repository`; G9 stays as a reason (rule coverage).
   - **S15:** the audit trail. Read `attesta_audit_seals` overlapping the period, and the audit rows in those windows. Check each row with `auditRowDigest` against its seal's document; any break gives `evidence_broken`. Figures:
     - `security_findings_reads` (breakdown `actor_type`, never a person);
     - `raw_evidence_reveals`.

     The evidence is the audit seal records; unsealed tail gives `not_sealed_yet`.
   - **Not built here:** S2, S3, S4, S5, S6, S13, S14, S16. Their default stays `answer_not_built` plus gaps. S6 needs commit statements joined to sealed findings, and the join is by session text (G10), so it waits. List them in the handoff.
   - **Wording:** every security answer carries `monitor_only_observed`, plus each question's registry wording. "Observed", never "blocked".
5. **Signed answers (`signed.ts`).**
   - **Code (Q1, Q3, Q9, Q13):** look up the newest stored Task15i4 period report whose stored scope is **exactly** the request's `repository_id`, `from` and `to`.
     - If found: `signed = {statement_digest, predicate_type: 'https://trackai.dev/attesta/period-report/v1'}`, with figures mapped from the report's predicate as in item 3. Evidence per figure = that figure's `contributions` from the stored document.
     - If not found: `unavailable` with `report_not_built`.
     - Only repository scope applies. At tenant scope the answer is `unavailable` with `report_not_built`, because the code period report is per repository.
   - **Security (S1, S7, S8, S9, S10, S11, S12):** the same with Task15op-b's `security_period_report`. The scope is tenant or repository, the predicate type is `https://trackai.dev/attesta/security-period-report/v1`, and figures come from the stored document (`findings`, `by_severity`, `by_category`, `by_rule`, `by_repository`, `by_agent`, `by_model`, `by_platform`, `outcomes`). The evidence is the report's covering seal records. `blocked` and `coverage` stay `unavailable` as the report says. `denied_by_request` is a request count, never "blocked".
   - **S2** signed stays unbuilt: coverage is always unavailable in the report.
6. **Auditing:** reading a verifiable or signed answer writes **no** audit row. This follows Q&A v1 and the founder's read-receipt concern, and the underlying Attesta and audit reads are not re-audited. Record the decision in the handoff, since `api.md` "Audit" leaves it to A16.13.
7. **Tenant isolation:** every read is bound to `ctx.tenantId`. Another tenant's repository, pull request or commit already gets 404 in the Q&A service, so do not re-implement that. The auditor database role (`withAuditReader`, Task16e2) applies to the audit-seal and audit-row reads for S15.

### 2.3 Port from
None new. This session composes code already ported: RP-1 through Task15i4 and Task15op-b, the seal checks of Task16e and Task15op-a, and Task19c's computations. Say so in the handoff.

### 2.4 Pre-approved files
- `apps/api/src/features/qa/auditor/` (new, the files in §2.1).
- The one registration line in Task19's registration site.
- `docs/contracts/qa/answer-v1.schema.json`, `README.md` and the two new fixtures (item 2, additive), plus the schema test that lists fixtures.
- `apps/api/package.json`: register `src/features/qa/auditor/auditor-answers.test.ts` and add `verify:task16h-auditor-qa-live`, in alphabetical position.
- Exporting existing functions from `features/attesta/*` if one you need is not exported. Add `export` only, with no behaviour change; name each in the handoff.
- `docs/handoffs/Task16h-auditor-qa_HANDOFF.md`; `docs/plan/TASK16.md` (the A16.13 row and the Task16h row only); `docs/plan/STATUS_BOARD.md` (your registry row and the remaining-plan actual only).

### 2.5 Never touch
- Migrations; Attesta signing, statements, report builders and their contracts.
- Task19's live answerers, other than the one registration line.
- `apps/web/`; `QA_REGISTRY_VERSION` and `registry.ts`.

If an answer needs any of these, **stop and write the question for the lead**.

## 3. Working rules
- **Commits** `Task16h-auditor-qa: …`, staged with explicit `git add <path>`. Commit in this order:
  1. the contract addition;
  2. `evidence.ts`;
  3. the code verifiable answers;
  4. the security verifiable answers;
  5. the signed answers;
  6. the registration;
  7. the live verify;
  8. the handoff.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (`auditor-answers.test.ts`, no database; in-memory snapshots built with the real Attesta builders from the Task15i4 and Task15op tests):
  - every registered answerer returns an envelope that passes Task19's validator (`answer-schema.ts` plus the registry rules);
  - every `recorded` or `partial` figure has evidence whose `statements_root` recomputes;
  - `unavailable` figures are `null`, never 0;
  - a tampered row gives `evidence_broken`;
  - a period past the last seal gives `partial` with `not_sealed_yet`;
  - no seal gives `unavailable`;
  - a signed lookup with no exact report gives `report_not_built`;
  - one statement per subject (a superseded statement is not counted);
  - tenant scope sums the repositories;
  - `kind=live` for an auditor is still 403, and there is no person dimension anywhere.
- **IT-T16h-01** (`scripts/it-db.sh npm run verify:task16h-auditor-qa-live -w apps/api`). Seed signed statements and seals with the helpers of the Task15i4, Task15op and Task16e live verifies (reuse them; do not re-implement signing). On a throwaway database:
  - (a) as an auditor, Q3 verifiable at repository scope equals the period report's figures, with matching evidence;
  - (b) Q3 signed after `attesta:report` for that exact scope names its statement digest; another scope gives `report_not_built`;
  - (c) S7 verifiable over a sealed period matches the security report's figures; a period crossing the unsealed tail is `partial`;
  - (d) with the guard trigger disabled by the database owner, a deleted finding row makes S1 `evidence_broken`;
  - (e) S15 counts the sealed `security_findings.read` events;
  - (f) Company B gets 404 for A's repository and sees none of A's evidence;
  - (g) `kind=live` as an auditor is 403.

  Run it once in your sandbox.
- **Regression:** IT-T19a-01, IT-T19b-01, IT-T19c-01, IT-T15i4 and IT-T15op-01/02 must still pass. Name their commands in the handoff.
- **Review:** re-read your full diff as a reviewer before the handoff.
- Number every founder step list and every bash-block section (`# 1.`, `# 2.`).

## 4. Close-out
- Handoff under 70 lines. It must have:
  - the table of answerers registered (question, kind, figures);
  - the questions left unbuilt, with why;
  - the contract addition;
  - the auditing decision;
  - Integration test impact;
  - Effort.
- Clean tree. Do not push.
- **Final reply** in the AGENTS.md §12.4 shape, numbered. The bash block contains, in order:
  - tests, IT-T16h-01 and the regressions;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16h-auditor-qa --title "[Task16h] Auditor verifiable and signed answers" --body-file docs/handoffs/Task16h-auditor-qa_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; the preflight; and the merge only after the preflight says ok.

  Then the review request for the Task16 lead in a `text` block.

## Lessons so far
- **Task16c/16e:** `occurred_at` and `received_at` hold microseconds, so never round-trip them through a JS `Date`. Seal checks are the source of truth for "nothing was changed".
- **Task15op-b:** a bucket called `unknown` or `unavailable` is a fixed bucket, not a value. `denied_by_request` is a count of requests, never "blocked".
- **Task19:** the server validates every envelope, so a wrong shape is a 503 `QA_ANSWER_INVALID`, not a silent bug. Run the validator in your unit tests.
- **Reviews:** the lead returns only must-fix items. Follow this design to the letter, and ask before deviating.
