# Predicate field sources (frozen; the builder's source map)

Where every `ai-provenance/v1` field comes from in Task2, its availability in v1, and the question in `docs/plan/ATTESTA_QUESTIONS.md` it serves. Approved at the design checkpoint on 2026-10-12. Paths are under `apps/api/src/`; `s` = `core/db/schema.ts`, `svc` = `features/telemetry/service.ts`, `lc` = `features/scm/lifecycle-service.ts`. Line numbers are at `main` `88301f7`.

**The builder fills each field only from the source named here** (README, "Tokens are the residual risk"). Then, in this order:

1. **Normalize as Task2 does** (`modelKey`, `features/telemetry/model-lifecycle.ts:5`): trim `tool` and `model`; an empty tool becomes `unknown`; an empty model or the literal `"unknown"` becomes `null`.
2. **Hash what does not fit:** a value that does not fit its pattern (a model name with a space, say) becomes `sha256:<64 hex>` of its UTF-8 bytes, and the field is `partial` / `values_hashed_unrepresentable`. Delivery IDs, external IDs and rule-pack versions use the same fallback.
3. **Derive, never copy, the dependent values:** `model_key = tool + "::" + (model ?? "unknown")` from the final `tool` and `model`, and `tools` from the final session and model tools. The stored `ai_commit_model_attributions.model_key` is never copied, because it was built from the raw name (S8).

