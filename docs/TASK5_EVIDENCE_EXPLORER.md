# Task 5 Evidence Explorer

Task 5 adds customer-facing evidence investigation without changing GitAI's
identity or metric meanings.

## Identity contract

- A commit is an independent Git outcome.
- A provider session may have zero, one, or many commits.
- A commit may contain attribution from many sessions, checkpoints, and traces.
- A GitAI checkpoint is an edit observation. It is not a customer work package.
- A prompt is a captured instruction. An intention is a separate explicit or
  inferred goal.
- `observed`, `inferred`, and `corrected` describe how a claim is known.
- `available`, `unavailable`, `redacted`, and `expired` describe whether its
  content can be retrieved.

Existing commit, session, checkpoint, range-attribution, and lifecycle tables
remain authoritative. Task 5 adds an evidence overlay and does not recalculate
Task 2 metrics.

## Fixed safety contract

- OpenCode is the only Task 5 raw-content provider.
- Collection is disabled until a tenant administrator opts in.
- Content and derived intentions expire after 30 days.
- Secret scanning runs before encryption and rejects raw payloads placed in
  metadata.
- Raw content is envelope-encrypted separately from event metadata.
- Only active tenant administrators and auditors can retrieve raw content.
- Every raw-content read and consent change creates a security audit event.
- API errors and logs contain no prompt, response, reasoning, tool argument, or
  tool result content.

Task 6 can add configurable policy but cannot weaken these defaults.

## OpenCode collector contract

The GitAI-side collector sends an idempotent batch to:

`POST /worker/evidence/opencode/batches`

It uses the existing managed machine credential headers. A managed machine must
also hold an active repository grant when `repositoryId` is provided.

```json
{
  "provider": "opencode",
  "batchId": "opaque-client-batch-id",
  "sourceVersion": "opencode/export-v1",
  "repositoryId": "tenant-repository-uuid",
  "externalSessionId": "provider-conversation-id",
  "gitAiSessionId": "s_...",
  "intention": "Optional explicitly supplied goal",
  "events": [
    {
      "providerEventId": "stable-provider-part-id",
      "type": "prompt",
      "occurredAt": "2026-09-19T10:00:00.000Z",
      "traceId": "t_...",
      "model": "provider-model-id",
      "toolName": null,
      "content": "raw value or JSON payload",
      "metadata": {
        "status": "completed",
        "durationMs": 1200,
        "attempt": 1
      }
    }
  ]
}
```

Supported event types are `prompt`, `reasoning`, `response`, `tool_call`, and
`tool_result`. Reasoning that OpenCode does not expose must be sent with null
content and is recorded as unavailable. Metadata accepts only bounded operational
signals: status, duration, attempt, error code, exit code, and abandoned state.

The TrackAI repository contains the authenticated server contract. Wiring the
export call into the separately maintained GitAI client release must use this
contract and must not read or print content outside the collector process.

## Customer APIs

- `GET /api/evidence/graph` traverses commits, sessions, GitAI checkpoints,
  traces, code ranges, provider events, and intentions.
- `GET /api/evidence/commits/:id/explain` returns intention, outcome, friction,
  learnings, open items, and the supporting graph.
- `GET /api/evidence/search?q=...` performs tenant-isolated hybrid intention
  retrieval over encrypted semantic material.
- `GET /api/evidence/analytics/friction` reports explainable workflow signals,
  including failures, retries, slow tools, prompt loops, abandoned work, weak
  outcomes, and Task 2 rework.
- `GET /api/evidence/events/:id/raw` is administrator/auditor-only and audited.

The dashboard Evidence Explorer provides a summary, supporting graph/timeline,
and explicit raw-content reveal. It never presents time proximity as observed
causality.

## Deferred boundaries

- GitHub Issue, Jira, and Linear work-item linkage remains T5.4/future scope.
- Providers other than OpenCode remain Task 13 scope.
- Design-system polish remains Task 10 scope.
- Customer evidence bundles, certification, and large export storage remain
  Tasks 12 and 14 scope.
