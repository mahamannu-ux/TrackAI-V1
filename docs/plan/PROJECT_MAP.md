# TrackAI project map

*Written 2026-10-07 by TrackAI-Orchestrator from `main` @ `336b337` (TrackAI) and the fork's `main` @ `d26da8e` (GitAI), for orienting agents. The code wins where this map disagrees; fix the map in the same PR. Reuse classification is in `REUSE_MAP.md`; the founder's vision in `docs/founder/VISION.md`.*

## 1. The system in one picture

```text
Developer machine                                   TrackAI server (apps/api, Express)          Console (apps/web, Next.js)
─────────────────                                   ─────────────────────────────────           ──────────────────────────
Agent (OpenCode, Claude Code, Cursor, Copilot…)
  └─ hook → git-ai checkpoint ─┐
git (Trace2 events) ─────────► GitAI daemon (Rust fork)
                                 • attribution → Git Note refs/notes/ai (authorship/3.0.0)
                                 • metrics queue (SQLite v9, bound to tenant/repo/key at enqueue)
                                 • security evaluator (3 rules, monitor-only)
                                 • evidence sync CLI (OpenCode DB, Task5)
                                 └─ X-API-Key trk_v1 ──► /worker/metrics/upload ─► telemetry_ingest_batches,
                                                         /worker/delivery-health    telemetry_metric_events (immutable)
                                                         /worker/evidence/…         → normalize (sync, in request)
                                                         /worker/security/…         → scm_*, ai_*, lifecycle events
GitHub ── webhook (HMAC) ─────────────────────────────► /api/v1/webhooks/github ─► provider_event_deliveries (ledger)
                                                                                    → PR/merge/deploy projections
Supabase Auth (browser) ── JWT ───────────────────────► /api/* (JWKS + tenant by email domain) ◄── 15 s polling dashboard
                                                         /api/admin/* (tenant_admin / tenant_auditor)    Admin panel (incl. audit)
```

Two repos (AGENTS.md header): TrackAI and the GitAI fork. GitAI writes attribution locally (Git Notes) and uploads normalized metric events; TrackAI joins them with SCM evidence into lifecycle metrics.

## 2. What each part does

| Part | What it does | Main paths |
|---|---|---|
| GitAI fork | Upstream Git AI (checkpoints, notes, Trace2 daemon, agent presets) plus: Task2 metric fields and revert/rewrite metrics; Task4 bound delivery (policy + keyring files, SQLite v9, quarantine, backfill); Task5 OpenCode evidence sync; Task6 evaluator, activation lease, findings queue | `src/metrics/{delivery,db}.rs`, `src/daemon/telemetry_worker.rs`, `src/evidence.rs`, `src/security/` |
| Ingestion | Machine-authenticated uploads; repository/branch/watermark policy with partial ack; dedup by payload hash; synchronous normalization | `features/telemetry/{ingest.routes,service,repository-enforcement,watermark-policy}.ts`, `core/middleware/machine-auth.ts` |
| SCM | GitHub webhooks (one global HMAC secret, tenant by org name), idempotent delivery ledger and ordered projections, GitHub App reads | `features/scm/` |
| Lifecycle (Task2) | Generated → committed → in PR → merged → production, reworked, churned; corrections as audited overlays | `features/telemetry/{lifecycle,audit,pr-matching,read.routes}.ts` |
| Platform (Task4) | Machine credentials, enrollment/grants/backfill, envelope encryption + master keyring, GitHub App credential rotation, admin/auditor memberships, audit log, retention/export/monitoring | `core/security/`, `core/operations/`, `features/admin/`, `features/operations/` |
| Evidence (Task5) | Consent-gated OpenCode evidence: encrypted content, redaction, graph, "why does this line exist", search (exact + full-text + pgvector, pinned bge-small), friction analytics, raw reveal, 30-day expiry | `features/evidence/`, `apps/api/scripts/` |
| Security (Task6.a) | Finding upload, unsigned activation lease, immutable findings, audited admin/auditor reads | `features/security-findings/` |
| Console | One client-side page with views (lifecycle, sessions, commits, PRs, repos, contributors, evidence workspace, administration); admin panel holds machines/keys, grants, backfill, GitHub App, operations, findings and audit | `apps/web/src/app/dashboard/{page,evidence-workspace}.tsx`, `apps/web/src/lib/api.ts` |

