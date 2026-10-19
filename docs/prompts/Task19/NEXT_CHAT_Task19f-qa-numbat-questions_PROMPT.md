# Handoff prompt: Task19f-qa-numbat-questions (S19–S26 in the Q&A registry; live answers for S26, S23, S21), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the `docs/Task19f-qa-numbat-questions` PR (this prompt), after `scripts/pr-preflight.sh docs/Task19f-qa-numbat-questions` says ok. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task19f-qa-numbat-questions && cd ~/AIProjects/TrackAI-wt/Task19f-qa-numbat-questions && npm ci && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 3. When it finishes, paste its review request to the **Task19 lead (Claude)**. Push only after "ready to push".

---

You are **Muse**, building **Task19f-qa-numbat-questions** (Task19, requested by the Task20 lead as T20.18) for **TrackAI**, an AI code provenance and coding-agent security product.

TrackAI now runs **Numbat** on developer machines (Task20). That makes eight new security questions possible, **S19–S26**. They are defined in `docs/plan/NUMBAT_ADOPTION_REVIEW.md` §6, and the founder has ranked them. This session does two things:
- adds S19–S26 to the **Q&A contract**: the registry, the generated question list, a new reason code and four new gaps. These are additive changes to a frozen contract, made the way Task16h added its reason codes;
- registers **live answers for the three questions with data today: S26, S23 and S21**.

