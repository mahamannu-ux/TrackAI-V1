# TrackAI when code is written in the cloud

*Strategy note for the founder, 2026-10-22, by TrackAI-Orchestrator (Claude). Question asked: if developers stop coding on their own machines (cloud sessions, background agents, agent sandboxes such as Daytona) and almost all code becomes AI-written, does TrackAI still matter? Research from public sources as of October 2026 (listed at the end); numbers are as reported by their sources, most of them self-reported surveys. Recommendations are proposals, not roadmap changes.*

---

## 1. Bottom line

1. **Local development is not dying soon, but it is no longer the only place code is born.** In mid-2026 the most-used coding agents at work run on the developer's machine (Claude Code alone is used by 39% of 15,000 surveyed professionals), while cloud agents already write a real share of pull requests where teams adopt them (14% of all PRs in .NET's main repository). The likely future for our buyers over the next two to three years is **hybrid**: interactive work local, delegated work in cloud sandboxes, and the delegated share growing.
2. **Daytona's $1B valuation is a signal about agent infrastructure, not about enterprises abandoning laptops.** Its named customers are AI labs and agent vendors (Anthropic, OpenAI, Cursor, Cognition, NVIDIA): it sells the sandboxes those vendors' cloud agents run in. Enterprises meet it indirectly, through those vendors.
3. **TrackAI's risk is not the cloud; it is being an endpoint-only product.** If capture, security and evidence depend on software on the developer's laptop, every task that moves to a cloud agent leaves TrackAI's view. The fix is to treat the laptop as one sensor among several: endpoint, cloud sandbox or CI, model gateway, the source-control system, and vendors' audit logs.
4. **"All code is AI" makes provenance more valuable, not less.** The question stops being "how much was AI?" and becomes "which agent, under whose instruction and which policy, reviewed by whom, and can you prove it?" That is chain of custody, the same reason software bills of materials mattered more once most software was third-party.
5. **Endpoint coding-agent security is crowding fast with very large players** (Microsoft Defender, CrowdStrike, Palo Alto Networks, plus Pillar, Noma, Zenity and others). TrackAI should not try to win as an endpoint guard. Its defensible position is **neutral, cross-vendor, cross-surface evidence for the CISO**: what agents did, where, under which policy, verifiable by a third party. Attesta and Audit are the centre of that, not a side feature.

---

## 2. What is actually happening (evidence)

**Agents are now normal, and mostly local.**
- 90% of professional developers use AI coding agents at work at least weekly and 68% daily (JetBrains, 15,000+ developers, May–July 2026).
- Tool adoption at work: Claude Code 39% (up from 18% in January), GitHub Copilot 21% (down from 29%), Codex 16% (up from 3%), Cursor 12%, OpenCode 7%, Google Antigravity 6% (same survey). The market is fragmented and shifting quarter to quarter.
- Microsoft rolled out command-line agents (Claude Code, Copilot CLI) to its own engineers in early 2026; adopters merged about 24% more pull requests (Microsoft study, reported July 2026). These run in developers' terminals.

**Cloud agents are real where teams adopt them, and good at bounded work.**
- In `dotnet/runtime`, GitHub's cloud Copilot coding agent opened 878 of 6,181 PRs (14%) over ten months, with a 67.9% merge rate (humans: 80–87%). It works best on clean-up and tests, worse on performance work, runs only on Linux, and still needs heavy human review: 16.5 review comments per merged PR on average, against 12.4 for human PRs (Microsoft .NET blog, 2026).
- Claude and Codex now run as agents inside GitHub for Copilot Business and Pro customers (GitHub changelog, February 2026). Every major vendor offers a "send it to the cloud" mode next to its local tool.

**The agent-sandbox layer is being funded heavily.**
- Daytona raised $60M at a $1B valuation (October 2026), says its revenue run-rate grew 25-fold between January and September, and names Anthropic, OpenAI, NVIDIA, Cursor and Cognition as customers. It positions itself as "a computer for every agent": one API to start isolated Linux, Windows or macOS environments for agents to run code, for training, evaluation and production agents (Tech.eu, Fortune via Yahoo Finance).
- Cloud development environments for humans (GitHub Codespaces, Coder, Ona, formerly Gitpod) have existed for years. They are established in some regulated enterprises, but local editors remain the norm. I found no reliable recent figure for their share.

**AI's share of code is high and rising, and review is the bottleneck.**
- Developers self-report that AI produces 42% of committed code today, expecting much more by 2027 (Sonar, 1,100+ developers, January 2026). 42% of developers say AI writes at least half their code, up from 12% a year earlier (BairesDev, Q3 2026).
- Trust lags: 96% do not fully trust AI-generated code, and only 48% always verify it before committing (Sonar). 67% spend more time reviewing AI code than a year ago, and 78% of CTOs surveyed raised spending on review, QA and validation (BairesDev, small CTO sample).

