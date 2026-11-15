# CodeRabbit: competitor and threat assessment

*Written 2026-11-04 by TrackAI-Orchestrator at the founder's request. Facts about CodeRabbit come from its own pricing page, documentation, changelog and press releases, plus third-party sources, all listed at the end (checked 2026-11-04). TrackAI facts come from `main` at `ad135c1`. Revenue and funding are only summarised: the founder already has those figures.*

## 1. Bottom line

- **CodeRabbit is the strongest company in AI code review, and it is moving up the stack.** It started as an AI pull-request reviewer and since August 2026 has called itself "Agentic Change Management". The new pieces are Triage (which PRs matter), Change Stack (explaining a change), Security (code scanning), Plan (intent before coding), a cloud Coding Agent, and Slack and Discord agents. It now sits at the pull request, the one place every human and AI change passes through.
- **It is a direct threat to one TrackAI idea and only an indirect threat to the rest.**
  - **Direct:** IDRES and the line "code reviews expire in 2027" (VISION §5). CodeRabbit is already selling the replacement for human code review to 17,000+ customers, with explanations, merge-risk ratings and automatic approval.
  - **Indirect:** CISO security budget (its Security product scans code) and engineering-productivity analytics (review dashboards).
  - **Not today:** AI attribution, endpoint capture, coding-agent runtime security, signed provenance and tamper-evident audit. CodeRabbit has none of these.
- **CodeRabbit does not install on endpoints the way TrackAI does.** It is a cloud service (or a self-hosted container) attached to the Git platform. Its IDE extension and CLI upload local diffs for review; they do not observe agents, sessions or authorship. Its "slop detection" guesses at low-quality AI content and says outright that it doesn't establish who or what wrote the code.
- **Recommended position:** *CodeRabbit (and Copilot, and humans) review the change. TrackAI proves where it came from, who or what approved it, and what the agent did on the machine, with evidence a third party can verify.* Be the neutral system of record for AI-made change, and integrate with CodeRabbit rather than compete on review quality. Section 7 gives the strategy; section 8 lists what to build.

## 2. The company in brief

| Item | Fact | Source |
|---|---|---|
| Founded | 2023; CEO Harjot Gill | Airframe; press release |
| Latest round | $143M Series C at a $1.5B valuation, about 2026-08-12, co-led by Atomico and Smash Capital; new investors include BMW i Ventures and Datadog | BusinessWire |
| Growth | Revenue more than 5× year over year; more than 2 million reviews a week; more than 17,000 customers; more than 150,000 open-source projects | BusinessWire |
| Named customers | Adyen, BMW, Indeed, JFrog, NVIDIA, Trivago, Campfire | BusinessWire |
| ARR | About $50M mid-2026, from third-party estimates (unverified) | founder; clinkbill, arr.club |
| Go-to-market | Product-led: free for open source, 14-day trial, self-serve seats. Sales-led Enterprise, with a CRO appointed 2026-04-02. Listed on the Claude Marketplace (2026-05-27). Joined OpenAI's Daybreak Defense Network (2026-10-26) with $1M of free security scans | BusinessWire; Techzine |
| Who the customers are | Mostly teams that buy per developer: startups and mid-size engineering teams (10–100 developers, reviewers call this the sweet spot), plus a growing enterprise tier. "17,000 customers" counts organisations of every size, including small ones, so it is not 17,000 enterprises. Self-hosting needs 500+ seats, so the regulated self-hosted segment is small | aicodereview.cc; self-hosted docs |

## 3. Products and pricing (pricing page, 2026-11-04)

Plans per developer per month, billed annually: **Essentials $24, Team $48, Advanced $72, Enterprise custom.** Monthly billing costs about 20% more. Free for public repositories.

- **Usage:** reviews beyond an hourly allowance per developer (5, 8, 10 or 12 by plan) are billed on consumption, with spending caps.
- **Add-ons:** CodeRabbit Engineer (a Slack and cloud coding agent) and Deep Scan (a full-repository security scan), both usage-based.
- **Repository limits:** linked repositories are capped at 1 / 5 / 10 / 20 by plan, which reviewers call the most consequential limit on Essentials.

## 4. How CodeRabbit works

