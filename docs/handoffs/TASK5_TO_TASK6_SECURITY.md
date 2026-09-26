# Task5 → Task6 Security Handoff

**Status:** Task5 engineering foundation is merged. Task6 Security may begin in
a separate Codex task, branch and worktree after the documentation split that
contains this handoff is committed and merged.

This file—not either Codex conversation—is the concise cross-task starting
point. [`TASK6_SECURITY.md`](../../TASK6_SECURITY.md) is the authoritative
tracker after work begins.

## Starting checkpoints

| Repository | Merged Task5 checkpoint | State |
|---|---|---|
| TrackAI | PR #4 merge `fe1dcde754979cde2a59b75152a95186af1425af`; Task5 documentation closure `727e529` | Evidence Explorer, privacy floor and verification foundation complete for the stated Task5 scope |
| GitAI | PR #1 merge `0097645d3179d4baa3b6bff043149b08dbf79155` | OpenCode collector and managed evidence delivery merged |

Create new worktrees from the current remote `main` branches, not from the old
Task4/Task5 worktrees. Before implementation, verify that TrackAI `main`
contains the Task5 merge and the later documentation commit containing
`TASK6_SECURITY.md`, `TASK6_POLICY.md` and this handoff. Record the resolved
TrackAI and GitAI starting SHAs in the tracker before changing code.

Suggested branches:

- TrackAI: `feature/task6-security`
- GitAI: `feature/task6-security`

Never copy uncommitted local environments, customer notes, runtime databases,
credentials or diagnostic logs into the new worktrees.

## Required reading order

1. [`TASK6_SECURITY.md`](../../TASK6_SECURITY.md) — active scope, waves and gates.
2. [`TASK5.md`](../../TASK5.md) — implemented evidence/privacy authority.
3. [`TASK4.md`](../../TASK4.md) — delivery, authorization, credential and audit authority.
4. [`AGENT_COVERAGE.md`](../../AGENT_COVERAGE.md) — route IDs, hosts, capture channels and OS claims.
5. [`TASK6_POLICY.md`](../../TASK6_POLICY.md) — deferred boundary; do not implement it accidentally.
6. [`ROUGH_ROADMAP.md`](../../ROUGH_ROADMAP.md) — portfolio ownership.
7. GitAI's root `AGENTS.md` — mandatory architecture, TDD, test and PR rules.

## Task6 Security outcome

Deliver local, privacy-safe coding-agent threat monitoring using a curated,
version-pinned subset of Numbat-style rules:

- tenant-admin modes are only `off` and `monitor`;
- rules ship with the normal GitAI client release;
- no dynamic signed bundle/control plane is built;
- no action is blocked in the initial release;
- only bounded safe finding metadata may leave the endpoint;
- raw commands, prompts, responses, reasoning, file content, tool payloads and
  detected secrets never appear in findings, logs, errors or audit details;
- server-side tenant/machine/repository authorization remains authoritative;
- unsupported or post-action-only routes are labelled honestly; and
- blocking remains the deferred S6.7 gate requiring separate approval.

## Non-negotiable inherited contracts

| Authority | Contract Task6 Security must preserve |
|---|---|
| Task2 | Lifecycle meanings remain unchanged; unavailable evidence is never invented zero; observation and correction remain separate. |
| Task4 | Managed credentials, tenant/repository/branch binding, durable queue, retry/quarantine, server admission, RLS and immutable audit remain authoritative. |
| Task5 | Tenant-wide default-off raw-evidence consent, secret scanning, encryption, restricted audited raw access, `no-store`, content-free logs and complete 30-day raw/derived deletion propagation. |
| Task13 | Agent family, model provider, host surface, capture channel and operating system remain separate dimensions; every support claim uses a route ID and real conformance evidence. |

Task5 consent is tenant-wide; repository-level consent does not exist today.
Do not reuse the raw-evidence consent switch silently as the Task6 Security
monitor switch. Design and audit the narrow Security setting explicitly.

## Work excluded from this task

| Work | Owner |
|---|---|
| Capture/upload/redaction/retention/access/export policy | Task6 Policy, deferred |
| Cedar-like authorization, inheritance, exceptions and simulation | Task6 Policy, deferred |
| Dynamic rule/policy signing, distribution and rollback | Task6 Policy, deferred |
| Customer-authored rule overrides | Task6 Policy, deferred |
| New agent/provider adapters | Task13 |
| Fleet installation and managed hook deployment | Task9 |
| Design-system overhaul | Task10 |
| Cloud/VPC/self-hosted certification | Task14 |
| T5.9a intention-model research and T5 product-owner UX acceptance | Continuing Task5 follow-up |

## Required working style

### Tracker and evidence discipline

- Use the status legend exactly: **🟢 ✅**, **🟡 ◐**, **🔴 ☐**, **⚪ —**.
- Keep separate **Implemented** and **Tested & verified** columns.
- Organize work into small numbered waves with one explicit exit gate each.
- Maintain controlled `E6-*` evidence gates and dated implementation-evidence
  rows in `TASK6_SECURITY.md`.
