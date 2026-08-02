# Task13 — Agent and Surface Coverage

**Canonical agent/surface coverage tracker**

Last updated: **2026-08-02**

Lifecycle authority: [`Task2.md`](Task2.md)

Security and delivery authority: [`TASK4.md`](TASK4.md)

Portfolio roadmap: [`ROUGH_ROADMAP.md`](ROUGH_ROADMAP.md)

This tracker answers a narrower question than “does Git AI support this agent?”:

> Can TrackAI identify the exact agent, model, host surface and execution mode,
> and carry complete, non-duplicated evidence from generation through production?

The taxonomy is inspired by Numbat's
[`agent-coverage.md`](https://github.com/perplexityai/numbat/blob/main/docs/agent-coverage.md),
but TrackAI measures attribution and lifecycle evidence rather than synchronous
security enforcement. Vendor documentation and source code establish a
foundation; only TrackAI live acceptance turns a route green.

## Status and support contract

| Symbol | Meaning |
|---|---|
| 🟢 ✅ | Capability is implemented and live-verified in TrackAI for this exact route |
| 🟡 ◐ | Partial foundation, automated evidence only, development-only evidence or a provider gap |
| 🔴 ☐ | No trustworthy implementation or no validation |
| ⚪ — | No applicable product route is known |
| 🛠️ ☑ | Implementation work remains before full-route support |
| 🛠️ ☐ | No implementation gap is currently known |
| 🧪 ☑ | Live TrackAI validation remains |
| 🧪 ☐ | Required live validation passed |

A route is fully supported only when all of the following are captured and
validated together:

1. exact agent family and exact model;
2. exact host surface and execution mode;
3. Generated and Committed LoC;
4. prompts and agent responses;
5. tool calls and results;
6. provider token usage;
7. commit, PR, merge and production lifecycle;
8. tenant-safe, idempotent and deduplicated delivery.

If the provider does not expose one of these signals, the route remains partial.
TrackAI displays the missing value as `Unavailable`; it never estimates or
promotes a filesystem timing correlation to exact AI provenance.

## Identity model

Agent, model, surface and evidence channel are independent dimensions:

```text
agentFamily=antigravity
hostSurface=antigravity
hostMode=ide-agent
captureChannel=native-hook+watcher
model=<exact OpenAI, Anthropic or Google model>
```

An OpenAI model used through Antigravity is not Codex. A Claude model used in
Cursor is not Claude Code. Preserve the existing lifecycle key of
`tool + exact provider model`; host provenance is additional evidence and must
not transfer model ownership or duplicate a session.

Normalized host metadata is planned as:

| Field | Examples | Rule |
|---|---|---|
| `agentFamily` | `codex`, `claude-code`, `github-copilot`, `opencode` | The harness that performed the work, not the model vendor |
| `hostSurface` | `vscode`, `cursor`, `codex-desktop`, `terminal`, `cloud-runner` | Record only when the event or trusted runtime proves it |
| `hostMode` | `ide-agent`, `inline-completion`, `cli`, `desktop`, `background`, `gateway` | Distinguishes materially different capture paths |
| `captureChannel` | `native-hook`, `editor-extension`, `provider-plugin`, `transcript`, `otel`, `agent-v1`, `commit-fallback` | Multiple channels may contribute evidence but must deduplicate |
| `hostIdentityQuality` | `exact`, `inferred`, `unavailable` | Inference must never be presented as exact |

## Compact agent-by-surface summary

Each cell lists concrete route IDs. Status describes the **best current route
foundation**, not a blanket product claim.

| Agent family | IDE agent/chat | IDE inline/Tab | Local CLI/TUI | Desktop app | Remote IDE/container | Cloud/background | Gateway/custom |
|---|---|---|---|---|---|---|---|
| **GitHub Copilot** | 🟡 AC-IDE-01 | 🟡 AC-IDE-02 | 🟡 AC-CLI-04 | ⚪ — | 🟡 AC-IDE-10 | 🔴 AC-BG-04 | 🟡 AC-BG-06 |
| **Cursor** | 🟡 AC-IDE-06 | 🟡 AC-IDE-07 | 🟡 AC-CLI-06 | ⚪ — | 🟡 AC-IDE-10 | 🟡 AC-BG-03 | 🟡 AC-BG-06 |
| **Codex** | 🟡 AC-IDE-04 | ⚪ — | 🟡 AC-CLI-02 | 🟡 AC-DESK-01 | 🟡 AC-IDE-10 | 🟡 AC-BG-02 | 🟡 AC-BG-06/AC-BG-07 |
| **Claude Code** | 🟡 AC-IDE-03 | ⚪ — | 🟡 AC-CLI-01 | 🟡 AC-DESK-02 | 🟡 AC-IDE-10 | 🟡 AC-BG-01 | 🟡 AC-BG-06/AC-BG-07 |
| **Claude Desktop/Cowork** | ⚪ — | ⚪ — | ⚪ — | 🔴 AC-DESK-03 | ⚪ — | 🔴 AC-DESK-03 | 🟡 AC-BG-07 |
| **OpenCode** | 🟡 AC-IDE-05 | ⚪ — | 🟡 AC-CLI-03 | 🟡 AC-DESK-04 | 🟡 AC-IDE-10 | 🔴 AC-BG-05 | 🟡 AC-BG-06/AC-BG-07 |
| **Antigravity** | 🟡 AC-IDE-08 | ⚪ — | 🟡 AC-CLI-07 | 🟡 AC-DESK-05 | 🔴 AC-IDE-10 | 🔴 AC-BG-05 | 🟡 AC-BG-07 |
| **Gemini CLI** | ⚪ — | ⚪ — | 🟡 AC-CLI-05 | ⚪ — | 🟡 AC-IDE-10 | 🔴 AC-BG-05 | 🟡 AC-BG-06/AC-BG-07 |
| **Generic Git AI integration** | ⚪ — | ⚪ — | ⚪ — | ⚪ — | 🟡 AC-IDE-10 | 🟡 AC-BG-06 | 🟡 AC-BG-07 |

## Concrete route catalog

Capability columns use `G/C` for Generated/Committed, `P/R` for
prompt/response, `Tools` for tool calls/results and `Tok` for tokens.
“Lifecycle” includes local commit, push, PR, merge and production propagation.

### Local IDE and completion routes

| Route | Agent family | Surface / mode | Capture channel | Host identity | G/C | P/R | Tools | Tok | Lifecycle | Needs implementation | Needs validation | Platforms | Current evidence / limitation |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| **AC-IDE-01** | GitHub Copilot | VS Code Agent/Chat | Native Copilot/VS Code hooks, extension and OTEL/trace evidence | 🟢 | 🟢 | 🟡 | 🟡 | 🟡 | 🟢 | 🛠️ ☑ | 🧪 ☑ | macOS tested; Linux/Windows pending | E3/E15 verified lifecycle and accepted/discarded edits. T2.11e remains for token-bearing spans after conversation/model changes; production raw evidence is not complete. |
| **AC-IDE-02** | GitHub Copilot | VS Code inline completion | Shared VS Code extension and `ai_tab` pre/post edit checkpoints | 🟢 | 🟡 | 🔴 | 🔴 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Experimental implementation exists; the lifecycle lab did not isolate inline completion from Agent/Chat. |
| **AC-IDE-03** | Claude Code | VS Code extension / IDE mode | Claude Code native hooks plus `.claude` transcripts | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Git AI supports Claude Code, but TrackAI has not proven IDE-host identity or full evidence for this route. |
| **AC-IDE-04** | Codex | VS Code extension / IDE mode | Codex hooks plus `$CODEX_HOME` rollouts | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Codex support exists, but current tool identity does not distinguish IDE, CLI and desktop hosts. |
| **AC-IDE-05** | OpenCode | VS Code-hosted workflow | OpenCode plugin, SQLite/transcript evidence and checkpoints | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS tested indirectly | OpenCode local lifecycle is verified through its terminal/TUI path; a distinct VS Code-hosted route is unproven. |
| **AC-IDE-06** | Cursor | Cursor local Agent | Cursor pre/post tool hooks, JSONL reader and shared editor extension | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Substantial Git AI support exists, including Windows path normalization. No TrackAI lifecycle acceptance has run. |
| **AC-IDE-07** | Cursor | Cursor Tab | Shared editor extension and `ai_tab` checkpoints | 🟢 | 🟡 | 🔴 | 🔴 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Git AI advertises beta Tab support; completion-specific prompt/token fidelity and lifecycle validation remain. |
| **AC-IDE-08** | Antigravity | Antigravity IDE agent | TrackAI Git AI patch: host detector, watcher, checkpoint preset and transcript metadata | 🟢 | 🟢 | 🔴 | 🟡 | 🔴 | 🟢 | 🛠️ ☑ | 🧪 ☑ | macOS tested | E13c verified Gemini, Claude and GPT-family model attribution. Tokens and prompt/response evidence remain unavailable. |
| **AC-IDE-09** | Xcode/unknown assistant | Xcode editor and hosted assistants | No shipped adapter; design-only FSEvents watcher | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🛠️ ☑ | 🧪 ☑ | macOS only | A filesystem watcher can observe saves or KnownHuman evidence but cannot prove AI authorship without an assistant event source. |
| **AC-IDE-10** | Multiple | VS Code Remote, SSH, Dev Container and Codespaces | Remote extension host plus agent-native hooks in the filesystem/Git environment | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Remote Linux common; other hosts pending | Git AI documents devcontainer extension configuration and handles remote buffer lag, but TrackAI has not run a remote-host conformance test. |

### Local CLI and TUI routes

| Route | Agent family | Surface / mode | Capture channel | Host identity | G/C | P/R | Tools | Tok | Lifecycle | Needs implementation | Needs validation | Platforms | Current evidence / limitation |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| **AC-CLI-01** | Claude Code | Terminal CLI | Native Claude Code hooks plus `.claude/projects` transcript reader | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Git AI source and focused regressions cover Claude, but no complete TrackAI live route has run. |
| **AC-CLI-02** | Codex | Terminal CLI | Codex hooks plus `$CODEX_HOME/{sessions,archived_sessions}` | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Native hook and rollout support exists; E13b remains unexecuted as a standalone Codex route. |
| **AC-CLI-03** | OpenCode | Terminal/TUI | OpenCode plugin, checkpoints, SQLite and transcript/usage reader | 🟢 | 🟢 | 🟡 | 🟡 | 🟢 | 🟢 | 🛠️ ☑ | 🧪 ☑ | macOS live-tested; Linux/Windows pending | E1/E2/E13a/E15 verified lifecycle, model switching and tokens. Prompt-to-commit flow is development-only; production raw evidence remains Task4/Task5-gated. |
| **AC-CLI-04** | GitHub Copilot | Copilot CLI | Copilot CLI hook installer and session-event reader | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Source support exists but TrackAI has not run this route. Do not infer results from VS Code Copilot. |
| **AC-CLI-05** | Gemini CLI | Terminal CLI | Gemini native hooks plus transcript reader | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Registered installer, preset and stream agent exist; no TrackAI live acceptance. |
| **AC-CLI-06** | Cursor | Cursor CLI | Cursor native hooks and Cursor transcript reader | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS/Linux/Windows intended | Git AI advertises Cursor CLI support, but host-mode identity and TrackAI lifecycle evidence are unverified. |
| **AC-CLI-07** | Antigravity | Antigravity CLI | Antigravity hooks/transcript locations where exposed | 🟡 | 🟡 | 🔴 | 🟡 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | macOS first | The IDE adapter cannot be assumed to cover CLI behavior; fixtures and a separate host signal are required. |

### Desktop application routes

| Route | Agent family | Surface / mode | Capture channel | Host identity | G/C | P/R | Tools | Tok | Lifecycle | Needs implementation | Needs validation | Platforms | Current evidence / limitation |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| **AC-DESK-01** | Codex | Codex desktop app | Potentially shared Codex hooks and `$CODEX_HOME` rollouts | 🔴 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Supported desktop OSes | Git AI can recognize Codex sessions but has not proven that the desktop app fires the same hook contract or supplied exact `hostSurface`. |
| **AC-DESK-02** | Claude Code | Claude Code desktop mode | Potentially shared `.claude/settings.json` hooks and transcripts | 🔴 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Supported desktop OSes | Treat separately from Claude Code CLI and from general Claude Desktop. Exact host evidence remains. |
| **AC-DESK-03** | Claude Desktop/Cowork | Claude Desktop, Cowork or MCP-driven file edits | No explicit Git AI desktop adapter | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🛠️ ☑ | 🧪 ☑ | macOS first; other hosts later | Claude Code support is not Claude Desktop support. Evaluate a mutation-aware MCP adapter or provider event source; otherwise retain Unknown. |
| **AC-DESK-04** | OpenCode | OpenCode desktop | Potentially shared plugin and `opencode.db` | 🔴 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Supported desktop OSes | Determine whether the desktop process loads the same plugin/config root and emits identical session IDs. |
| **AC-DESK-05** | Antigravity | Antigravity desktop | Current Antigravity checkpoint adapter | 🟡 | 🟢 | 🔴 | 🟡 | 🔴 | 🟢 | 🛠️ ☑ | 🧪 ☑ | macOS live-tested | Current E13 evidence proves the application route at attribution level, not full prompt/token evidence or portable host identity. |

### Cloud, background and gateway routes

| Route | Agent family | Surface / mode | Capture channel | Host identity | G/C | P/R | Tools | Tok | Lifecycle | Needs implementation | Needs validation | Platforms | Current evidence / limitation |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| **AC-BG-01** | Claude Code | Claude Code Web/remote | Repository SessionStart bootstrap plus normal Claude hooks | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Cloud Linux | Git AI documents that the remote host supports normal hooks. TrackAI must verify ephemeral installation, secret injection and complete delivery. |
| **AC-BG-02** | Codex | Codex Cloud | No-hook background detection and post-commit hole attribution | 🟢 | 🟡 | 🔴 | 🔴 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Cloud | Git AI explicitly documents attribution only; prompts, tokens and tools are Coming Soon. Commit fallback cannot satisfy full Generated LoC. |
| **AC-BG-03** | Cursor | Cursor Background Agent | Repository `.cursor` hooks plus environment bootstrap | 🟢 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Cloud Linux | Git AI claims attribution, prompts, tokens and tools. User-level hooks do not load in cloud, so repository wiring and TrackAI E2E validation are mandatory. |
| **AC-BG-04** | GitHub Copilot | GitHub Copilot Coding Agent | No explicit full-evidence TrackAI route identified | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🛠️ ☑ | 🧪 ☑ | GitHub-hosted | Do not infer coverage from Copilot CLI or VS Code hooks. Identify supported bootstrap, artifacts and lifecycle signals first. |
| **AC-BG-05** | OpenCode/Antigravity/Gemini | Headless, server or unclassified remote runner | No route-specific contract | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🛠️ ☑ | 🧪 ☑ | Cloud/self-hosted | Add concrete rows only when a stable host hook, plugin or artifact contract is identified. |
| **AC-BG-06** | Generic background agent | `CLOUD_AGENT_*`, `GIT_AI_CLOUD_AGENT` or detected runner | Post-commit unattributed-line fallback | 🟡 | 🔴 | 🔴 | 🔴 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Cloud Linux primarily | Automated tests prove committed-hole attribution while preserving explicit human/AI evidence. It is intentionally insufficient for full support. |
| **AC-BG-07** | Custom agent/gateway | Local or remote Agent V1 integration | Structured `agent-v1` pre/post edit and shell checkpoints | 🟡 | 🟡 | 🔴 | 🟡 | 🔴 | 🟡 | 🛠️ ☑ | 🧪 ☑ | Cross-platform by adapter | A useful normalization contract exists, but lacks a full prompt/response/token envelope, host identity and TrackAI conformance suite. |

## Workstream tracker

| ID | Workstream | Implemented | Tested & verified | Dependencies | Outcome / next action |
|---|---|---:|---:|---|---|
| **T13.1** | Canonical taxonomy, route IDs and coverage matrix | 🟢 ✅ | 🟡 ◐ | Task2 | This document establishes the first registry from Git AI source, vendor docs and TrackAI experiments. Re-audit on every supported-agent release. |
| **T13.2** | Normalized host and capture provenance contract | 🔴 ☐ | 🔴 ☐ | Task2 schema; Task4 ingestion | Add `agentFamily`, `hostSurface`, `hostMode`, `captureChannel` and host-identity quality without changing model ownership. |
| **T13.3** | Local IDE agent/chat and inline-completion coverage | 🟡 ◐ | 🟡 ◐ | T13.2; Task5 raw evidence | VS Code Copilot and Antigravity have partial live evidence; Cursor and remaining IDE routes require conformance. |
| **T13.4** | Local CLI/TUI coverage | 🟡 ◐ | 🟡 ◐ | T13.2 | OpenCode is strongest; Codex, Claude Code, Copilot CLI, Gemini, Cursor and Antigravity CLI remain. |
| **T13.5** | Desktop application coverage | 🔴 ☐ | 🔴 ☐ | T13.2; Task4/5 privacy | Prove shared hooks where applicable and build missing Claude Desktop/MCP attribution. |
| **T13.6** | Remote IDE, cloud and background coverage | 🟡 ◐ | 🔴 ☐ | Task4 delivery/enrollment | Start with Cursor Background and Claude Web; retain Codex Cloud as partial until upstream evidence expands. |
| **T13.7** | Generic gateway and Agent V1 integration | 🟡 ◐ | 🔴 ☐ | Task4 transport; Task5 evidence | Extend Agent V1 to carry host, prompt/response/tool/token evidence and validate tenant-safe delivery. |
| **T13.8** | macOS/Linux/native-Windows/WSL portability | 🟡 ◐ | 🔴 ☐ | Task4; Task9 | Git AI has platform foundations; run identical route fixtures on every supported client OS. |
| **T13.9** | Reusable route-conformance harness | 🔴 ☐ | 🔴 ☐ | Task2 fixtures; T13.2 | Parameterize the same lifecycle/evidence assertions by route and platform. |
| **T13.10** | Coverage health, docs and customer verification | 🔴 ☐ | 🔴 ☐ | T13.1–T13.9; Task8/12 | Expose honest installed/wired/observed/complete states and customer-repeatable checks. |

## Route conformance contract

Every applicable route must run the same controlled fixture:

1. install and verify hooks/plugins in the actual host;
2. generate, replace and discard code;
3. create, edit, rename and delete files;
4. include a manual human-edit negative control;
5. switch models where the host supports it;
6. commit locally before push;
7. push and open or update a PR;
8. verify Generated, Committed, In-PR, Reworked and Final AI;
9. inspect prompt, response and tool-call ordering;
10. reconcile provider token totals without replay inflation;
11. confirm hook, transcript, extension and OTLP evidence does not duplicate;
12. verify enrolled-repository and tenant isolation;
13. repeat the small fixture on every supported operating system.

Background-agent acceptance additionally verifies ephemeral installation,
repository-level hook loading, secret injection, delayed upload and the visible
difference between full hook evidence and commit-only fallback.

## Dependencies and ownership

| Program | Responsibility |
|---|---|
| **Task13** | Surface taxonomy, adapters, capture fidelity and route coverage status |
| **Task2 Lifecycle Lab** | Independent metric and lifecycle acceptance for every route |
| **Task4** | Secure queueing, repository enrollment, keys, idempotency and cloud delivery |
| **Task5** | Production prompt/response/tool evidence, authorization, encryption, retention and UX |
| **Task9** | Managed packages, configuration and cross-platform fleet rollout |
| **Task12** | Customer-facing coverage claims and reproducible verification |

Task13 does not block Task4. Task4 must keep its contracts host- and
OS-neutral so later routes do not require weakening tenant, repository or key
boundaries.

## Research sources and evidence precedence

1. TrackAI controlled live acceptance and stored evidence.
2. Focused Git AI source/tests on the maintained Task2 fork.
3. Git AI agent documentation, including
   [Codex](https://usegitai.com/docs/agents/codex),
   [Claude Code](https://usegitai.com/docs/agents/claude-code),
   [Cursor](https://usegitai.com/docs/agents/cursor),
   [OpenCode](https://usegitai.com/docs/agents/opencode),
   [Gemini CLI](https://usegitai.com/docs/agents/gemini-cli),
   [Claude Code Web](https://usegitai.com/docs/cli/claude-web),
   [Codex Cloud](https://usegitai.com/docs/agents/codex-cloud) and
   [Cursor Background Agent](https://usegitai.com/docs/agents/cursor-agent).
4. Numbat's
   [`agent-coverage.md`](https://github.com/perplexityai/numbat/blob/main/docs/agent-coverage.md)
   surface taxonomy and stated host limits.

Documentation claims never override contradictory live evidence. An upstream
path, directory or marketing-level “supported” label is not sufficient without
a stable schema or representative fixture.

## Explicitly deferred agents

Windsurf, OpenClaw, Kilo Code, Cline, Kiro, Pi, Amp, Droid, Devin and other
agents catalogued by Git AI or Numbat are intentionally outside the initial
Task13 route registry. Add them only through a new stable route ID and the same
full-evidence support bar; do not infer them from shared directories or models.
