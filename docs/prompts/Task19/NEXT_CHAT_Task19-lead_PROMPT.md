# Handoff prompt: Task19-lead (customer and auditor Q&A delivery), Claude as lead with Muse

> **Founder setup (Claude: skip to "You are…"):**
> 1. Answer section 1 of `docs/plan/TASK19.md`, merge the PR that adds this prompt, then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI project, link it to this Mac, and paste everything below the line. It can share a lead chat with Task16 if Claude usage is tight.
> 3. Reviews: Muse or Codex review Claude's branches; the lead reviews Muse's. Push only after "ready to push".

---

You are **Claude**, **leading Task19 (customer and auditor Q&A delivery)** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Your question catalogue is **`docs/plan/CUSTOMER_AUDITOR_QA.md`**: 38 ranked questions (Q1–Q20 code, S1–S18 security and policy), gaps G1–G13, three kinds of answer (live, verifiable, signed), and Codex's Task6.a status. Your tracker, the delivery matrix (the to-do list) and the Task6 strategy are in **`docs/plan/TASK19.md`**.

Your goal is that every row reaches an answerable state. You build:
- the shared Q&A contract (T19.2);
- the admin live answers and the **Questions** screen (T19.3–T19.5, ex-Task10 T10.9).

You do not build anything else yourself:
- **Capture gaps:** you dispatch each to its owning Task (T19.6).
- **Auditor answers:** you review Task16 A16.13 and Task15o/15p (T19.8).
- **Task6:** you set what Task6.a and Task6.b build, skip or defer (T19.7).

## 0. How you work
Follow **`docs/agents/TASK_LEAD_PROCEDURE.md`** from Phase 2: `TASK19.md` replaces the primer, and its §1 holds the founder's decisions. Read first:
- `AGENTS.md` in full, especially §1 rules 6–9, §4, §5a, §9 items 11, 22–23, §10 (AP-1), §12.4 and §12.8;
- `CLAUDE.md`.

## 1. Sessions and hand-offs
- **Your own sessions:** one per chat, in the order of `TASK19.md` §2. The lead writes each prompt from `docs/templates/NEXT_CHAT_PROMPT_TEMPLATE.md`. Expected first sessions: `Task19a-qa-matrix-contract` (T19.1 + T19.2, Claude), then `Task19b-qa-live-code` (T19.3, Muse).
- **Gap sessions:** named under the owning Task (`Task2-merged-by`, `Task6-monitor-audit`, …), with the prompt written by you and reviewed by that Task's owner (Codex for Task2/4/6). Dispatch in `TASK19.md` §4 order.
- **Muse prompts:** on the founder's request, with every decision made, as **"Paste to Muse:"** blocks.
- **Review gates:**
  - A16.13a/b (Task16) and Task15o/15p (Task15): you check that each claims only what its statements prove, and uses the T19.2 answer envelope.
  - Every gap session: you check that the row it closes moves as the matrix says.
- **After each merge:** update the matrix status in `TASK19.md` §3 and the matching row in `CUSTOMER_AUDITOR_QA.md`. A row turns ✅ only when its answer is live for its audience: live for admins, verifiable or signed for auditors.

## 2. Boundaries
Never touch:
- `docs/contracts/`, except a new `docs/contracts/qa/`;
- merged migrations;
- another Task's files, except through a session that Task's owner reviews;
- raw content: Task5's reveal stays the only path.

Rules for every answer:
- **Honest states** (rule 7): `Unavailable` is never zero, and "observed" is never "blocked".
- **No per-developer views by default** (Task5's no-surveillance rule).
- **Lifecycle metric semantics stay Task2's** (rule 8).
- **Auditor answers come only from signed statements**, as `TASK19.md` D2 decides.

## 3. Estimate
About 0.4× T6 for Task19's own work; gap work is sized in its owning Task.

## 4. Lessons so far
- Facts not taken from the code cost review rounds: cite `file:line`.
- Grep both the Drizzle symbol and the raw SQL table name when inventorying (Task16a).
- Codex's Task6.a report is the authority on why rules were deferred. Change a deferral only with new evidence, agreed with Codex.
