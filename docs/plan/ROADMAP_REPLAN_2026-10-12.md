# Roadmap re-plan, 2026-10-12

*Decisions taken by the founder with TrackAI-Orchestrator on 2026-10-12. `ROUGH_ROADMAP.md` carries the result; this file records why.*

| # | Decision | Where recorded |
|---|---|---|
| 1 | **Task11 deferred until a customer asks** (not deleted). No Task needs a public API; conventions (AP-1) apply to new routes now; API tokens (T11.0) are the first piece when triggered. Removed from the graph. | `TASK11.md`, AGENTS.md §10, BUG_BACKLOG B17 |
| 2 | **Task8 and Task12 stay separate.** Task8 becomes "Pilot readiness: identity and onboarding" and absorbs T12.2 (verification lab → T8.9), T12.3 (sample tenant → T8.10), T12.4 (acceptance runbooks → T8.11) and Task16 A16.9 (auditor invitations → T8.12). SCIM deferred. | `TASK8.md`, `TASK16.md` |
| 3 | **Task12 becomes trust center and buyer content**, done after Task14 together with Task11, customer-driven. | `TASK12.md` |
| 4 | **Task7 becomes "SCM and CI/CD integrations", deferred to the pilot milestone.** Provider order GitLab → Azure DevOps → Bitbucket; CD deployment signals and CI results included. Stacked PRs on GitHub stay with Task2 T2.22/E16; other providers' equivalents in Task7. | `TASK7.md` |
| 5 | **Other CI/CD items to their owners:** GitHub check for attestation status (Task15 A15.14); AI agents running in CI and the cloud (Task13); build provenance (Task14 T14.7 + Attesta phase 2); bot commits labelled "automation" (Task2, B18). | `TASK7.md`, `TASK15.md`, BUG_BACKLOG |
| 6 | **Task17 GitAI upstream sync** (one-time; upstream quiet since 1.7.6 on 2026-09-09): Codex leads, Claude reviews from the product side, Muse ports; after Task9, before Task13. | `TASK17.md` |
| 7 | **Task18 real-world validation** (10 repos, 3 users and machines, Playwright, the 20-question list) after Task8, on the pilot hosting slice of Task14 (T14.1, pulled forward). | `TASK18.md` |
| 8 | **Sequence:** Codex + Muse: Task9 → Task17 → Task2 Lab regression check → Task13. Claude + Muse: Task15 → Task16. Then Task10 with Task5/Task6.a clean-up; Task8; T14.1; Task18; **pilot milestone**; rest of Task14; Task12 (and Task11 when triggered). A pilot may pull forward Task7, Task11, Task6.b, Attesta phase 2 or SCIM. | `ROUGH_ROADMAP.md` graph and sequence |
| 9 | No pilot date yet; Task9's Windows remainder may stay 🟡 until hardware is available. | `STATUS_BOARD.md` |