**Security and governance money is flowing to agents.**
- In one week of July 2026: Cyera bought Oasis Security (agent and non-human identity governance) for about $1B, Okta bought Permiso for $200M, and Onyx Security raised $113M for "AI control" (StartupHub.ai).
- For coding agents specifically, a 2026 comparison lists Microsoft Defender for Endpoint, CrowdStrike Falcon, Palo Alto Networks (Koi), Pillar, Noma, Zenity, Straiker, Backslash, Snyk and others discovering and controlling agents on laptops through hooks, and notes that agents running in CI or on servers have no endpoint to instrument (Pillar Security; vendor-written, so treat rankings with care).

---

## 3. Where it is heading: three scenarios (2027–2029)

| Scenario | What it looks like | Likelihood (judgement) | What it means for TrackAI |
|---|---|---|---|
| **A. Hybrid** | Interactive work local or in an attached remote box; bounded tasks sent to cloud agents; the cloud share grows from roughly 10–20% of PRs toward a majority in agent-forward teams | Most likely for regulated enterprises (our CISO buyers) | Both sensors needed; endpoint matters less every year; evidence across both is the value |
| **B. Cloud-first delegation** | Developers mostly direct and review from a browser or phone; nearly all code written in vendor or company sandboxes | Plausible for startups and tech companies; slower in regulated enterprises (data residency, secrets, approvals) | Endpoint capture becomes marginal; capture must live in sandboxes, gateways, source control and vendor logs |
| **C. Vendor consolidation** | One or two platforms (for example GitHub plus one model vendor) own the editor, the agents, the sandboxes and their own analytics and attestations | Possible in some single-vendor shops; unlikely market-wide given today's fragmentation | A neutral, cross-vendor witness is the only reason to buy TrackAI; single-vendor shops may not need us |

**Why regulated enterprises move slower to B:** source code and secrets leaving the company's control, sandbox data residency, approval of each vendor's cloud, egress rules and audit requirements. These are exactly the CISO's concerns, which is where TrackAI is sold.

**Leading indicators to watch** (and to measure in pilots):
1. Share of merged PRs whose author or co-author is an agent identity (for example `copilot-swe-agent`, Codex or Claude bots).
2. Whether vendors ship their own signed provenance for agent PRs (for example GitHub artifact attestations attached to agent PRs).
3. Enterprise mandates for cloud workspaces (Coder, Codespaces) for security reasons.
4. Endpoint security suites bundling coding-agent controls at no extra cost.

---

## 4. What happens to each TrackAI pillar

| Pillar | Today (endpoint-centred) | In a cloud-agent world | Verdict |
|---|---|---|---|
| **Attribution and lifecycle (Task2, Task13)** | GitAI on the laptop writes line-level attribution into Git Notes | Code from cloud agents arrives as PRs from agent identities; whole-PR attribution is easy, line-level detail and prompt evidence live in the vendor's cloud | Still needed, but capture must move to where code is born; the metric shifts from "% AI" to accountability (below) |
| **Evidence explorer (Task5)** | Prompts and tool calls collected from local agent databases | Session evidence sits in vendor clouds and sandboxes | More valuable as intent tracing across agents; needs vendor log or sandbox connectors |
| **Security (Task6.a, Task20)** | Numbat-based monitoring of agents on Macs | Many agent actions happen in sandboxes where the sandbox's isolation and egress rules matter more than laptop hooks; laptops are being covered by EDR giants | Keep endpoint monitoring as one sensor; differentiate on governance and evidence, not on runtime blocking |
| **Provenance and audit (Task15, Task16)** | Signed, anchored statements per commit and PR; auditor trail | Independent of where code was written: statements are made from what TrackAI observed at the source-control level plus whichever sensors saw the work | Strongest pillar in every scenario; becomes the product's centre |
| **Productivity (Task2, Task5)** | AI share, rework, churn per repo, PR, model, developer | Agent fleet economics: merge rate, review load, cost per merged change, rework by agent and model | Shifts, does not disappear; review load is today's most painful number |

---

## 5. "If all code is AI-written, is attribution meaningless?"