| Field | Source (file:line) | v1 availability | Q |
|---|---|---|---|
| `statement_kind` | `attesta_subjects.kind` | recorded | all |
| `as_of` | `now()` of the builder's read transaction | recorded | Q8 |
| `builder` | constant name + TrackAI version and git commit | recorded | Q7, Q8 |
| `signed_late` | `as_of` against `event_at`; `telemetry_metric_events.arrival_class` (s:862) = `backfill` → `backfill` | recorded | Q8 |
| `previous` | earlier `attesta_records` about the same (tenant, repository, sha) | recorded (may be `[]`) | Q14 |
| `source_evidence.metric_event` | `telemetry_metric_events` id, `event_fingerprint` (s:856), `event_timestamp` (s:858), `evidence_family` (s:861), `arrival_class` (s:862) | recorded (`commit_observed`), else `not_applicable` | Q8, Q13 |
| `source_evidence.provider_delivery` | `provider_event_deliveries` provider, `delivery_id` (s:903), `event_fingerprint` (s:905), `received_at` | recorded (`pr_merged`, `deployed`) | Q8 |
| `source_evidence.note_digest` | the authorship note decoded from the source metric event's `raw_event` (the value Task2 writes to `scm_commits.authorship_note`, s:972, at svc:798) | recorded; `not_reported_by_source` if Git AI sent no note | Q2, Q7 |
| `first_seen` | `scm_commits.first_seen_at` (s:963); `source` = `github_push` when `scm_commits.source_event_id` (s:973) is null (the push path sets `first_seen_at`, lc:60, and never sets `source_event_id`; the note upsert never overwrites it, svc:799 against svc:805–818), else `git_ai_note` | recorded | Q8 |
| `repository` | `scm_repositories` id, provider; `url_sha256` from `normalized_url` (s:82) | recorded; `url_sha256` `source_missing` if `normalized_url` is null | Q1, Q3 |
| `commit` | `scm_commits` sha, `operation_kind` (s:960), `reachability` (s:962), `authored_at`, `committed_at` | recorded; `source_missing` for a merge result commit Task2 never received a note for | Q2, Q8 |
| `lines` | `scm_commits` `diff_added_lines`, `diff_deleted_lines`, `observed_ai_lines` (s:969), `observed_human_lines`, `observed_unknown_lines`; computed at svc:770–774 | recorded | Q1, Q3, Q13 |
| `files` | `parseAuthorshipNote` (`features/telemetry/authorship-note.ts:29`) of the source event's note: the same function and values Task2 writes to `scm_commit_files` (s:985–994, svc:900–918); `attribution_ranges_sha256` = SHA-256 of `canonicalize(ranges)`; `path_sha256` of the path | AI/human recorded; per-file `unknown_lines` **unavailable** (written as 0, svc:908) | Q1, Q2 |
| `sessions` | `ai_commit_sessions` (s:1061–1066) joined to `ai_sessions` id and `tool` (s:1008) | recorded (`ai_sessions.id` is the pseudonymous ID) | Q2, Q14 |
| `models` | `ai_commit_model_attributions` `tool` (s:1081), `model`, `observed_ai_lines` (s:1084), `session_id`; `model_key` derived (rule 3 above), never copied from s:1083 | recorded; a null model stays null ("Unknown model") | Q3, Q4 |
| `tools` | distinct tools of `sessions` and `models` (S4) | recorded | Q4 |
| `committer` | `scm_contributors.id` (s:1546–1556), matched on normalized email, else name, as svc:221–226 | `partial` / `identity_matched_by_name_or_email`; `source_missing` when the commit has no author | Q6 |
| `lifecycle` | `ai_code_lifecycle_events` `stage` (s:1454), `line_count` for this commit: `committed` (svc:851), `merged` (lc:311), `production` (lc:494) | value recorded; `calculation_version` **unavailable** (gap G6) | Q3, Q9, Q10 |
| `pull_request` | `scm_pull_requests` id, number, external_id, state, head_sha, merge_commit_sha, `merged_at` (s:826); `author_identity_id` = `scm_provider_identities.id` (s:1495) for `author_provider_id` (s:819) | recorded (`pr_merged`) | Q3, Q14 |
| `merge_lineage` | `scm_merge_lineage` source and result sha, `merge_method` (s:1170), `confidence`; written after the projection transaction (`features/scm/scm.routes.ts:436–470`, lc:187–298) | recorded, or `partial` / `lineage_still_being_enriched`, or `source_missing` in a first statement | Q3, Q14 |
| `merged_by` | not captured yet (`features/scm/parser.ts:173–225` does not parse it) | **unavailable** (G4) | Q6 |
| `reviews` | not captured yet | **unavailable** (G3) | Q5 |
| `deployment` | `scm_deployments` id, provider, external_id, environment, status, `production` (s:1189), `deployed_at` (s:1190), sha | recorded (`deployed`) | Q9 |
| `policy.repository_enrollment` | `repository_enrollments` id, status, effective_from/until, `commit_note_evidence_from` (s:199) | recorded | Q12, Q13 |
| `policy.security_monitor` | `tenant_security_monitor_settings` `mode` (s:294), `version` | recorded; `source_missing` when the tenant has no row | Q11, Q12 |
| `policy.rule_pack_versions` | `security_findings.rule_pack_version` (s:504) of the findings counted below | `partial` / `present_only_when_findings_exist` | Q11, Q12 |
| `policy.org_ai_policy` | not captured yet | **unavailable** (G2) | Q4, Q12 |
| `security_findings_observed` | `security_findings` `rule_category` (s:486), `rule_severity` (s:487) for the subject's repository, joined on `session_id` text (s:474–505; no key to `ai_sessions`) | `partial` / `linked_by_session_string_not_key` | Q11 |
| `repo_snapshot` | not captured yet | **unavailable** (G1) | Q1 |

## Builder rules tied to the sources

- **B1. The note's own event decides note-derived fields.** `note_digest` and `files` come from the source metric event, so they always describe the same note. `scm_commit_files` can still hold rows from an earlier note for the same sha, because the upsert never deletes (svc:900–918); the builder does not read them.
- **B2. A projection overwritten by a later note.** If `scm_commits.authorship_note` no longer equals the source event's note at build time, the commit-level projections (`lines`, `sessions`, `models`, `tools`, `committer`, `lifecycle`) describe a later observation, and that observation has its own outbox row. The builder then marks those fields `unavailable` / `source_missing` for this statement and keeps `files` and `note_digest` from the source event. It never signs a mix of two notes.
- **B3. Lifecycle values are observations as of `as_of`** (decision 3); a rebuild produces a new statement only when explicitly requested (`signed_late.reason = rebuild_requested`).