### 4.1 Cloud review pipeline
1. **Intake.** A webhook service receives Git platform events and checks billing, then queues one task per review on Google Cloud Tasks.
2. **Execution.** Each review runs in a Cloud Run job: a second-generation microVM, with Jailkit process isolation, a least-privilege service identity, and an in-memory volume for the repository. Instances are 8 vCPU and 32 GiB, over 200 at peak, and a review takes 10–20 minutes.
3. **Per review:**
   - clone the whole repository and install dependencies;
   - run 50+ linters and SAST tools (Semgrep, OpenGrep, TruffleHog, Checkov, Trivy, ESLint, Ruff and others);
   - let the model write and run its own shell and Python scripts and ast-grep queries to explore the code;
   - call external tools through MCP or `curl` (Jira, Linear, Slack).
4. **Models.** Code goes to OpenAI and/or Anthropic for review only. CodeRabbit says neither it nor they train on customer code.
5. **Context kept between reviews:**
   - encrypted caches of code and dependencies;
   - vector embeddings of the code;
   - "Learnings": team preferences taken from PR replies and stored per organisation, with an opt-out;
   - Code Guidelines read from rule files, including `CLAUDE.md`, `.cursorrules` and, since 2026-10-15, `.claude/rules/`;
   - multi-repository analysis;
   - a "codegraph" for dependencies and trust boundaries.
6. **Outputs:**
   - a summary and walkthrough comment with diagrams;
   - line comments with one-click fixes;
   - a merge-risk rating from Minimal to Critical;
   - pre-merge checks;
   - optionally, a request-changes review or an approval;
   - follow-up PRs from Finishing Touches and Post-Merge Actions.

### 4.2 Deployment options
- **SaaS** (US, plus an EU region) on GitHub, GitLab, Azure DevOps and Bitbucket Cloud.
- **Self-hosted** (Enterprise, 500+ seats):
  - one container image the customer runs on a server, a container platform or serverless;
  - works with GitHub Enterprise Server, self-managed GitLab, Azure DevOps and Bitbucket Data Center;
  - the customer brings its own model provider; code leaves only to reach it;
  - a Reverse Tunnel keeps all connections outbound.

### 4.3 Developer-side tools (the closest thing to an endpoint)
| Tool | What runs locally | What goes to the cloud | Notes |
|---|---|---|---|
| IDE extension (VS Code, Cursor, Windsurf) | Git-ignore filtering; "Fix with AI" hands a finding to the developer's own agent | For every reviewed file: path, full content, diff, plus account and repository details | `.env` files can be uploaded unless git-ignored. Reviews, with full file contents, are kept in local storage even after uninstall |
| CLI (`cr`) and agent mode | Collects the local changes | Same review request, processed in the cloud | `cr review --agent` emits newline-delimited JSON so Claude Code, Codex, Cursor or Gemini can run a review, fix and re-review loop before the PR |
| Jamf deployment for managed Macs | A signed CLI binary | — | A script, not a package: no inventory, compliance reporting or uninstall; self-update turned off |

**So: no.** CodeRabbit has no resident endpoint agent. Nothing like TrackAI's daemon and hooks that record, as each edit happens, which agent and model wrote which lines; nothing that observes sessions, prompts, tool calls, MCP servers or risky agent commands on the machine. What it sees on an endpoint is a diff the developer chose to send.

### 4.4 Security record
In January 2025, Kudelski Security reported a remote-code-execution flaw: RuboCop ran outside the sandbox, so a malicious `.rubocop.yml` in a PR executed code on CodeRabbit's production servers. The exposed secrets included the GitHub App private key (giving write access to about 1M repositories across 80,000+ installations), OpenAI and Anthropic keys, and database credentials. CodeRabbit fixed it within days (2025-01-30): it rotated the secrets, moved every tool into the sandbox and automated sandbox checks. The disclosure became public at Black Hat in August 2025.

The lesson for buyers is lasting: **an AI reviewer that clones the whole repository, runs third-party tools and holds write access to every connected repository is itself a high-value supply-chain target.** TrackAI's pitch can use this fairly, without gloating:
- signed evidence and an offline verifier mean nobody has to trust the service operator;
- TrackAI does not need write access to repositories.

## 5. Feature matrix: CodeRabbit Enterprise against TrackAI

Rows follow the pricing page's categories. Every row is included in the Enterprise plan.

**TrackAI status:**
- **built:** merged on `main`;
- **planned (TaskN):** in a Task plan;
- **vision:** only in `VISION.md`;
- **none.**