No, but its meaning changes.
- **From share to accountability.** When 100% is AI-written, "% AI" is a constant. What a CISO, auditor or acquirer needs is: which agent and model, started by whom, with what permissions, under which policy, reviewed and approved by whom, and whether the record can be trusted. That is provenance, and it is what Attesta signs.
- **From authorship to intent.** "Why does this line exist?" (Task5's code-to-intention path) becomes the main way to understand a codebase nobody typed. Entire.io built a company on that question.
- **Human review becomes the scarce, auditable act.** "% of AI changes merged with real human review", "review time per change" and "changes merged without review" become governance metrics, and possibly contractual ones.
- **Most organizations are not there yet,** as the founder says: self-reported AI share is around 42% and very uneven across teams and repositories. The transition period, which is years, is where line-level attribution sells; the accountability view is where it ends up.

---

## 6. Competition map

| Who | What they cover | What they do not |
|---|---|---|
| Model and agent vendors (OpenAI incl. Git AI, Anthropic, GitHub, Cursor, Google) | Analytics and logs for their own tools; sandboxes for their own cloud agents | Other vendors' agents; neutral evidence; the customer's own key custody |
| Endpoint security suites (Microsoft, CrowdStrike, Palo Alto) and agent-security startups (Pillar, Noma, Zenity and others) | Discovery and blocking of agents on laptops; some MCP and gateway control | Code provenance, lifecycle to production, signed evidence for auditors and acquirers |
| Identity and data governance (Okta, Cyera after their acquisitions) | Agent identities, permissions, data access | What code agents produced and whether it was reviewed |
| Agent-sandbox infrastructure (Daytona, E2B, Modal and similar) | Isolated execution for agents | Customer-facing governance, provenance, audit; potential partners and capture points |
| Code quality and composition (Sonar, SCANOSS, FOSSA) | Quality, security and licence of the code itself | Who or what produced it, under what policy |

TrackAI's open position: **the neutral record of what AI agents did to a company's code, across every vendor and every place code is written, that a third party can verify.** Nobody in the table owns that, and vendors cannot credibly own it for themselves.

---

## 7. Recommendations

**Positioning.** Move from "AI code attribution and agent security on developer machines" to: *"Chain of custody for AI-written code, wherever it is written: every agent, every model, laptop or cloud, with evidence your auditors and acquirers can verify."*

**Roadmap implications (for discussion, not yet decisions):**
1. **Task13: raise the cloud and background routes (AC-BG) and design a "sandbox sensor".** Most cloud agents run repository-defined setup steps and honour repository-committed agent configuration; installing GitAI and its hooks there could capture cloud sessions the same way as laptops. To verify per vendor (Codex cloud, Copilot coding agent, Claude Code on the web, Cursor background agents). Key technical risk: whether sandboxes may push Git Notes.
2. **A capture floor that needs no client:** source-control signals (agent bot authors, co-author trailers, agent PR metadata) and, where vendors expose them, their enterprise audit or compliance logs as connectors. This guarantees every agent PR is at least attributed and attested even when no sensor was present.
3. **Task20 (Numbat):** keep the scope the founder approved; position it as one sensor feeding evidence and audit, and plan to ingest from customers' existing endpoint security (Defender, CrowdStrike) rather than compete with it.
4. **Attesta (Task15) and Audit (Task16) are the core:** statements per PR regardless of where code was produced, with the reviewer as a first-class field. Add **witness co-signing** to phase 2 (see `ATTESTA_MOAT_2026-10-21.md`).
5. **Metrics:** add human review coverage, agent merge and revert rate, review load and cost per merged change to the productivity view (Task2/Task5/Task10).
6. **Task9 (fleet):** finish what the pilot needs; avoid expanding endpoint-only investment beyond it until pilot data shows how much work stays local.
7. **Ask every pilot customer:** where is code written today, where in 12 months, which agents are approved, and whether cloud agents are allowed on regulated repositories. Their answers decide the weight between sensors.

---

## 8. Honest risks

- If a customer standardizes on one vendor whose platform ships good provenance and audit for its own agents, TrackAI's value there shrinks to neutrality and multi-repository evidence.
- Capture inside vendor sandboxes depends on vendors keeping setup steps and hooks open; they may restrict them.
- Self-reported survey numbers overstate precision; pilot data will be the real evidence.

---

## Sources
- [Daytona hits $1B valuation with $60M Series B for AI agent cloud — Tech.eu](https://tech.eu/2026/10/20/daytona-hits-1b-valuation-with-60m-series-b-for-ai-agent-cloud)
- [Exclusive: Daytona, a startup building the 'agentic cloud,' valued at $1 billion — Yahoo Finance](https://finance.yahoo.com/technology/ai/articles/exclusive-daytona-startup-building-agentic-120000625.html)
- [AI Coding Agents: Adoption Trends — JetBrains Research, August 2026](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/)
- [Ten Months with Copilot Coding Agent in dotnet/runtime — Microsoft .NET Blog](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/)
- [Claude and Codex now available for Copilot Business & Pro users — GitHub Changelog](https://github.blog/changelog/2026-02-26-claude-and-codex-now-available-for-copilot-business-pro-users/)
- [Microsoft's CLI Coding Agent Study — Developers Digest](https://www.developersdigest.tech/blog/microsoft-cli-coding-agents-study-2026)
- [State of Code Developer Survey — Sonar, January 2026](https://www.sonarsource.com/blog/state-of-code-developer-survey-report-the-current-reality-of-ai-coding/)
- [BairesDev Q3 2026 Dev Barometer — VentureBeat](https://venturebeat.com/data/the-share-of-developers-using-ai-to-write-half-or-more-code-jumped-from-12-to-42-yoy-in-latest-bairesdev-survey)
- [Five transactions in seven days put a price on AI agent governance — StartupHub.ai](https://www.startuphub.ai/ai-news/ai-news/2026/agentic-ai-governance-five-deals-week-july-2026)
- [Best AI Coding Agent Security Tools for the Enterprise (2026) — Pillar Security](https://www.pillar.security/blog/best-ai-coding-agent-security-tools-for-the-enterprise-2026)
