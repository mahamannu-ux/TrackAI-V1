# Git AI OSS Changes Maintained by TrackAI

This is the human-readable record of the Git AI OSS changes developed and
verified during TrackAI Task2. Update this file whenever the patched Git AI
branch changes; source code and tests remain the final authority.

## Checkpoint and baseline

| Item | Value |
|---|---|
| Upstream baseline | `git-ai-project/git-ai` · `6ab2adbb2` · version 1.6.16 |
| TrackAI fork | `https://github.com/mahamannu-ux/git-ai.git` |
| Maintained branch | `feature/task2-lifecycle-metrics` |
| Task2 checkpoint | `a77081cba79c836472f6e00facf7eed6f432ed99` |
| Local source | `/Users/manishmahajan/Documents/Codex/2026-07-21/hi/outputs/Task2/git-ai-task2` |
| Operating guide | `GIT_AI_TASK2_COMMANDS.md` in the Git AI fork |

The checkpoint contains two commits: `294deebe3` for model/OpenCode usage
correction and `a77081cba` for the remaining Task2 lifecycle and agent support.
It is not merged into upstream Git AI.

## Human-readable change inventory

| Area | What changed | Why it matters | Verified outcome / boundary |
|---|---|---|---|
| Model-aware attribution | Internal attribution session IDs now include `tool + external conversation + exact model`. A real model switch no longer overwrites the previous model’s lines. A provisional `unknown` model is collapsed into a later single known model for the same conversation, while known-model-to-known-model switches remain separate. | Enables trustworthy lifecycle totals by model without showing duplicate customer conversations. | OpenCode DeepSeek/Nemotron switching and focused model-ID/Claude regressions pass. |
| OpenCode model selection | SQLite model discovery orders messages by their latest update rather than taking an arbitrary matching row. | Prevents a stale model label after an in-session model switch. | Live E13a model labels matched the actual edits. |
| OpenCode token decoding | Usage aggregation understands OpenCode’s nested `message.data`, `tokens.input/output`, and nested cache read/write fields. It deduplicates streaming updates by message and uses the largest final counters. | Makes provider-supplied token evidence visible instead of incorrectly showing zero. | Live OpenCode sessions showed tokens; broad historical replay remains a Task4 watermark concern. |
| Provider stream identity | Non-shared provider streams retain the external provider session ID instead of substituting an internal stream identifier. | Allows later usage, session and commit evidence to join to the same conversation. | Focused provider-reader and live correlation checks pass. |
| GitHub Copilot edit reconstruction | The VS Code adapter reconstructs proposed replace/create-file content, including multi-file edits and files created before the Keep/Discard decision. KnownHuman capture avoids stealing accepted Copilot lines. | Kept AI proposals remain AI; discarded proposals contribute gross Generated LoC without becoming retained code. | E15 verified multi-file Keep, full Discard and kept create-file behavior. Partial per-hunk acceptance remains an advanced compatibility case. |
| Copilot usage boundary | Copilot trace/session capture remains supported, but conversations that emit no token-bearing span stay `Unavailable`. | Avoids inventing token counts from chat UI totals or unrelated cumulative data. | T2.11e remains open for late correlation across model/conversation changes. |
| Antigravity support | Added host detection, a watcher/edit detector and an Antigravity checkpoint preset carrying conversation, model, trace, dirty-file and transcript metadata. | Allows Git AI attribution inside Antigravity rather than treating its edits as human/unknown. | Live Gemini, Claude and GPT-family attribution passed. Current Antigravity evidence exposes no reliable tokens or raw prompt/response stream. |
| KnownHuman status | The VS Code manager records manual additions and deletions as KnownHuman, and `git-ai status` gives durable human ranges precedence over Unknown. | Manual edits no longer appear as unknown or AI simply because they happened beside agent edits. | Focused tests plus live addition/deletion checks produced zero Unknown additions and `is_human: true`. |
| Deletion provenance | Checkpoint metrics now carry AI-authored, human-authored and unknown deleted-line counts. Snapshot diffing also detects files deleted by a tool, including watermark-covered paths. | Enables actor-specific Reworked metrics and deletion-only lifecycle evidence. | AI and human deletion experiments reconciled; a provider that emits no edit checkpoint remains an evidence limitation. |
| Rewrite and revert telemetry | The daemon treats `git revert` as a write operation, recovers canonical reverted SHAs, emits rewrite metrics for deletion-only reverts, preserves parent diffs and avoids incorrectly superseding the original commit. | Revert history stays immutable and TrackAI can reduce current Final AI without counting restored/deleted code as new generation. | Automated fixtures and live E12c passed. |
| Rewrite delivery barrier | Rewrite metric producers are tracked so tests can prove persistence and delivery rather than only command completion. | Reduces races where a successful Git command finishes before its lifecycle event reaches the durable queue. | Focused revert persistence regression passes; Task4 still owns the complete offline/crash/`await` contract. |
| Compatibility recovery | Session-attribution recovery tests now use model-aware IDs. Unknown-to-known refinement fixes the Claude empty-transcript race without collapsing genuine model switches. | Keeps older recovery paths compatible with the new model identity contract. | Eight metadata-recovery and two Claude latest-checkpoint tests pass. |
| Developer operations | Added `GIT_AI_TASK2_COMMANDS.md` covering build/install, daemon control, controlled repository configuration, SQLite diagnostics and safe teardown. | Prevents experiments from accidentally using the wrong binary, repository, tenant key or historical metrics. | Used throughout the live Task2 lab. |