**Recommendation:**
- **Build:** TrackAI should build its own version;
- **Integrate:** consume CodeRabbit's (or anyone's) output as evidence;
- **Skip:** not TrackAI's game.

### 5.1 Review
| CodeRabbit feature | How it works (one line) | TrackAI today | Gap and recommendation |
|---|---|---|---|
| Pre-PR reviews in CLI, IDE and agent loops | The IDE or CLI uploads local diffs; the cloud reviews them; agents read the JSON findings and fix in a loop | none (TrackAI's endpoint captures, it doesn't review) | **Skip** reviewing. **Integrate:** record that a pre-PR review ran, and its verdict, as evidence on the session (Task5/Task13) |
| PR summaries, walkthroughs, diagrams | A model reads the diff and repository context and posts a summary, a file-by-file walkthrough and sequence diagrams | partial: Task5 explains commits from captured sessions (built for OpenCode); IDRES item 1, "why does this exist", is vision | **Build** a PR intent summary from *captured* intent (prompts, sessions, decisions): something CodeRabbit infers from the diff, but TrackAI knows |
| Chat | `@coderabbitai` answers questions on the PR from the code and context | none; Task5 has search and semantic retrieval | **Later:** "ask the evidence" on top of Task5 and Task19 answers |
| Learnings | Replies on PRs become stored team preferences, applied to later reviews | none; IDRES item 3, decision records, is vision | **Build** decision records (IDRES 3) from sessions, which is a different source; don't copy Learnings |
| Autofix (now "Fix comments") | One click applies a suggested fix, or hands it to the developer's agent | none | **Skip** |
| Slop detection | Heuristics flag a PR as low-quality AI content; the docs say it does not establish authorship; it never blocks | **stronger:** Task2 line-level attribution of AI versus human, by agent and model, from edit to merged PR and production | **TrackAI's edge:** say this loudly. Measured authorship beats guessed "slop" |
| Pre-merge checks | Four built-in checks plus natural-language custom checks; in `error` mode they block (with Automatic Approvals) | partial: A15.14 informational GitHub check of attestation status (Task15m prompt written, always `neutral`); policy rules in Task6.b (deferred) | **Build** provenance pre-merge policies, e.g. "AI share above X% needs a named human approver", "unknown agent blocks", "unattested commits warn" (§8) |
| Unit test generation, Finishing Touches, post-merge actions | Natural-language recipes open follow-up PRs: tests, docstrings, changelog, CI fixes, tickets | none | **Skip.** CodeRabbit's own agent is one more AI author TrackAI must attribute (B18, Task13) |
| Linked repositories, hourly limits | Plan-based quotas | n/a | Pricing note: TrackAI should not meter by reviews |

### 5.2 Triage
| CodeRabbit feature | How it works (one line) | TrackAI today | Gap and recommendation |
|---|---|---|---|
| Prioritised PR queue, review guidance, actions, Slack triage | Ranks open PRs into P0–P3 bands using review severity, linked Jira/Linear priority and dependencies; rules can merge, close, autofix or remind | none | **Skip** the queue. **Integrate:** expose TrackAI signals (AI share, agent, model, whether the session was attested or security-flagged) that a triage tool or rule can use, via an MCP server or API (§8) |
| Security-informed PR prioritisation | Security risk feeds Triage rules; close nominations exclude security-flagged PRs | partial: Task20 will tie agent findings to machines and sessions, not to PRs | **Build** a link from session findings to the PR ("a risky agent action happened during the work in this PR"). CodeRabbit can't see that |

### 5.3 Explain
| CodeRabbit feature | How it works (one line) | TrackAI today | Gap and recommendation |
|---|---|---|---|
| Change Stack, semantic diff, findings, chat | Regroups a PR into ordered "layers" (contracts, behaviour, integrations, tests, migrations) with findings pinned to ranges, per review snapshot | partial: Task5 code-to-intention navigation (T5.8) and semantic intention review (T5.9), built | **Skip** the diff viewer. **Build** intent-versus-change (IDRES 2, intent drift): compare the stated intent (ticket, prompt, plan) with what changed |
| Blast radius and architecture impact | A codegraph maps dependencies, consumers and trust boundaries; before-and-after architecture diagrams | none | **Skip:** a commodity in the making, and CodeRabbit leads it |