The other five are registered and answer an honest `unavailable` until their data or builder exists.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task19f-qa-numbat-questions`, branch `task/Task19f-qa-numbat-questions`.
- **Handoff:** `docs/handoffs/Task19f-qa-numbat-questions_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full. In particular:
   - §1 rules 1, 6, 7 and 9;
   - §4;
   - §7 and §8;
   - §9 items 3 and 22–23;
   - §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`. Set `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` in this worktree. **Check:** `apps/api/src/features/qa/security-answerers.ts` and the `security_permission_events` table in `apps/api/src/core/db/schema.ts` exist; otherwise stop.
3. `npm test` once as a baseline.
4. **Estimate** in one line against T6. The plan says **about 0.10×**.

## 1. Read before writing code
- `docs/plan/NUMBAT_ADOPTION_REVIEW.md` §6 (the S19–S26 definitions) and §13 (founder decisions).
- `docs/contracts/qa/README.md` and `api.md`, `answer-v1.schema.json`, `questions.md`: the contract you extend, **additively only**.
- **Code** (paths under `apps/api/src/`):
  - `features/qa/types.ts`: `QA_REASON_CODES`, `QA_GAP_IDS`, `QA_DIMENSIONS`, `QA_WORDING_CODES`.
  - `features/qa/registry.ts`: `QA_REGISTRY_VERSION` (1), `QA_QUESTIONS`, the `security()` helper, `QA_GAPS`.
  - `features/qa/answer-schema.ts`: the schema embedded for the production image; it must equal `answer-v1.schema.json`, and a test checks that.
  - `features/qa/qa-contract.test.ts`:
    - `REGISTRY_DIGESTS` (the per-version digest pin);
    - the catalogue parser (`:41-51`), which reads security ranks from the id;
    - the schema-equality test.
  - `features/qa/security-answerers.ts` (Task19c): `SecurityInput`, `securityAnswer`, `registerSecurityAnswerers`, and the pattern of `computeS7` and `computeS17`. `features/qa/security-read.ts`: the loader. `features/qa/security-answerers.test.ts`: the test pattern.
  - `core/db/schema.ts`:
    - `security_permission_events` (`:768`): `outcome` ∈ `requested/approved/denied`, `join` ∈ `exact/same_session_window/unavailable`, `session_id`, `source_agent`, `occurred_at`, `machine_id`;
    - `security_indicators` (`:699`): `type` ∈ `domain/ipv4/ipv6/url/email/md5/sha1/sha256`, `value`, `count`, `first_seen`, `last_seen`, `source_agent`;
    - `security_findings` (`:482`): `rule_id`, `session_id`, `source_agent`, `occurred_at`, `machine_id`, `record_generation`;
    - `security_data_settings_versions` (`:2785`): `version`, `urls`, `created_at`.

## 2. Scope (every decision made by the lead)

### 2.1 Contract additions (additive; nothing renamed or removed)
1. **Reason code `data_setting_off`.** Use it when a figure needs data the tenant's security data settings keep on the machine (S23 with `urls` off). Add it:
   - to `QA_REASON_CODES`;
   - to the reason enum in `answer-v1.schema.json` **and** `answer-schema.ts`, identically;
   - with one line in `README.md` rule 4.
2. **Gaps G14–G17** in `QA_GAP_IDS`, the schema's gap enum (both copies) and `QA_GAPS`, all `open: true`:

   | Id | Title | Owner | Questions |
   |---|---|---|---|
   | G14 | Agent inventory and day-one scan uploads from the endpoint | Task20 (Task20h-b) | S19, S20 |
   | G15 | MCP server configuration and per-call MCP identity on findings | Task20 (later) | S22 |
   | G16 | Deferred rule wave 2 (the 7 normal-development rules, including `exec.agent_runtime_bypass_flags`) | Task20 (later wave) | S21 |
   | G17 | Opt-in blocking pilot (enforcement decisions) | Task20 (Task20k) | S24 |

3. **Eight registry entries**, `family: 'security'` through the `security()` helper, so `monitor_only_observed` is automatic. Ranks follow the founder's order: S19, S20, S26, S23, S21, S22, S24, S25.

   | Id | Rank | Auditor | Title (≤ 200 chars) | Kinds (builder) | Gaps | Scopes | Dimensions | Extra wording | Phase |
   |---|---|---|---|---|---|---|---|---|---|
   | S19 | 19 | yes | Which AI coding agents are installed on our machines, and which are not on the approved list? | live (T19.4) | G14 | tenant | `agent_family`, `operating_system`, `machine` | — | 1 |
   | S20 | 20 | yes | Were we already exposed before TrackAI arrived? What did the day-one scan of existing agent sessions find? | live (T19.4) | G14 | tenant | `rule_category`, `severity` | `requested_not_confirmed` | 1 |
   | S26 | 21 | yes | How often do agents ask permission, how often do developers approve or deny, and did sessions with findings get approvals? | live (T19.4) | — | tenant | `agent_family` | `requested_not_confirmed` | 1 |
   | S23 | 22 | partly | Which external domains, URLs and addresses did agents reach in a period? | live (T19.4) | — | tenant | `agent_family` | `metadata_only` | 1 |
   | S21 | 23 | yes | Which agents ran in reduced-approval or bypass modes, and how often? | live (T19.4) | G16 | tenant | `agent_family` | — | 1 |
   | S22 | 24 | yes | Which MCP servers are configured and used by agents, and did any send data out? | live (T19.4) | G15 | tenant | `agent_family` | — | 1 |
   | S24 | 25 | yes | What did we block, under which settings version, and what did the developer do next? | live (T19.4) | G17 | tenant | `rule`, `agent_family` | — | 1 |
   | S25 | 26 | yes | Give me a signed incident case for one session. | signed (null) | — | tenant | — | — | **2** |

   S19's title says "not on the approved list". Until an approved list exists, the answer counts installed agents only, and the list comparison is a figure that answers `unavailable` (§2.2). Inventory has **no agent versions**: Numbat does not report them, so no figure claims them.
4. **Bump `QA_REGISTRY_VERSION` to 2.** Regenerate `questions.md` (`npm run qa:registry -w apps/api`) and record version 2's digest in `REGISTRY_DIGESTS`.
5. **`api.md`:** the `id` row becomes `Q1`…`Q20`, `S1`…`S26`. No other change.
6. **Catalogue, `docs/plan/CUSTOMER_AUDITOR_QA.md`:**
   - add a table **"Security questions from Numbat (S19–S26, founder-ranked 2026-10-19)"** after the S1–S18 table, with columns `Rank | # | Question | Auditor | Data today | Lives in | Answered by | Notes / gap`;
   - one row per question, in rank order. Data today: S26 ✅, S23 🟡 (only with `urls` on), S21 🟡, S19 ⬜, S20 ⬜, S22 ⬜, S24 ⬜, S25 n/a;
   - add G14–G17 to "Gaps found";
   - update the "How to read this" bullet: S1–S18 are numbered in rank order, and S19–S26 carry an explicit Rank column.

   In `qa-contract.test.ts`, extend the parser so rows of the new table take their rank from its Rank column. The test must still compare every registry entry with the catalogue.
