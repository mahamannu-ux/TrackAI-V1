# Handoff prompt: Task16-lead (audit and auditor experience), Claude as lead with Muse

> **Founder setup (Claude: skip to "You are…"):**
> 1. Answer section 1 of `docs/plan/TASK16.md`; merge the PR that adds this prompt; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Muse can start now** on `Task16a-audit-inventory` (prompt ready).
> 3. **Claude:** a new chat in the TrackAI project, linked to this Mac; paste everything below the line. It can share a lead chat with Task15 if Claude usage is tight: then paste this below Task15's lead prompt.
> 4. Reviews: Muse reviews Claude's branches; the lead reviews Muse's and Codex's (`Task4-auditor-invitations`). Push only after "ready to push".

---

You are **Claude**, **leading Task16 (audit and auditor experience)** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Your spec, subtasks and sub-task graph are in **`docs/plan/TASK16.md`**. Task16 consumes Task15 Attesta's ledger and evidence-pack format (`docs/plan/TASK15.md`); it never builds a second chain or signer.

## 0. How you work
Follow **`docs/agents/TASK_LEAD_PROCEDURE.md`** from Phase 3 (`TASK16.md` replaces the primer). Read `AGENTS.md` in full first, especially §1, §4 (audit call sites span Task4, Task5 and Task6 files: shared, pre-approve per session), §5a, §9, §12.4, §12.8, and `CLAUDE.md`.

## 1. Sessions and hand-offs
- One session per chat, in `TASK16.md` §4 order; the lead writes each prompt from `docs/templates/NEXT_CHAT_PROMPT_TEMPLATE.md`.
- Muse prompts on the founder's request, every decision made, as **"Paste to Muse:"** blocks.
- `Task4-auditor-invitations` goes to Codex (Task4 owner) after `Task16b-audit-contract` merges.
- Port from SushiCorp @ `0bd67a5`: AU-1 (auditor layers, route sweep, DB role), ID-2 (invitations), UI-1 (auditor sees no write controls), RP-1 (signed export via Attesta).

## 2. Boundaries
Never touch `docs/contracts/` except a new `docs/contracts/audit/`, merged migrations, the semantics of existing events (rename only through the catalog with aliases), raw-content access (Task5's reveal stays the only path, and its audit stays mandatory). Audit events never contain raw prompts, code, secrets or credential material.

## 3. Estimate
About 0.6× T6 overall; Claude about 0.25×.

## 4. Lessons so far
Facts not taken from the code cost review rounds: cite `file:line`. Port SushiCorp's tests before its code.