## 3. Data model at a glance (`apps/api/src/core/db/schema.ts`, migrations 0000–0013)

```text
Tenancy/identity  sso_tenants (domain, scmOrgIdentifier) · tenant_admin_memberships (admin|auditor) · tenant_identity_links · scm_provider_identities
Machines/policy   developer_machines · machine_credentials · repository_enrollments · machine_repository_grants · repository_backfill_authorizations · machine_delivery_health_reports
Telemetry         telemetry_ingest_batches (payload, plaintext) · telemetry_metric_events (immutable) · telemetry_corrections (audited overlays)
AI attribution    ai_sessions · ai_session_repositories · ai_session_usage · ai_commit_sessions · ai_commit_model_attributions · ai_generation_observations
SCM               scm_repositories · scm_commits (reachability) · scm_commit_files · scm_pull_requests · scm_pull_request_{commits,snapshots,commit_memberships} · scm_commit_lineage · scm_merge_lineage · scm_deployments · scm_contributors · scm_branches
Lifecycle         ai_code_lifecycle_events · ai_model_lifecycle_events (unique tenant+stage+evidenceRef)
Provider ledger   provider_event_deliveries (raw event, plaintext) · provider_projection_cursors
Audit/keys        security_audit_events (append-only trigger, not chained) · github_app_installations · github_app_credential_versions (encrypted)
Operations        tenant_retention_policies · evidence_export_jobs · evidence_archive_entries · retention_runs
Evidence (Task5)  tenant_evidence_settings · evidence_events · evidence_event_contents (encrypted) · evidence_intentions · evidence_links · evidence_summaries · evidence_intention_embeddings (vector 384) · evidence_semantic_jobs
Security (Task6)  tenant_security_monitor_settings · security_findings (immutable)
```

Tenant isolation: `withTenant()` in the application (the server role bypasses RLS); RLS on every table; composite `(tenant_id, id)` foreign keys only on Task4-and-later tables; on Supabase installs, migration 0000 creates `authenticated` SELECT policies keyed on the JWT email domain for 11 Task1-era tables.

## 4. Boundaries a Task must not cross

- Task2 alone defines metric meaning; `Unavailable` is never 0; observed evidence is immutable and corrections are overlays.
- Raw customer content: only Task5's audited, default-off reveal path.
- Task6 claims stop at observe-only OpenCode TUI on macOS (D6.1, D6.2 open).
- Frozen: `docs/contracts/`, merged migrations. Shared: `core/db/`, `index.ts`, `dashboard/page.tsx`, `apps/web/src/lib/`, mixed Task2/Task4 files (AGENTS.md §4).
- GitAI: never wrap git, nothing on the daemon's critical ingestion path, constant git work only (GitAI `AGENTS.md`).
- Attesta proves that records existed unchanged; it does not prove attribution is correct. "Attested" never replaces "observed" or "audited".

## 5. Gotchas Codex already hit (details in AGENTS.md §9 and the trackers)

Wrong checkout or GitAI review base; placeholder admin subject accepted at bootstrap; scheme-less repository URL quarantined a client; shared `.next` cache gave 404 chunks; reset evidence only appears with a successor commit; GitHub App events never reach localhost (tunnel or reconcile); Supabase anon key needed for the web build; inherited GitAI flakes (`daemon_mode` under parallel tests, Clippy on newer Rust); sandbox `npm ci` DNS and `shmget` failures.

## 6. Task1–Task6: what is solid and what needs improving

