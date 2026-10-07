# TrackAI bug and gap backlog

Problems found outside a session's own scope. Each is fixed later by the Task that built the code, at a time the founder chooses (founder decision 2026-10-08); nobody fixes these on the side. Add rows as you find them, with evidence; strike them through with the fixing PR when done. Sizes: S ≤ 0.05× T6, M ≈ 0.1–0.2×, L ≥ 0.3×.

| # | Found | Problem (evidence) | Owner Task | Size | Status |
|---|---|---|---|---|---|
| B1 | 2026-10-07 orchestrator | Churned is not computed: `churned` is declared and read (`features/telemetry/lifecycle.ts:8,133`) but no production write, projection or rebuild path emits that stage, so Churned is always Unavailable unless fixture rows are injected (confirmed by Codex review 2026-10-08) | Task2 | M-L | ⬜ |
| B2 | 2026-10-07 orchestrator | Dashboard reloads all rows of 19 tables per request and polls about 12 endpoints every 15 s (`features/telemetry/read.routes.ts:85-117`, `dashboard/page.tsx:778-825`); will not scale | Task2 (read path), Task10 (polling) | L | ⬜ |
| B3 | 2026-10-07 orchestrator | Security monitoring can only be turned on by SQL seed: no admin API or UI writes `tenant_security_monitor_settings` (`features/security-findings/task6-acceptance-seed.ts:74-79`) | Task6.a | M | ⬜ |
| B4 | 2026-10-07 orchestrator | `dashboard/page.tsx` is 885 lines / 109 KB with one 415-line admin component; primitives duplicated across files | Task10 | L | ⬜ |
| B5 | 2026-10-07 orchestrator | Migration 0000 creates Supabase `authenticated` SELECT policies keyed on the email domain for 11 Task1-era tables; check whether they exist on the live project | Task4 | S | ⬜ |
| B6 | 2026-10-07 orchestrator | Task1/Task2 tables have no composite `(tenant_id, id)` foreign keys (migrations 0000–0002) | Task4 | M | ⬜ |
| B7 | 2026-10-07 orchestrator | JWT verification pins no issuer or audience (`core/middleware/auth.ts:46`); tenant comes from the email domain | Task4 now, Task8 for SSO | S / L | ⬜ |
| B8 | 2026-10-07 orchestrator | Ingestion normalizes synchronously outside one transaction; stranded `pending` rows need a manual reconcile; event fingerprint uses key-order-dependent `JSON.stringify` (`features/telemetry/service.ts:155,1424-1496`) | Task4 (transport) with Task2 sign-off | M | ⬜ |
| B9 | 2026-10-07 orchestrator | Legacy static ingest token still live and trusts a client-supplied machine ID (`core/middleware/machine-auth.ts:72-105`) | Task4 | S-M | ⬜ |
| B10 | 2026-10-07 orchestrator | One global GitHub webhook secret; tenant resolved by org-name string, not installation ID (`features/scm/scm.routes.ts:112-186`) | Task4 / Task7 | M | ⬜ |
| B11 | 2026-10-07 orchestrator | Raw ingest payloads and webhook bodies stored as plaintext jsonb (`telemetry_ingest_batches.payload`, `provider_event_deliveries.raw_event`) | Task4 | M | ⬜ |
| B12 | 2026-10-07 orchestrator | Global error handler returns `err.message` to clients (`apps/api/src/index.ts:77-90`) | Task4 | S | assigned to dry run `dryrun-api-hygiene` |
| B13 | 2026-10-07 orchestrator | `/worker/evidence` runs machine authentication twice because `/worker` is mounted first (`apps/api/src/index.ts:52-54`) | Task4 | S | assigned to dry run `dryrun-api-hygiene` |
| B14 | 2026-10-07 orchestrator | Orphaned `'evidence'` view and `EvidenceExplorer`/"Deferred raw analytics" placeholders in `dashboard/page.tsx` (`:32,152-276,304,869`; nothing sets the view) | Task5 | S | assigned to dry run `dryrun-web-dead-view` |
| B15 | 2026-10-07 orchestrator | `AGENT_COVERAGE.md` (Task13) last updated 2026-08-02 | Task13 | S | ⬜ |
| B16 | 2026-10-07 orchestrator | About 45 `task4-wave*` live-verify scripts live inside `src/features` beside product code; no linter for `apps/api` | Task4 | M, S | ⬜ |
