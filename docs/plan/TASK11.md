# Task11 — Public API, SDK and Integration Platform (deferred)

*Status: ⚪ deferred until a customer asks (founder decision 2026-10-12). Not deleted: this file records why, what would trigger it, and what other Tasks carry meanwhile.*

## Original intent (July/August 2026)
Something like Git AI's SDK/API (https://usegitai.com/docs/sdk-api): for teams that build their own dashboards instead of the enterprise one, query and process raw data, or run without the enterprise product. Roadmap workstreams T11.1–T11.8 (resource model, OpenAPI, TypeScript/Python SDKs, CLI, callbacks, pagination/quotas/errors, examples).

## Why it is deferred (evidence, 2026-10-12)
- **No Task needs a public, versioned contract.** The console uses internal `/api` routes (Supabase JWT); GitAI uses machine-only `/worker` routes. Both are internal and may change freely.
- **Task15 Attesta** reaches outsiders through evidence packs and the standalone verifier (an acquirer's counsel runs the verifier on a file; no API). Its routes are internal and auditor-readable.
- **Task16 Audit** is served by the console and signed exports; SIEM delivery was already parked here (TASK16 D3).
- The remaining roadmap links were wording, not dependencies: "stabilize public contracts before Task11", the old Task11 → Task12 edge, and Task10's references to "Task11 conventions" for paging and errors. The 2026-10-12 graph removes them.
- TrackAI's buyer is the CISO, who wants answers and evidence, not raw data to build dashboards from; the original Git AI SDK use case is not TrackAI's market.

## Triggers that bring it back (any one)
1. A customer wants audit events or security findings in their SIEM (Splunk, Sentinel); the most likely trigger.
2. A customer wants CI to block PRs without attestation via their own tooling (a GitHub check posted by TrackAI's server covers the first version without an API: Task15 A15.14).
3. A procurement or security questionnaire requires an API for data export.
4. Attesta phase 2 insurer or M&A data feeds.
5. A customer insists on building their own dashboards from raw data.

## Carried forward now, by other Tasks
1. **API conventions on every new route** (SushiCorp catalog AP-1): RFC 7807 problem responses, cursor (keyset) paging, request IDs. Rule in AGENTS.md §10; Task15 and Task16 apply it first. A later public API then mostly chooses which routes to expose.
2. **The token gap is recorded, not built:** `/api` accepts only signed-in users and machine credentials work only on `/worker`, so no customer script can call TrackAI today. Read-only, tenant-scoped API tokens for customer automation are **T11.0**, the first piece when a trigger fires (`docs/plan/BUG_BACKLOG.md` B17). Task16's auditor rules must not assume a human session is always present.

## When triggered
Start with T11.0 plus the read endpoints the trigger needs (for example audit and findings for SIEM), on the AP-1 conventions already in use; generate OpenAPI from those routes; SDKs only when a second consumer exists.
