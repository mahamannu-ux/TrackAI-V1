# Handoff prompt: Task15-lead (Attesta), Claude as lead with Muse

> **Founder setup (Claude: skip to "You are…"):**
> 1. Answer section 1 of `docs/plan/TASK15.md` (business review) and the two dependency questions in its section 7; the orchestrator records them. Merge the PR that adds this prompt; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Muse can start now** on `Task15a-attesta-primitives` and `Task15b-attesta-signer` (their prompts are ready); they do not depend on the business answers.
> 3. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line. It runs one session at a time from `docs/plan/TASK15.md` §5, starting with `Task15c-attesta-contract`.
> 4. Reviews: Muse reviews Claude's branches (security-critical ones also by Codex when available); the lead Claude chat reviews Muse's. Push only after "ready to push".

---

You are **Claude**, **leading Task15 Attesta** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Attesta turns Task2's attribution records into signed, tamper-evident, independently verifiable evidence, and owns the shared trust layer (signer, key hierarchy, rotation, revocation) that Task6, Task9 and Task14 reuse. The plan, decisions, subtasks and the sub-task graph are in **`docs/plan/TASK15.md`**: it is your spec.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only for you). Claude moves commits with bundles in `~/AIProjects/_bundles` (`CLAUDE.md`); never a worktree from the linked shell.
- **Reuse source:** `~/dev/sushicorp` @ `0bd67a5` (read-only); catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` entries EV-1, EV-2, SG-1, TR-1, RP-1; `docs/plan/REUSE_MAP.md` §3 lists the files, vectors and handoffs.

## 0. How you work
Follow **`docs/agents/TASK_LEAD_PROCEDURE.md`** from Phase 3 (the primer is replaced by `docs/plan/TASK15.md`, which the founder approved). Read `AGENTS.md` in full first, especially §1, §5a, §9 items 16–21, §12.4, §12.8, and `CLAUDE.md`.

## 1. Sessions and hand-offs
- Run the Claude sessions in `TASK15.md` §5 order, **one session per chat** (cost grows with chat length): this lead chat writes each Claude session's prompt `docs/prompts/NEXT_CHAT_<name>_PROMPT.md` from `docs/templates/NEXT_CHAT_PROMPT_TEMPLATE.md`, and the founder opens a fresh chat for it. Keep this lead chat for planning, prompts and reviews.
- **Muse sessions:** when the founder asks ("prompt for <name>"), write the prompt with every decision made (files, functions, types, test cases with expected values, pre-approved files, never-touch list, gates, estimate, Port from, founder setup with `make worktree`), and give it as a **"Paste to Muse:"** block.
- **Codex session `Task2-attesta-trigger`:** after `Task15c-attesta-contract` merges, write its prompt for Codex (it owns Task2); the interface is the frozen outbox contract from A15.0.
- Interfaces first (AGENTS.md §5): A15.0's contract lands as its own PR before A15.3, A15.7 and A15.8 start.

## 2. Boundaries
- **Never touch** `docs/contracts/` other than the new `docs/contracts/attesta/` you create in A15.0, merged migrations, Task2 metric semantics, GitAI (no client work in phase 1), Task5 raw-content paths.
- **Shared surfaces** (pre-approve per session prompt): `core/db/schema.ts`, new migrations, `apps/api/src/index.ts` (route mounts), `package.json` (dependencies need the founder's yes), the console page.
- No raw prompts, code or secrets in any statement, log or fixture; only Merkle roots go to public logs; no TrackAI-held customer private keys in production.

## 3. Estimate
Phase 1 about 1.5× T6 overall, Claude about 0.9× (see `TASK15.md` §3 for the cloud-credit note).

## 4. Lessons so far
- **adopt-agent-kit, stage2-project-map (Claude):** facts not taken from the code cost review rounds; cite `file:line` and port SushiCorp's tests before its code.
- **SushiCorp B5/S4 (kit LESSONS 18, 24):** think about adversarial inputs to every verification rule before review; a session touching a contract, a migration and a policy together estimates at least 1.2× or splits.
