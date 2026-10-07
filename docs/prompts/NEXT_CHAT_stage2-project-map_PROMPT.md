# Session prompt: stage2-project-map (understand TrackAI), Claude (TrackAI-Orchestrator)

> **Record of a bootstrap session.** This session ran inside the TrackAI-Orchestrator chat from the founder's setup brief (stage 2, "Understand TrackAI"), not from a separate chat. This file records that brief so the cross-agent review can check the branch against it (`docs/agents/CROSS_REVIEW_PROMPT.md`). Later orchestrator sessions get their prompt file before they start.

---

You are **TrackAI-Orchestrator** (Claude). Stage 1 (kit adoption) is complete on `docs/adopt-agent-kit` at `e1d7e37`, approved by Codex and not yet merged (it merged later as PR #8, on 2026-10-08); build on that commit. Run stage 2 of the setup brief: understand TrackAI before the dry runs (founder decision 2026-10-07, so the dry runs can be chosen from the map).

## Scope (approved by the founder)
1. **Vision.** Save the founder's vision as given, edited only with his OK, in `docs/founder/VISION.md`. He has only the short version (the Claude project description) plus notes in chat; record those verbatim.
2. **Read the system:** `ROUGH_ROADMAP.md`, the Task trackers, runbooks and handoffs for Task1–Task6 (including `TASK1_RUNBOOK.md` and the Task1 seed `apps/api/src/features/telemetry/task1-seed.ts`), `apps/`, the schema and migrations, the security and policy architecture (`TASK6_POLICY_SECURITY_BUNDLE_ARCHITECTURE.md`, `TASK6_POLICY.md`), the tests, and the GitAI fork. Use read-only research subagents for breadth; keep the conclusions.
3. **Project map** `docs/plan/PROJECT_MAP.md`, under about 200 lines: what each app and part does and how they connect; the data model at a glance; the boundaries a Task must not cross; the gotchas Codex already hit; for Task2–Task6, what is solid and what needs improving, with a rough size.
4. **Reuse map** `docs/plan/REUSE_MAP.md`: every catalogued SushiCorp component classified (already built / port as-is / port with changes / not needed) with the TrackAI Task it serves; extra depth on signing and attestation, the evidence chain, multi-tenancy, the auditor and reports; TrackAI's Task6 policy design compared with SushiCorp's P1 bundles; what Task15 Attesta starts from.
5. **AGENTS.md project sections** updated from the map, including every SushiCorp gotcha that applies to a ported component (gap-free `seq`, an anchor never changes `record_hash`, revocation UNKNOWN is not CLEAN).
6. Up to five founder questions where code and vision disagree or are unclear, each with a recommendation.
7. Added by the founder on 2026-10-08: a bug and gap backlog (`docs/plan/BUG_BACKLOG.md`; each item fixed later by its owning Task, no sessions now), a GitAI future to-do tracker (`docs/plan/GITAI_FUTURE_TODO.md`; no routine upstream sync), his positioning notes in the vision, and one dry-run prompt in which Codex leads and hands a piece to Muse (no Claude dry run; cross-agent reviews skipped for the dry runs).

## Rules
- Documents only, on branch `docs/stage2-project-map`, moved by bundle; read-only on the founder's machine except bundles; never edit `~/dev/sushicorp` or `~/dev/agent-kit`.
- Handoff `docs/handoffs/stage2-project-map_HANDOFF.md`; review by Codex, who built Task2–Task6.
- Estimate about 0.05× T6.
