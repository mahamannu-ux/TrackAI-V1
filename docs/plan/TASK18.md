# Task18 — Real-World Validation (Simulated Organization)

*Status: 🔴 not started; after Task8 and the pilot-hosting slice of Task14 (T14.1), before the rest of Task14 (founder decision 2026-10-12). Details when the Task starts.*

**Purpose.** A final real-world run of the core product before a pilot, far larger than Task2's controlled scenarios: a simulated organization with **10 repositories, 3 users and 3 machines** (a rented Windows laptop and a macOS machine at least), real-sized code changes over days, several agents and models.

**What it proves.**
- **Lifecycle correctness at scale (Task2):** including stacked PRs, merge queues and other T2.22/E16 cases on GitHub.
- **Evidence exploration (Task5):** prompt-to-PR and back on real histories.
- **Security monitoring (Task6.a):** findings on real agent use, within the supported routes.
- **Productivity metrics:** the 20-question list (`docs/plan/CUSTOMER_AUDITOR_QA.md`) answered for the whole organization.
- **Attesta and audit (Task15/16):** statements, anchoring, evidence packs verified offline, audit trail of every admin action.
- **Onboarding (Task8):** the organization is set up through the pilot flows, not by hand.

**How.** Runs on the pilot hosting (Task14 T14.1), so it also rehearses the pilot environment. Browser checks automated with Playwright where practical. The Lifecycle Lab remains the independent acceptance authority for metric meaning.

**Roles.** Codex leads (evidence-heavy, founder-live); Muse builds automation and fixtures; Claude reviews customer-facing results and the Q&A answers.
