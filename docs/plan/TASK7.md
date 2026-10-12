# Task7 — SCM and CI/CD Integrations (deferred to the pilot milestone)

*Status: 🔴 not started; deferred until a pilot needs it (founder decision 2026-10-12). Scope notes from the 2026-10-12 re-plan; the lead writes the primer when the Task starts.*

## Why deferred
GitHub is enough for a pilot demo. Line-level attribution is captured on the developer machine and stored in Git Notes, so **Generated** and **Committed** already work on any provider; a provider integration adds the PR, merge and production stages. A GitLab shop still gets half the story without Task7.

## Provider order (orchestrator's assessment, directional, not fresh market research)
1. **GitLab:** clear second overall; strong in self-hosted, regulated, EU and government settings.
2. **Azure DevOps (Repos):** larger than its overall share in large Microsoft-centric enterprises, banks, insurers and government, where CISO budgets sit.
3. **Bitbucket:** Atlassian (Jira) shops; Atlassian is moving customers from self-hosted to cloud, so expect churn.
Ignore AWS CodeCommit (closed to new customers in 2024); Gerrit, Gitea and Forgejo are niche. The pilot pipeline decides the actual order.

## CI/CD signals that belong here
- **Production beyond GitHub:** Task2's Production stage needs a deployment event; today only GitHub deployments are read. Add CD tools (Argo CD, Jenkins, GitLab environments, Azure Pipelines).
- **CI results for quality outcomes:** does AI-written code fail CI, get rolled back or cause incidents more often (DORA change-failure rate split by AI vs human)? Task7 brings the results in; Task2/Task5 own the metric.

## Stacked PRs, merge queues (also see Task2 T2.22/E16)
GitHub stacks (Graphite, ghstack, spr and similar tools) and GitLab stacked diffs build PRs on other PRs' branches; merge queues and merge trains create temporary merge commits. Risks for TrackAI: In-PR lines counted twice across a stack, attribution lost when each layer is squash-merged and the next is rebased (often server-side, where Git Notes are not carried), and production attribution through merge-group commits. **GitHub behaviour is Task2's** (T2.22/E16, already open: "stacked/reopened/retargeted PRs, backports, merge queues"), run in a Lifecycle Lab session and at scale in Task18; Task7 brings the GitLab, Azure DevOps and Bitbucket equivalents.

## Other CI/CD items, owned elsewhere
| Item | Owner |
|---|---|
| CI gate: a check on each PR showing Attesta status and policy (first version as a GitHub check posted by TrackAI's server) | Task15 A15.14; policy rules later in Task6.b |
| AI agents running in CI and the cloud (Copilot coding agent, Claude Code in Actions, Codex cloud, Cursor background): capture inside CI runners | Task13 (AC-BG routes) |
| Build provenance: SLSA build records linked to Attesta statements ("this release contains 31% AI-written code, all attested") | Task14 T14.7 + Attesta phase 2 |
| Bot commits (Dependabot, release bumps, formatters) labelled "automation", neither human nor AI agent | Task2 (`BUG_BACKLOG.md` B18) |

## Workstreams
T7.1 provider-neutral contract; T7.2 GitLab; T7.3 Azure DevOps; T7.4 Bitbucket; T7.5 webhook/event parity; T7.6 MR/PR, merge-train and stacked-diff semantics; T7.7 CD deployment signals; T7.8 CI results; T7.9 cross-provider conformance suite.