- A unit test may turn implementation green but leaves live verification yellow
  when a real agent, browser, tenant or machine check is required.
- Record sanitized failing gates and their cause. Add a later green row after a
  fix; do not erase or rewrite useful failure history.
- Keep the roadmap as a summary. Do not duplicate the detailed tracker there.
- Update documentation in the same wave as the behavior it describes.

### Communication with the product owner

- Keep messages concise and use plain, beginner-friendly language.
- Lead with the result and explain why the next user action is needed.
- Give one bounded terminal sequence at a time, including the exact directory,
  required environment variables and expected safe output.
- Never ask the user to paste credentials, PEM material, raw prompts or database
  content into chat. Commands must print safe status only.
- Pause after a real-machine, browser, secret, tenant or external-account gate
  and wait for the user's result before marking it green.
- Do not ask questions that repository inspection can answer.
- Call out the difference between “detected,” “requested,” “observed” and
  “blocked”; never describe monitor-only evidence as prevention.

### Engineering process

- Use strict test-first development. Add the failing contract/security test,
  implement the smallest behavior, then run focused and broader regressions.
- Preserve dirty-worktree changes and unrelated untracked files.
- Keep TrackAI and GitAI changes in separate reviewable commits/PRs with named
  cross-repository checkpoints.
- Prefer small, reversible waves over one large implementation.
- Use synthetic fixtures only. Never store real customer prompts, commands,
  credentials or secrets in tests or docs.
- For PostgreSQL changes: generate and inspect migrations, run rollback-only
  dry-run verification, create and verify a backup, apply explicitly, then run
  persistent-schema and fresh-schema gates.
- For destructive/revocation checks: dry-run first and state exact scope.
- Do not silently broaden access, capture, upload or retention during fallback.
- No implementation claim is complete until Company A/Company B isolation and
  Task2/Task4/Task5 regressions pass.

### GitAI-specific constraints

- Obey GitAI's root `AGENTS.md` in full.
- Trace2 remains the Git integration source; do not wrap Git.
- Add no work to the latency-sensitive ingestion path unless the architecture
  explicitly requires it and measured performance evidence passes.
- Never add per-commit/file/object/ref Git spawns or other unbounded Git work.
- Reuse existing helpers and write high-quality `TestRepo`-based tests.
- Use `task test`, `task build`, `task lint` and `task fmt` as documented.
- Use `task dev` for an installed local development build; do not invent an
  alternate daemon installation workflow.
- Isolate Task6 runtime databases/configuration from the normal user daemon and
  always prove which database a live daemon has open before testing.

## First implementation sequence

1. **Baseline and discovery only.** Verify starting SHAs, clean builds/tests,
   current Task4/5 regressions and the exact initial Task13 route(s).
2. **S6.1 contract.** Define normalized event, capability, certainty,
   availability and safe-finding schemas before database or evaluator work.
3. **S6.2 inventory.** Pin one upstream Numbat commit; evaluate every candidate
   rule's provenance, inputs, privacy, host fidelity and false-positive risk.
4. Ask the product owner to approve the first small accepted rule subset.
5. Implement **S6.3** locally in monitor-only mode with bounded resource use.
6. Add **S6.4** delivery only after a captured-output test proves the safe
   projection contains no raw or secret-bearing fields.
7. Add **S6.5** server/API/UI and role tests, then perform the controlled
   browser walkthrough.
8. Complete **S6.6** only for real routes/platforms that were exercised; mark
   every other combination unavailable or unsupported.

Do not start by copying the entire Numbat catalog or designing a dynamic policy
bundle. The accepted rule count is an evidence-backed discovery output.

## Baseline commands

Resolve exact commands from the current package/task manifests before running
them. At minimum, the new agent should establish:

### TrackAI

```bash
npm run build --workspace=apps/api
npm run build --workspace=apps/web
npm exec --workspace=apps/api -- drizzle-kit check
```

Run the repository's full API/security/telemetry suite and Task5 verification
gates identified by the current manifests; do not rely on stale test counts in
this handoff.

### GitAI

```bash
task test
task build
task lint
```

Run `task fmt` only as required by GitAI's workflow and inspect the resulting
diff before committing. Never assume a historical test count is current.

## Opening instruction for the next Codex task

Use this prompt:

> Begin Task6 Security from the current remote `main` branches using separate
> TrackAI and GitAI worktrees. Read `docs/handoffs/TASK5_TO_TASK6_SECURITY.md`
> and the canonical `TASK6_SECURITY.md` tracker first. Preserve the Task2,
> Task4, Task5 and Task13 contracts. Start with Wave 1 baseline and Wave 2
> S6.1/S6.2 discovery; do not implement the deferred Task6 Policy engine or
> blocking. Keep the tracker, waves and E6 gates current using the documented
> red/yellow/green status rules, and give me concise, plain-language updates and
> one bounded manual step at a time.
