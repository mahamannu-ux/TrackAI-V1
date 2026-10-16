# Handoff prompt: Task20-lead (Numbat security subsystem), Claude as lead with Codex and Muse

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the `docs/Task19-numbat-review` PR (it holds this prompt), after `scripts/pr-preflight.sh docs/Task19-numbat-review` says ok. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, and paste everything below the line.
> 3. Checkpoint 1: it sends you the Task20 primer (subtasks, sizes, graph, questions). Mark each row keep / simplify / defer / reorder.
> 4. Reviews: Codex reviews the plan's GitAI and server parts (it owns Task6.a and GitAI); Muse when Codex is unavailable. Push only after "ready to push".

---

You are **Claude**, **leading Task20 (Numbat security subsystem)** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

TrackAI adopts **Numbat** (`perplexityai/numbat`, Apache-2.0; cloned at `~/AIProjects/numbat`) the way it adopted Git AI: Numbat runs unmodified on the developer machine, and TrackAI adds the enterprise layer.
- **The decision record is `docs/plan/NUMBAT_ADOPTION_REVIEW.md`.** Its §13 holds the founder's decisions of 2026-10-16 and its §14 the glossary of policies and signing. **Read it in full first; it replaces re-deriving Numbat.**
- **The vision** is `docs/founder/VISION.md` §4: security is a first-class subsystem, and the product is modular.

## 0. How you work
Follow `docs/agents/TASK_LEAD_PROCEDURE.md` from Phase 0. In Phase 1, write `docs/plan/primers/Task20_PRIMER.md`; in Phase 2, write the tracker `docs/plan/TASK20.md`. Read first:
- `AGENTS.md` in full (§1 rules 6–9, §4, §5a third-party sources, §9 items 7, 9, 11, 22–23, §12.8) and `CLAUDE.md`;
- the review (above);
- Numbat's `docs/` and `rules/` where a subtask depends on a detail. Cite `numbat@<sha>:path:line`;
- TrackAI's Task6.a:
  - `TASK6_SECURITY.md`, `docs/contracts/task6/`, `features/security-findings/`;
  - `core/db/schema.ts` (the `security_findings` table and its check constraints);
- GitAI's `src/security/` (activation, delivery, delivery queue; the evaluator to retire), read from the fork's `main`;
- `docs/plan/TASK9.md` (fleet, rollout, packaging), `docs/plan/TASK15.md` (Task15o/15p, trust layer A15.12), `docs/plan/TASK19.md` and `docs/plan/CUSTOMER_AUDITOR_QA.md` (S1–S18; S19–S26 proposed in the review §6).

## 1. Scope the primer must cover (founder-approved, review §10 and §13)
1. **Endpoint:**
   - Numbat pinned to one stable release, built from a TrackAI mirror fork with no product changes, synced monthly;
   - distributed and installed by Task9, with `--managed` hooks where the agent supports it;
   - first agents: Claude Code, Codex, Cursor, Copilot CLI and Gemini CLI on macOS; Windows and Linux later with Task9f/9g;
   - record file admin-owned.
2. **Shipper:** the GitAI daemon tails Numbat's NDJSON with a checkpoint, applies the tenant's **security data settings** (default: the most conservative), and uploads through the existing SQLite delivery queue and machine credential. No Numbat HTTP secrets.
3. **Server:**
   - a `/worker/security` v2 contract for findings, enforcement decisions, indicators, scan summaries and **content-free permission events**;
   - a migration widening `security_findings`, with Task6.a findings kept readable;
   - Company A/B isolation.
4. **Rules:**
   - first wave: 42 rules, plus the 2 tamper rules if the founder confirms (review §13 item 5);
   - Task6.a's three Rust rules retired;
   - the 7 noisy rules in a later wave.
5. **TrackAI security rule settings:** a console with toggles (on/off, severity, monitor/block per rule and agent). The server compiles them to Numbat override files and produces **one signed rule bundle** that also carries activation scope (this replaces D6.1), delivered through Task9. No rule editor, no customer-authored rules, no Task6.b infrastructure.
6. **Blocking:** an opt-in pilot of 3–5 high-signal rules on managed hooks, after monitor mode is proven.
7. **Day-one scan:** a retroactive `numbat scan` at enrolment, opt-in, findings only (S20).
8. **Inventory and coverage:** `numbat agents` inventory (S19), and a running coverage inventory taken from Numbat's coverage matrix at each sync.
9. **Attesta:** Task15o/15p redesigned against Numbat's finding schema, plus signed case bundles (S25). Coordinate with the Task15 lead; do not build signing yourself.
10. **Q&A:** feed S1–S18 and the proposed S19–S26 into Task19 (live answers in T19.4, auditor answers in A16.13b). The Task19 lead ranks them with the founder.
11. **Modular entitlements:** per-tenant module switches (attribution, evidence, security, Attesta). Name an owner and a minimal first step; do not build them inside Task20 unless the founder agrees.
12. **Binary size and hook latency:** measure the GitAI and Numbat binaries per platform, and the per-tool-call latency of two hooks. Set budgets.

## 2. Out of scope (founder)
- Task13: Git AI riding Numbat's adapters, de-duplicating hooks, and linking findings to Git AI sessions through `session_id`. Revisit after Task20.
- `customerPolicyForDataAccess` (ex-Task6.b), customer-authored rules, a rule editor.
- OpenCode as a supported enterprise route.

## 3. Boundaries
- Never touch frozen paths: `docs/contracts/` except a new `docs/contracts/security-v2/` or similar named in the plan, and merged migrations.
- Never touch another Task's files except through a session that Task's owner reviews. Codex owns GitAI and Task6.a.
- **Raw content:** nothing beyond the security data settings leaves the machine. Task5's reveal stays the only path for raw content (rule 6).
- **Honest wording:** "observed", "requested", "denied by request", never "prevented"; `Unavailable` is never zero; a platform outside the validated set is "not monitored".
- **Licence:** update `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` for binary redistribution (licence, notices, pinned commit). Never brand TrackAI as Numbat.

## 4. Estimate
The primer decides. Expect the largest pieces to be:
- GitAI shipper and installer (Codex);
- server ingest v2 (Codex or Muse);
- the rule settings console and bundle signing (Claude design, Muse build);
- Task9 packaging (Codex).

## 5. Lessons so far
- Facts not taken from the code cost review rounds: cite `file:line`, in Numbat too.
- The founder's primers are input, not authority; review §3 lists their errors.
- Numbat is pre-1.0 and its schema changes often: pin a tested schema range and test against Numbat's own fixtures.