## Event contract used by TrackAI

| Kind | Meaning used by the integration |
|---:|---|
| 1 | Commit observation |
| 2 | Agent/session marker |
| 4 | Checkpoint and line-attribution evidence |
| 5 | Provider transcript/session usage evidence, especially OpenCode |
| 6 | Trace/tool activity, especially VS Code GitHub Copilot |
| 7 | Commit rewrite/revert evidence |

Fields are sparse and versioned. TrackAI must tolerate missing fields and retain
`Unavailable`; Git AI changes must not silently renumber or reinterpret an
existing field.

## Known open boundaries

- Copilot may emit no token-bearing span after a conversation/model restart.
- Antigravity currently provides model/edit evidence but not reliable token or
  raw prompt/response evidence.
- A provider/editor that emits no checkpoint for a deletion cannot support
  precise deletion attribution.
- Durable per-repository tenant binding, offline crash recovery, quarantine,
  enrollment watermarks and controlled backfill belong to Task4.
- Upstream Git AI compatibility comparison remains T2.14; do not assume a later
  upstream release contains these patches.

## Agent surface compatibility audit

This section records the initial Git AI code audit only. The canonical,
continuously updated implementation and live-validation status now lives in
[`../AGENT_COVERAGE.md`](../AGENT_COVERAGE.md). Task13 owns adapters and route
status; the Task2 Lifecycle Lab owns independent acceptance.

The **host surface**, **agent/model** and **capture channel** are separate facts.
For example, `Codex desktop` is a host, `codex + model` is an agent identity, and
a tool hook or transcript reader is the evidence channel. TrackAI must not infer
the host merely because it recognizes the model or sees a filesystem change.

| Surface | Current Git AI foundation | Initial conclusion | Deferred acceptance |
|---|---|---|---|
| Cursor IDE | Dedicated Cursor pre/post tool hooks, model/session parsing, JSONL reader, Windows path normalization and shared VS Code/Cursor extension | Substantial implementation already exists; likely the shortest path to another green integration, but not yet live-tested by TrackAI | AC-IDE-06/07; T2.25/E21 |
| Xcode IDE | A detailed FSEvents watcher proposal exists; no shipped `agent-support/xcode` code or installer exists | Unsupported today. A file watcher can observe saves but cannot prove which AI assistant authored them | AC-IDE-09; T2.26/E22 |
| Codex desktop app | Codex hook installer supports `~/.codex/config.toml` or `hooks.json`; rollout JSONL discovery and Codex checkpoint parsing exist | Codex-agent support exists, but exact desktop-host identity is unproven and currently collapses to tool `codex` | AC-DESK-01; T2.27/E23 |
| Claude Desktop | Claude Code hooks and `.claude/projects` transcript discovery exist | Claude Code support must not be advertised as Claude Desktop support. No desktop-specific adapter was found | AC-DESK-03; T2.28/E24 |
| Linux / native Windows / WSL | Cross-platform binary/install code, platform keyrings/process handling and several Windows-specific tests exist | Designed for portability, but our live evidence is macOS-only | T13.8; T2.29/E25 |

Exact attribution rule: if a surface cannot emit a trustworthy session/tool
mutation event, preserve the change as Human or Unknown according to available
evidence. Never promote a filesystem timing correlation to exact AI provenance.

## Ongoing update rule

For every later Git AI patch, add one row above containing the behavior, reason,
tests/live evidence and remaining limitation. Record the new fork commit in the
Task tracker and cross-task handoff. Never copy provider transcripts, API keys,
private keys, local databases or customer raw content into this document.
