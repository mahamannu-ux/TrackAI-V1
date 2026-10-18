# Task19c-qa-live-security Handoff — Live answers for the security questions (T19.4)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task19c-qa-live-security` (base: `main` at `c30c6ab`).

Task19c registers **live** answerers for the security questions that have data today — S5, S6, S7, S8, S9, S10, S11, S12, S15, S17, S18 — and for **Q11** (moved from Task19b), reading **both generations** of `security_findings` (Task6.a and Task20d's v2) through one tenant-bound read module. It changes no contract, table, ingest or UI. S1, S2, S3, S4, S13, S14, S16 stay `answer_not_built`. Every answer is metadata-only, carries `monitor_only_observed`, and never says "blocked" or "prevented".

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Twelve live answerers read both generations, metadata only | ✅ |
| Acceptance | `not_enrolled` (v2 null repository) is never dropped | ✅ as bucket `unknown` (see Deviations) |
| Acceptance | Unknown platform and unknown model are honest, never 0 | ✅ S9 partial `not_monitored`; S8 bucket `unknown` |
| Acceptance | No preview column is read | ✅ pinned by test + IT |
| Acceptance | Every envelope passes the frozen schema through the service | ✅ 20-case sweep + all unit tests |
| Acceptance | Company A/B isolation | ✅ route harness + IT-T19c-01g |
| Scope | Q11 registered; Q11 removed from Task19b's list (already unbuilt there) | ✅ |
| Quality | 17 new unit tests; `typecheck` and `lint` clean; full `npm test` 1171/1172 (see Limitations) | ✅ |
| Integration | IT-T19c-01 added | 🟡 agent-passed 2026-10-18 · ⬜ founder run (non-blocking) |
| Review | independent diff re-read | ✅ (one prompt-contract conflict resolved, see Deviations) |

## Implemented interfaces
```ts
// features/qa/security-read.ts
export function loadSecurityContext(tenantId, fromMs, toMs): Promise<SecurityContext> // withTenant, metadata only
export function buildSecurityContext(input): SecurityContext   // tests build synthetic contexts
export function toFindingRow(row): SecurityFindingRow          // fixed allowlist; drops title/tags/previews
export const SECURITY_FINDING_METADATA_COLUMNS: readonly (keyof SecurityFindingRow)[]

// features/qa/security-answerers.ts
export function computeS5..computeS18, computeQ11(input): QaEnvelope  // pure; tests drive these
export function securityAnswer(compute, load?) / comparisonAnswer(compute, load?) / linkedAnswer(compute, load?, loadCode?)
export function registerSecurityAnswerers(): void   // runs on import; qa.routes.ts imports './security-answerers'
export type SecurityLoader = (tenantId, fromMs, toMs) => Promise<SecurityContext>

// apps/api/package.json
"verify:task19c-qa-live": "tsx src/features/qa/task19c-qa-live-verify.ts"   // scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api
```

## Ported from
None, because the answerers are the same shape as Task19b's in this repo (`features/qa/answers/*`), not a SushiCorp/agent-kit component.

## Founder-approved decisions
1. **S12 `blocked`** is `unavailable` with reason `answer_not_built`; the prompt's `monitor_only_observed` is a wording code, not a reason code, and the wording already carries it (registry).
2. **Security answers carry no drill-down** (`drilldown: []`), and the drill-down route keeps answering 501 for S questions: a repository/PR/commit listing is not a drill-down of a security answer.
3. **S9 platform** comes from `fleet_machine_states.platform` (latest per machine) for both generations; a machine with none buckets as `unavailable`; `TASK19.md §3.1` still says "macOS only".
4. **Registration** is a single `import './security-answerers';` in `qa.routes.ts` (self-registers, as `./answers/register-code`).

## Deviations from spec
- **`not_enrolled` bucket** (prompt §2.1 item 4): the frozen validator (`envelope.ts` `bucketKeyOk`) allows a `repository` bucket key to be a UUID or `unknown` only, so a v2 null-repository row buckets as **`unknown`**, not `not_enrolled`. Contract not edited; flagged as an additive reason-code/bucket follow-up.
- **S12 `blocked` reason** (prompt §2.2): see decision 1.
- Shared file touched: `apps/api/package.json` (test list + `verify:task19c-qa-live`), pre-approved.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | run `scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api` | non-blocking; ✅′s IT row |
| 🟡 | `npm test` has one pre-existing red: `features/security/signing.test.ts:108` (`Missing expected rejection (SecurityDocumentTooLarge)`) | inherited Task20f baseline; reproduces on a clean `main`, unrelated to Task19c |
| 🟡 | S6/Q11 use the text session join (G10): a finding's `session_id` matched to `ai_sessions.external_session_id` | wording `session_link_partial`; Task13's key closes it |
| 🟡 | repository scope cuts findings-based figures; enforcement decisions carry no repository, so a repository-scoped S12 counts denies on machines that raised findings there, and `machines_reporting_status` stays tenant-wide | honest bound, not a contract gap |
| 🟡 | S8/S9/S17/Q11 default answers are counts; breakdowns only when requested | matches Task19b conventions |
| ⬜ | S1, S2, S3, S4, S13, S14, S16 unbuilt | keep `answer_not_built`; the lead updates `TASK19.md` |

## Test coverage
- `security-answerers.test.ts` (17 tests, no database): both generations; `not_enrolled` → `unknown`; unknown platform (S9 partial `not_monitored`) and unknown model (S8 `unknown`); the preview table is never named and `toFindingRow` drops `title`/`tags`; S7 previous; S5/S6/Q11 session link; repository scope cuts findings (and S12 denies to its machines); a 20-case service sweep (every answer passes `checkEnvelope`); Company A/B through the real router. Mocked: the security loader (`SecurityLoader`) and the scope store; nothing else.
- Live: `task19c-qa-live-verify.ts` proven once on a throwaway PostgreSQL (all eight checkpoints).

## Integration test impact
> **FOUNDER:** non-blocking for Task19d/19e; needed to flip IT-T19c-01 to ✅. Prerequisites: Docker or local progressive PostgreSQL (`scripts/it-db.sh`). Expected: 1 passed (8 checkpoints), about 1 minute.
> ```bash
> scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T19c-01 | S7/S8/S9/S12/Q11 (+S5/S6) schema-valid on real PostgreSQL through the real JWT/tenant middleware and `createApp()` mount; `not_enrolled` → `unknown`; S9 `not_monitored`; S12 one `deny` and two policy versions; Company A/B isolation; auditor `kind=live` 403 | Blocking: Task19c merge | 🟡 agent-passed 2026-10-18 · ⬜ founder run |

Task19d and Task19e can proceed without the founder run; the Task19c merge waits on the cross-agent review, not on it.

## Integration notes
- The read is one `withTenant()` pass over `security_findings` metadata plus enforcement, status snapshots, machine platforms and sessions; the preview table is never queried.
- `SecurityFindingRow.model` is `null` for every Task6.a row (G10); `agent` is Task6.a `agent_family` or v2 `source_agent`; `rulePackVersion` is `0.1.0-test`-style for Task6.a and `bundle:<16 hex>` for v2.
- A future `not_enrolled` repository bucket or a dedicated `blocked` reason needs a contract change (additive) — do not widen the current code without the lead.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.10× | about 0.12× | one session | ~1 h | not shown |

Under 1.25×; the two forced deviations (bucket, reason) were found by reading the frozen validator before writing the answerers.