Sizes: S ≤ 0.05× T6, M ≈ 0.1–0.2× T6, L ≥ 0.3× T6.

```text
Task / area            Solid                                                         Needs improving                                                       Size
Task2 lifecycle        Invariants enforced in code; lineage kinds; revert/rework;    Churned is declared but never written (always Unavailable)            M-L (needs Task2 definition)
                       audited corrections; Lifecycle Lab                            T2.11e/g tokens, T2.20 identity links, T2.21 trends, E16 SCM cases    M each
                                                                                     Read path loads 19 tables per request every 15 s, in memory           L
Task2/4 ingestion      Idempotent batches, partial ack, policy binding, immutable    Normalization is synchronous, outside one transaction; recovery is   M
                       raw events                                                    a manual CLI; fingerprint uses key-order-dependent JSON.stringify    S
Task4 identity/keys    trk_v1 credentials with overlap rotation; envelope            JWT verify pins no issuer/audience; tenant from email domain          S (options), L (Task8 SSO)
                       encryption with AAD; GitHub App staged rotation               Legacy static ingest token still live and trusts a client machine ID  S-M
                                                                                     One global webhook secret, tenant by org-name string                  M
Task4 tenancy          withTenant everywhere new; composite FKs since 0003;           Task1/Task2 tables lack composite FKs; 0000 Supabase browser          M
                       Company A/B tests                                             policies by email domain contradict the server-only model             S (verify/drop)
Task4 audit/ops        Append-only audit and immutability triggers; export with      Audit log not tamper-evident (no chain, no signature); exports        → Task15 Attesta
                       checksums; retention policies; delivery health                unsigned; destructive retention not executed; raw payloads and        M
                                                                                     webhook bodies stored in plaintext
Task5 evidence         Consent, encryption, redaction, raw reveal audit, deletion;  T5.9a intention derivation is a heuristic; E5-12 sign-off pending;    L, —
                       pinned local model; CI-verified                              semantic worker not packaged (Task14)                                 L
Task6.a security       Bounded evaluator; fail-closed activation; raw-free          No admin API/UI to turn monitoring on (SQL seed only);               M
                       findings; immutable storage; audited reads                   activation lease unsigned (D6.1); routes beyond AC-CLI-03 (D6.2)     M-L, L
Console                Functional admin and developer surfaces, role-aware          885-line page.tsx (109 KB); audit inside Admin, no auditor home;      L, S-M
                                                                                     no web tests, no design system; orphaned 'evidence' view; polls ~12  M, M, S, S-M
                                                                                     endpoints every 15 s
Cross-cutting          150 API tests; CI live verifies for Task5                    Error handler returns err.message; /worker/evidence authenticates     S, S
                                                                                     twice; ~45 verify scripts mixed into src/; no API linter              M, S
GitAI fork             Task changes mostly in new files                             Hotspots in large upstream files (metrics/db.rs schema v9,            L (future sync Task)
                                                                                     telemetry_worker.rs, daemon.rs); last upstream merge 2026-09-19
                                                                                     (v1.6.19); keyring is plain JSON (0600), no OS keychain (Task9/14)
```

## 7. Where Attesta (Task15) plugs in

- **Nothing signs data today** in either repo (no ed25519, KMS signing, Sigstore, hash chain or TSA). Hashing exists only for content addressing and dedup.
- **Natural first subjects:** the security audit log (make it tamper-evident), Task4 evidence exports (sign the manifest), and per-commit attribution (a signed statement binding commit digest + authorship-note digest + lifecycle facts).
- **Shared trust layer:** D6.1 (signed activation lease) and Task6.b P6.8 (signed policy bundles) need the same signer, key hierarchy, rotation and revocation; Task9 (fleet) and Task14 T14.7 (signed artifacts, SBOM, provenance) consume it too.
- Where signing happens is a design decision for the primer (server-side tenant KMS as in SushiCorp, machine-side, or keyless Sigstore); see `REUSE_MAP.md` §3.