### 5.4 Secure
| CodeRabbit feature | How it works (one line) | TrackAI today | Gap and recommendation |
|---|---|---|---|
| Security code review (static analysis, secrets, dependencies, infrastructure) | The PR review runs SAST, secret and IaC scanners and model reasoning; findings come with reachability tiers | different layer: Task20 (Numbat) monitors what coding *agents do* on the machine; Task6.a monitor-only findings are built | **Skip** SAST. **Integrate:** import findings into the Audit and Attesta evidence pack, so the pack says "this was scanned and these issues were open at merge" |
| Continuous security review, PR security review, security architecture review, security blast radius | Recurring Deep Scans of committed code and IaC; an attack-surface map; delta scans; runtime reproduction of findings; a PR security check that can block merges | none for code; endpoint coverage and inventory planned in Task20 | **Skip** code scanning (Snyk, Semgrep, Checkmarx and now OpenAI's Codex Security crowd it). Keep TrackAI's security story on **agent behaviour, not code flaws**, which no code scanner sees |

### 5.5 Enterprise controls
| CodeRabbit feature | How it works (one line) | TrackAI today | Gap and recommendation |
|---|---|---|---|
| Jira and Linear integration | Tickets give review context, validate a PR against its linked issue, and set Triage priority | deferred: T5.4 work-item linkage (customer-led) | **Build, and move earlier:** intent drift and per-ticket AI share need it; target the pilot (§8) |
| Usage analytics | Dashboards of review metrics: acceptance rate, comments by severity, time to merge and first human review, learnings, pre-merge and finishing-touch runs. No AI-authorship metrics | **stronger:** Task2 lifecycle metrics (Generated → Committed → In-PR → Merged → Production, Reworked; Churned still `Unavailable`) by repository, PR, model and agent; Task5 pain-point analytics | **TrackAI's edge.** Add the review dimension: "AI code reviewed by AI only, by a human, or both" (§8) |
| Scheduled reports | Recurring reports, customisable with prompts, to email or Slack | partial: Attesta `period_report` statements (signed) are built; no scheduled delivery | **Build** scheduled delivery of signed period reports (small) |
| Usage caps | Monthly spending and review limits | n/a | n/a |
| MCP connections | CodeRabbit calls the customer's MCP servers for extra review context (20 on Enterprise) | none (Task11 public API deferred; B17 API tokens) | **Build a read-only TrackAI MCP server** (provenance, attestation status, session findings for a commit or PR). CodeRabbit, Copilot and agents could then query TrackAI, which turns their reach into TrackAI's distribution (§7) |
| Custom pre-merge checks per organisation | Natural-language checks, at most 1,000 characters each | none (Task6.b deferred) | Covered by the provenance policies in §5.1 |
| Custom finishing recipes per repository | Natural-language follow-up actions | none | **Skip** |
| Multi-org administration and enforced policies | Several Git organisations under one admin; central configuration inherited downward | partial: Task4 tenant and admin; Task9 fleet configuration (signed documents) | **Later:** multi-org for large enterprises (Task8 or Task14) |
| Custom roles, SSO, audit logs | SAML (Okta, Entra, Google), SCIM, custom roles. The audit log records admin and config events and is called "tamper-resistant" without saying how | partial: SSO and roles planned in Task8. **Audit stronger:** Task16 signed audit seals over audit events, verify routes and signed export, all built (Task16e) | **Build** SSO and SCIM (table stakes; Task8). **Sell** signed, verifiable audit as a clear difference |
| API with review and MCP metrics | REST API for metrics, learnings, users, roles, audit logs, Deep Scan findings | partial: Attesta Evidence API (auditor-readable) built; general API deferred (Task11, B17) | **Build** B17 API tokens and a read-only metrics API before the pilot |
| Support SLA, customer success, enablement | Enterprise contract terms | n/a (founder-led) | Services arm (Custodia S2) |
| Self-hosting and choice of SaaS region | Container for 500+ seats; EU region | planned: Task14 (portable PostgreSQL, Supabase today) | **Opportunity:** self-host or customer VPC at any seat count, for regulated buyers CodeRabbit turns away below 500 seats |
| Marketplace purchasing, vendor security reviews, negotiated contracts | Procurement paths | planned: Task12 trust centre | Later |

### 5.6 Add-ons and newer products
| CodeRabbit product | How it works (one line) | TrackAI angle |
|---|---|---|
| CodeRabbit Engineer and Coding Agent | Tasks from Slack, the CLI or PR findings run in cloud sandboxes and come back as commits or stacked PRs | A new **AI author** inside the customer's repositories. TrackAI must attribute bot and cloud-agent commits (B18, Task13 cloud routes) |
| Deep Scan | An agentic red-team scan of committed code (models include GPT-6.1 Sol), with prioritised fixes | **Skip** |
| CodeRabbit Plan | Turns an issue, PRD or text into a versioned coding plan with prompts to paste into any agent | An **intent source.** IDRES should ingest plans (CodeRabbit's or anyone's) as the "stated intent" to check the code against |

## 6. What customers actually love, and what they don't

*Evidence is mostly review sites and practitioner write-ups. No neutral, large-sample study of satisfaction or false-positive rates exists (aicodereview.cc says so explicitly). Confidence: medium.*

**Loved, in order of how often it comes up:**
1. **PR summaries and walkthroughs:** reviewers understand a big PR in a minute.
2. **Fast, contextual line comments** (a few minutes after the PR opens), with one-click fixes.
3. **Zero-effort setup and breadth:** install the app and it works on four Git platforms; plain-English configuration; it reads existing `CLAUDE.md` and `.cursorrules` files.
4. **Learnings:** noise falls as the team replies.
5. **Free for open source:** a large funnel, with 1M+ open-source reviews in September 2026.
6. **Agent-loop CLI:** newer, and growing with Claude Code, Codex and Cursor usage.

**Disliked:**
1. **Noise:** nitpicks and too many minor comments; it gets verbose on large PRs. CodeRabbit added "Source lines" (2026-07-02) so each comment shows its triggering rule.
2. **Limits:** hourly review caps, fair-usage throttling, a one-repository limit on Essentials.
3. **Uneven depth:** one evaluation, whose independence is unconfirmed, scored completeness 1/5 and depth 2/5. Martian's Code Review Bench (2026-03) put it at 51% F1, not the top.
4. **Support** outside Enterprise.

Ratings: G2 shows 4.4/5 from 143 reviews; noise is the main complaint.

**What this means for TrackAI:**
- Customers love **understanding a change quickly** and **getting feedback with no setup**.
- TrackAI should match the first through *intent summaries from real evidence* (IDRES). The second is a warning: TrackAI's endpoint install is heavier than adding a GitHub App, so Task9 (fleet and MDM) and a "GitHub App only" starter mode matter commercially.

## 7. Threat assessment and positioning

### 7.1 Where CodeRabbit threatens TrackAI
| TrackAI area | Threat | Why |
|---|---|---|
| IDRES and the "code review expires" narrative (VISION §5) | **High** | CodeRabbit is already the AI replacement for line-by-line review, with explanations, merge risk, automatic approval and planning, and it markets Agentic Change Management to the same "AI writes the code" story. A TrackAI pitch of "we replace code review" walks into its strongest ground |
| CISO security budget | **Medium** | "AI code security" money may go to CodeRabbit Security and Deep Scan, which bundle cheaply into a tool teams already use. TrackAI's agent-behaviour security (Task20) is a different control, but buyers may not see the difference unless it's spelled out |
| Engineering-productivity analytics | **Low–medium** | Its dashboards measure review, not AI authorship or rework. It could add AI-share estimates from its slop signals, but those would be guesses |
| Attribution, provenance, Attesta, Audit, endpoint | **Low today, worth watching** | Nothing comparable exists. Watch for: authorship claims beyond slop detection; signed or attested review records (Deep Scan findings gained "provenance data" on 2026-09-23); and Coding Agent telemetry |
| Distribution | **High** | 17,000+ customers, a GitHub App installed across millions of repositories, Marketplace listings. Bundling beats point products unless the point product is a control others can't provide |

### 7.2 Where CodeRabbit is weak, relative to what TrackAI is building
1. **No ground truth about authorship.** It reviews the diff and never sees the session. It cannot answer "which agent and model wrote these lines, from which prompt, under which policy".
2. **Not neutral.** It reviews, approves and now *writes* code (Coding Agent, Engineer). An auditor or acquirer will discount evidence from a party that both produced and approved the change (`ATTESTA_MOAT_2026-10-21.md`, self-audit). TrackAI's neutral, cross-vendor witness position is the opposite.
3. **No verifiable evidence.** Its audit log covers admin events; "tamper-resistant" is unexplained. There are no signed statements, transparency anchoring or offline verifier.
4. **No endpoint or agent-runtime view.** Secrets read by an agent, dangerous shell commands, MCP servers used, local agents' activity: all invisible to a PR reviewer.
5. **A supply-chain target.** It holds write access to repositories and runs third-party tools on untrusted PRs (the 2025 RCE).
6. **Self-hosting only at 500+ seats;** code goes to OpenAI or Anthropic.

### 7.3 Recommended positioning
**One line:** *"AI writes and reviews your code. TrackAI is the evidence: who or what wrote it, why, who approved it, and what the agents did, signed and verifiable without trusting us."*

- **Category:** the system of record and evidence layer for AI-made software change, sold to the CISO (then engineering leadership and audit). It is not a reviewer.
- **CodeRabbit is a complement and a data source**, like GitHub and Jira. TrackAI records its reviews as evidence, just as it records human reviews.
- **Reframe IDRES:** move from "IDRES replaces code reviews" to "**intent review needs evidence**". The AI reviewer (CodeRabbit, Copilot) checks the code; IDRES records what was *intended*, what was *decided*, whether the code *matches*, and *who approved*, as signed evidence. This keeps the vision intact and stops CodeRabbit from setting the terms.
- **Proof points to lead with:**
  - measured line-level AI share by agent and model (against slop guesses);
  - agent-behaviour security on the endpoint;
  - signed provenance with an offline verifier;
  - signed, verifiable audit seals;
  - customer and auditor Q&A answers (Task19);
  - self-host or customer VPC for regulated buyers below 500 seats.
- **Pricing contrast:** CodeRabbit charges $24–72 per developer for productivity. TrackAI's modules (Security, Attribution and productivity, Attesta) should be priced against compliance and risk outcomes, and must not look like "another per-seat reviewer".

### 7.4 Partnership option
Being a CodeRabbit MCP source is the cheapest route to its installed base: its Enterprise plan connects to up to 20 MCP servers per organisation. A TrackAI MCP server that answers "provenance and attestation status for this PR" lets CodeRabbit's reviews cite TrackAI evidence. That is low-risk and doesn't depend on CodeRabbit's goodwill. A formal partnership comes later, if the pilot shows demand.

## 8. What TrackAI should build (not yet built or planned)

Ordered by value to the positioning against effort. Effort is a rough size only: the owning Task's lead estimates properly.

| # | Item | Why | Where it fits | Size |
|---|---|---|---|---|
| 1 | **Review evidence ingestion:** record CodeRabbit, Copilot and human reviews (reviewer type, verdict, merge risk, open findings at merge) as Attesta `review_recorded` statements | Turns "AI reviewed AI code" into signed evidence; "who approved" for IDRES; reserved kind G3 already exists | Task15 phase 2 or Task16, with Task7 for webhooks | M |
| 2 | **Provenance pre-merge policies** on top of the A15.14 check: AI-share threshold → human approver required; unknown agent or model → fail; unattested commits → warn | The CISO's control at the PR, which CodeRabbit can't offer because it lacks authorship | Task6.b subset, pulled forward; A15.14 base | M |
| 3 | **Read-only TrackAI MCP server and API tokens:** provenance, AI share, attestation and session-finding status per commit or PR | Distribution through CodeRabbit, Copilot and agents; unblocks automation (B17) | Task11 subset (B17) | S–M |
| 4 | **IDRES intent drift with Jira/Linear linkage** (un-defer T5.4), also taking plans (CodeRabbit Plan, PRDs) as stated intent | The heart of the reframed IDRES; needs tickets | Task5 expansion | M–L |
| 5 | **PR intent summary from captured evidence** (IDRES 1): prompts, sessions and decisions → a short "why" on the PR | Matches the feature customers love most, from a source CodeRabbit lacks | Task5 + A15.14 check text | M |
| 6 | **Bot and cloud-agent attribution:** CodeRabbit's Coding Agent, Copilot agent, Dependabot and release bots as distinct authors | Otherwise AI-bot commits count as human | B18 (Task2) + Task13 cloud routes | S–M |
| 7 | **Session-finding → PR linkage:** show Task20 agent findings on the PR they produced | Security signal no code reviewer has | Task20 follow-on | S |
| 8 | **Scheduled delivery of signed period reports** (email, Slack) | Matches scheduled reports, but signed | Task15 / Task16 | S |
| 9 | **Starter mode without the endpoint:** GitHub App only (PR and merge evidence, review ingestion, policies), with the endpoint as the upgrade | Answers CodeRabbit's zero-setup advantage; a faster pilot start | Task8 onboarding | M |
| 10 | **Self-host or customer VPC at any seat count** | Wins the regulated mid-market CodeRabbit turns away below 500 seats | Task14 | L |

**Do not build:** AI line review, autofix, unit-test generation, finishing recipes, blast-radius maps, a PR triage queue, SAST and Deep Scan. They are crowded, commoditising and outside the CISO evidence story.

## 9. Signals to watch (Market Intel)
- CodeRabbit claims AI authorship or attribution beyond slop detection.
- CodeRabbit adds signed or attested review records, or SLSA/in-toto output.
- CodeRabbit adds a resident endpoint component (beyond the CLI and IDE extension).
- GitHub or GitLab bundle triage, explanation or review provenance natively (analysts see them as CodeRabbit's biggest threat).
- Acquisitions in the review category (Cursor bought Graphite in December 2025, the precedent).
- CodeRabbit pricing below $24 or a free tier for private repositories.

## Sources (checked 2026-11-04)
- CodeRabbit pricing: https://www.coderabbit.ai/pricing
- Series C press release (Agentic Change Management, 17,000+ customers): https://www.businesswire.com/news/home/20260812311754/en/CodeRabbit-Raises-$143-Million-at-$1.5-Billion-Valuation-and-Introduces-Agentic-Change-Management
- InfoWorld on Agentic Change Management, with analyst views: https://www.infoworld.com/article/4208611/coderabbit-targets-ai-generated-code-overload-with-agentic-change-management.html
- Google Cloud: how CodeRabbit built its review agent on Cloud Run: https://cloud.google.com/blog/products/ai-machine-learning/how-coderabbit-built-its-ai-code-review-agent-with-google-cloud-run
- CodeRabbit docs, used throughout: architecture (https://docs.coderabbit.ai/overview/architecture), self-hosted (https://docs.coderabbit.ai/self-hosted/overview), FAQ (https://docs.coderabbit.ai/faq.md), IDE privacy (https://docs.coderabbit.ai/ide/privacy.md), CLI agent mode (https://docs.coderabbit.ai/cli/agent-mode.md), Jamf (https://docs.coderabbit.ai/cli/jamf-managed-macos.md), slop detection (https://docs.coderabbit.ai/pr-reviews/slop-detection.md), automatic approvals (https://docs.coderabbit.ai/pr-reviews/automatic-approvals.md), merge risk (https://docs.coderabbit.ai/pr-reviews/merge-risk.md), pre-merge checks (https://docs.coderabbit.ai/pr-reviews/pre-merge-checks.md), post-merge actions (https://docs.coderabbit.ai/pr-reviews/post-merge-actions.md), learnings (https://docs.coderabbit.ai/knowledge-base/learnings.md), Triage (https://docs.coderabbit.ai/triage/prioritization.md), Change Stack (https://docs.coderabbit.ai/change-stack/index.md), Security (https://docs.coderabbit.ai/security/index.md), Plan (https://docs.coderabbit.ai/plan/index.md), coding environments (https://docs.coderabbit.ai/code/environments.md), dashboard metrics (https://docs.coderabbit.ai/guides/dashboard-metrics.md), audit logs (https://docs.coderabbit.ai/management/audit-logs.md), index (https://docs.coderabbit.ai/llms.txt), changelog (https://docs.coderabbit.ai/changelog)
- Kudelski Security, the 2025 RCE: https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories
- Techzine, $1M free scans and OpenAI Daybreak (2026-10-26): https://www.techzine.eu/news/security/145272/coderabbit-conducts-free-scans-and-joins-openai-initiative/
- G2 reviews: https://www.g2.com/products/coderabbit/reviews
- aicodereview.cc review (updated 2026-10-19): https://aicodereview.cc/blog/coderabbit-review
- Kunal Ganglani, 2026 comparison: https://www.kunalganglani.com/blog/ai-code-review-tools-2026-compared
- Airframe company profile: https://www.airframe.ai/product/coderabbit-ai/analysis
- Cursor acquires Graphite (2025-12-19): https://siliconangle.com/2025/12/19/cursor-acquires-ai-code-review-startup-graphite/
- ARR estimates (third party, unverified): https://clinkbill.com/arr-leaderboard/coderabbit, https://www.arr.club/coderabbit