7. **Fixtures:** add `docs/contracts/qa/fixtures/valid-live-unavailable-data-setting-off.json` (S23, `urls` off), validated by the existing fixture test.

### 2.2 Live answers (registered for kind `live` in `registerSecurityAnswerers`)
These follow the Task19c pattern: a pure `computeSn(input)` plus the loader. Extend `security-read.ts` so the context also carries, for the tenant and period:
- permission events;
- indicators (by `last_seen` in the period);
- `tamper.guardrails_off` findings;
- the data-settings versions in force during the period.

All reads go through `withTenant`. All values are integers; null is never 0; the wording is exactly what the registry lists.

| Q | Figures (key → source) | Breakdown | Availability rules |
|---|---|---|---|
| **S26** | `permission_requested`, `permission_approved`, `permission_denied` → counts by `outcome`; `approval_rate` → ratio(approved, approved + denied); `sessions_with_finding_and_approval` → distinct `(machine_id, session_id)` with at least one v2 finding **and** at least one `approved` event in the period | `agent_family` (key = `source_agent`) on the three counts | The first four are `recorded`, and stay `recorded` when they are 0, because the table exists and the counts are real. `approval_rate` is `unavailable` when its denominator is 0. `sessions_with_finding_and_approval` is always `partial` with reason `partial_linkage`: it is a same-session association, not proof that the approval was for the finding's action |
| **S23** | `distinct_domains` (`type='domain'`), `distinct_urls` (`url`), `distinct_ip_addresses` (`ipv4` + `ipv6`), `indicator_observations` (sum of `count`) | `agent_family` on `indicator_observations` | If **no** data-settings version in force during the period had `urls = true`: every figure is `unavailable`, `data_setting_off`, value `null` (**never 0**). If it was on for part of the period: `partial` with `data_setting_off`. **No domain, URL or address ever appears in the envelope**: not in keys, labels or drill-down. The list lives in the Security console (Task20i) |
| **S21** | `guardrails_off_findings` → v2 findings with `rule_id = 'tamper.guardrails_off'`; `guardrails_off_sessions` → their distinct `(machine_id, session_id)`; `bypass_flag_launches` → `unavailable`, `not_captured_yet` G16 | `agent_family` on `guardrails_off_findings` | Top level `partial` (G16) |

Not built here. They keep answering `answer_not_built` plus their open gaps, which the service adds automatically:
- **S19, S20** (G14): answered after Task20h-b merges;
- **S22** (G15);
- **S24** (G17): after Task20k;
- **S25**: phase 2, answers `phase_2`, deferred with Task15's case-bundle work.

**Wording everywhere**, including test names and the handoff: "observed", "requested", "denied by request"; never "prevented" or "blocked" (rule 7).

### 2.3 Port from
None. This extends Task19a's contract and Task19c's answer pattern; no SushiCorp module applies.

### 2.4 Pre-approved files
- `docs/contracts/qa/`: `README.md` (one line), `api.md` (the `id` row), `answer-v1.schema.json` (two enums), `questions.md` (regenerated), `fixtures/valid-live-unavailable-data-setting-off.json`.
- `apps/api/src/features/qa/`:
  - `types.ts`, `answer-schema.ts`, `registry.ts`;
  - `security-read.ts`, `security-answerers.ts` (the S26, S23 and S21 functions and their registration);
  - `qa-contract.test.ts`, `security-answerers.test.ts`;
  - `task19f-qa-live-verify.ts` (new).
- `apps/api/package.json`: `verify:task19f-qa-live` in alphabetical position.
- `docs/plan/CUSTOMER_AUDITOR_QA.md` (§2.1 item 6 only).
- `docs/plan/TASK19.md`: add the eight S19–S26 rows to the §3 matrix, with status (S26 ⬜ → live after this session), and your own §6.1 row.
- `docs/plan/STATUS_BOARD.md`: registry row IT-T19f-01 and your remaining-plan row only.
- The handoff.

### 2.5 Never touch
- Any existing entry, code or enum value in the contract: additions only.
- `core/db/schema.ts` and migrations.
- `features/security-findings/` (Task20's ingest).
- `apps/web/` (the Questions screen lists the registry, so the new questions appear without UI work).

## 3. Working rules
- **Commits** prefixed `Task19f-qa-numbat-questions: …`:
  1. contract additions (types, both schema copies, README, api.md, fixture);
  2. registry, version 2, regenerated `questions.md`, catalogue table and parser;
  3. the loader;
  4. S26, S23 and S21 with tests;
  5. the live verify;
  6. the handoff.

  `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (no database):
  - the registry matches the catalogue, including the new Rank column;
  - the version-2 digest is pinned;
  - the schema copies are equal;
  - the new fixture is valid;
  - S26 counts and `approval_rate` unavailable at denominator 0;
  - S26 `sessions_with_finding_and_approval` is `partial_linkage`;
  - S23 with `urls` off for the whole period → every figure `null` and `data_setting_off`, never 0;
  - S23 with `urls` on for part of the period → `partial`;
  - S23 envelopes contain no indicator value: scan the JSON for every seeded value;
  - S21 is partial with G16;
  - S19, S20, S22 and S24 answer `answer_not_built` with their gaps; S25 answers `phase_2`;
  - every envelope passes `answerQuestion` with the real validator.
- **Integration, IT-T19f-01** (`scripts/it-db.sh npm run verify:task19f-qa-live -w apps/api`), through `createApp()` with the real JWT and tenant middleware on a throwaway database. Seed Company A with:
  - permission events (2 requested, 1 approved, 1 denied);
  - one v2 finding in the approved event's session;
  - indicators with `urls` on;
  - one `tamper.guardrails_off` finding.

  Seed Company B with `urls` off. Then:
  - (a) S26, S23 and S21 for A equal the seeded constants;
  - (b) S23 for B is `unavailable` / `data_setting_off`, with no zeros;
  - (c) A sees none of B's rows;
  - (d) an auditor asking for `kind=live` gets 403;
  - (e) `GET /api/qa/questions` lists 46 questions.

  Run it once in your sandbox; it is blocking for the merge.
- **Review:** re-read the full diff as a reviewer before the handoff (AGENTS.md §12.3).

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 80 lines**. It names:
  - the contract additions;
  - registry version 2 and its digest;
  - the three answers and their figure keys;
  - what S19, S20, S22, S24 and S25 wait for;
  - **Effort**.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape, with numbered founder steps. One bash block containing:
  1. `npm ci`, `npm test` and IT-T19f-01;
  2. under `# after the cross-agent review`:
     - `git push`;
     - `gh pr create --base main --head task/Task19f-qa-numbat-questions --title "[Task19f] S19–S26 in the Q&A registry" --body-file docs/handoffs/Task19f-qa-numbat-questions_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`;
     - `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task19f-qa-numbat-questions`;
     - the merge, only after the preflight says ok.

  Then the review request for the Task19 lead in a `text` block.

## Lessons so far
- **Task19b (Muse):** it ran at about 0.38× against 0.1×. The causes were a schema edge, Docker being down, and a type error hidden by piping `tsc`. Run `npm run typecheck` unpiped, and validate every envelope through `answerQuestion` from the first commit.
- **Task19c (Muse):** follow its `securityAnswer` pattern exactly; it passed review cleanly.
- **Task16h:** contract enum additions must land in both `answer-v1.schema.json` and `answer-schema.ts`; the equality test catches a miss.
