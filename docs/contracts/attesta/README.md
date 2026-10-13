# Attesta contract v1 (Task15c, A15.0)

Status: **Frozen when merged.** Written 2026-10-12 by Claude (Task15c-attesta-contract) from `docs/plan/ATTESTA_QUESTIONS.md` (decisions 1–5) and `docs/plan/TASK15.md` §2. Founder approved the design checkpoint on 2026-10-12.

Attesta turns Task2's attribution records into signed, tamper-evident statements that a third party can check without trusting TrackAI. This folder freezes what every later Attesta session and Codex's Task2 trigger (A15.7) build against.

## Files

| File | What it freezes | Status |
|---|---|---|
| `statement-v1.schema.json` | The in-toto Statement v1: one git-commit subject, the predicate type, the predicate | frozen |
| `predicate-ai-provenance-v1.schema.json` | Predicate `https://trackai.dev/attesta/ai-provenance/v1`: every field, its availability, its bounds | frozen |
| `fixtures/` + `fixtures/manifest.json` | Synthetic valid, invalid and "lying" statements with the expected result of each | frozen |
| `envelope.md` | DSSE envelope, payload bytes, signing call, deduplication on the statement digest | frozen |
| `outbox.md` | The `attesta_subjects` table Task2 writes (migration `0016`) and `enqueueAttestaSubject` | frozen |
| `tables.md` | Ledger, envelope and anchor tables (built in A15.3 and A15.5) | design, binding |
| `api.md` | Auditor-readable routes (built in A15.9) | design, binding |
| `errors.md` | Stable error codes | frozen (codes are additive) |
| `fields.md` | Where every predicate field comes from in Task2 (`file:line`), its v1 availability and the question it serves | frozen (the builder's source map) |
| `mapping.md` | Predicate → CycloneDX and SPDX 3.0 under `trackai:attesta:*` | design note |
| `period-report.md` | The `period_report` statement (phase 1, built in A15.9) | design, binding |

"Design, binding" means the later session may add detail but not contradict it without a founder decision recorded here. The cross-field rules (S1–S12) below are implemented once, in `apps/api/src/features/attesta/contract-rules.ts`; the fixture test (`contract-fixtures.test.ts`) checks every fixture against the schemas, those rules and the manifest.

## Subjects: what a statement is about

A statement's subject is something with a digest. In v1 it is always **one git commit**:

| Kind | Subject commit | Written when |
|---|---|---|
| `commit_observed` | the commit, once its Git AI authorship note is normalized | the note normalization transaction |
| `pr_merged` | the PR's merge, squash or rebase **result** commit; the PR identity, lineage and source-commit statement digests are in the predicate | the provider-projection transaction of the merged PR delivery |
| `deployed` | the deployed commit | the deployment observation (production, `success` only) |

**Subject name** (decision recorded here): `trackai:repository/<repository UUID>/commit/<sha>`, with `digest: {gitCommit: <sha>}` (40 or 64 lowercase hex). The repository URL is customer data, so it is **not** in the statement; the predicate carries `repository.url_sha256` (SHA-256 of the UTF-8 normalized URL) so anyone who knows the URL can confirm the match. A pack passed on to a third party does not **disclose** the organization or repository name; it is an unsalted hash, so someone who guesses the exact URL can **confirm** the guess. The same holds for `path_sha256`. A per-tenant keyed hash (HMAC) would remove that, at the cost of key management and of auditors' ability to check a path themselves; it is a possible later minor version, not v1.

**Other levels.** A PR is attested by `pr_merged`. Repository-level figures ("% AI in X as of a date") are aggregates: answered by a query over signed statements in which every number links to the statements behind it, and, when one signed figure is needed, by a **`period_report`** statement (its own predicate type, `period-report.md`). Developer-level figures are **never** a subject: statements carry pseudonymous IDs, so a legitimate per-developer query is possible, but a signed per-person statement would be a permanent, shareable surveillance record (Task5's no-surveillance rule).

**Reserved future kinds** (each additive, none changes an existing kind or Codex's interface): `repo_snapshot` (gap G1), `review_recorded` (G3), `correction` (a Task2 correction overlay, referencing what it supersedes), `commit_discovered` (push-only, only if needed).

## Predicate decisions

| Decision | Choice | Why |
|---|---|---|
| Predicate type | `https://trackai.dev/attesta/ai-provenance/v1` | The name in TASK15 §2; no reason to change it |
| File paths | `path_sha256` only (SHA-256 of the UTF-8 path) | Paths can be sensitive; an auditor holding the repo hashes the path to answer Q2. Plain paths could be a later per-tenant opt-in (minor version) |
| People | pseudonymous TrackAI UUIDs: `scm_contributors.id` (committer), `scm_provider_identities.id` (PR author), `ai_sessions.id` (sessions) | No names, emails or logins leave the tenant's database |
| Attribution ranges | `attribution_ranges_sha256` = SHA-256 of `canonicalize(scm_commit_files.attribution_ranges)` | Proves the ranges without carrying them |
| `note_digest` | SHA-256 over the UTF-8 bytes of the authorship note string **as decoded from the source metric event**, no normalization; records algorithm, encoding and `source_event_id` | Decision 2. Equal to what Task2 stored in `scm_commits.authorship_note` at that normalization (`service.ts:798`); a later event can overwrite that column (`service.ts:816`) before signing, the source event cannot change |
| `as_of` | The database clock (`now()`) at the start of the builder's read transaction: the moment the sources were read. A retry is a new build with a new `as_of`, so one outbox row can never be chained twice (`tables.md`: `outbox_subject_id` unique) |
| `calculation_version` | `unavailable` (`not_captured_yet`) in v1 | Task2 publishes no calculation version (gap **G6**, proposed); `builder.version` pins the code that computed every value |
| Validator | `ajv@8.17.1` (devDependency, exact; founder yes 2026-10-12), strict mode | Draft 7, as the Task6 contracts |

## Availability (every field)

Every predicate field except the identity blocks (`statement_kind`, `as_of`, `builder`, `signed_late`, `previous`, `repository.id`, `commit.sha`) is an object `{availability, …}`:

| `availability` | Required | Forbidden |
|---|---|---|
| `recorded` | `value` | `partial_reason`, `reason` |
| `partial` | `value`, `partial_reason` (enum) | `reason` |
| `unavailable` | `reason`: `not_captured_yet` · `not_applicable` · `source_missing` · `not_reported_by_source` | `value`, `partial_reason` |

So a field TrackAI cannot fill is **present and `unavailable`, never missing and never zero**. In v1 `merged_by` (G4), `reviews` (G3), `policy.org_ai_policy` (G2) and `repo_snapshot` (G1) **must** be `unavailable`: they are not captured yet, and the schema refuses a recorded value. Per-file `unknown_lines` is `unavailable` because Task2 writes 0 there without computing it (`service.ts:908`).

## Numbers, strings and privacy

- **Numbers are integers** within ±(2^53 − 1) (counts ≥ 0, `confidence` 0–100); `"type": "number"` never appears. Attesta canonicalization accepts some large doubles (Task15a deviation); the predicate never relies on that.
- **Strings are bounded:** UUIDs, hex digests, RFC 3339 UTC timestamps with milliseconds and `Z` (real month, day and hour ranges), enums (finding categories and severities are Task6's), provider names (`^[a-z][a-z0-9_-]{0,31}$`), GUID-shaped delivery IDs, numeric provider IDs, semver-shaped versions (each also accepting the `sha256:<hex>` fallback), or a *token* (`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`, no whitespace, no `@host.domain`). No field accepts prose, code or a commit message.
- **Tokens are the residual risk:** `tool`, `model`, `model_key`, `tools[]` and `calculation_version` come from what Git AI reports, and a token can still hold a short identifier-shaped string (a branch-like name, a path). So **the builder fills every field only from its named source column in `fields.md`**, never from another column, normalizes `tool` and `model` as Task2's `modelKey` does, and derives `model_key` and `tools` from the final values. A source value that does not fit its pattern (a model name with a space, say) is replaced by `sha256:<64 hex>` of its UTF-8 bytes and the field is marked `partial` / `values_hashed_unrepresentable`; it is never dropped and never makes the statement fail.
- **Never in a statement:** raw prompts, responses, tool payloads, code, diffs, commit messages, PR titles, branch names, file paths, file contents, emails, names, logins, external session IDs, repository URLs (AGENTS.md rule 6).
- Every object in both schemas is closed (`additionalProperties: false`); the fixture test checks this.
- Security findings are reported as `security_findings_observed` (monitor-only, Task6): observed, never "blocked" or "prevented".

## Cross-field rules (S1–S12)

JSON Schema cannot compare fields, so a statement can be schema-valid and still lie. The builder refuses to sign, and the verifier reports, any statement that breaks:

| ID | Rule |
|---|---|
| S1 | One commit everywhere: subject name sha = `digest.gitCommit` = `commit.sha` = `pull_request.merge_commit_sha` (`pr_merged`) = `deployment.sha` (`deployed`) |
| S2 | The repository UUID in the subject name = `repository.id` |
| S3 | `files.total − entries.length = files.omitted`; `omitted > 0` only with `partial`/`entries_truncated`, and `entries_truncated` only on `files`; `path_sha256` unique |
| S4 | `tools` = the distinct tools named by `sessions` and `models` |
| S5 | Every timestamp is a real instant (`Date` round trip); `first_seen.at` and `provider_delivery.received_at` (TrackAI's own clock) are not after `as_of` |
| S6 | `previous` lists each earlier statement once |
| S7 | `note_digest.source_event_id` = `metric_event.id` |
| S8 | `model_key` = `tool + "::" + (model ?? "unknown")` (Task2 `modelKey`, `model-lifecycle.ts:5`), with a missing model as `null`, never `"unknown"`; each `(model_key, session_id)` and each session listed once; a model's `session_id` is one of `sessions` |
| S9 | `lines.unknown = max(0, added − ai − human)` (`service.ts:774`); with all file entries present, the file AI and human sums equal `lines.ai` and `lines.human` (`service.ts:770–773`), and never exceed them when entries are omitted |
| S10 | `security_findings_observed.total` = the sum of `by_category` = the sum of `by_severity` |
| S11 | `merge_lineage` lists each source commit once; in `pr_merged`, every non-rebase entry's `result_sha` = `commit.sha` |
| S12 | Every provider field (`provider_delivery`, `pull_request`, `deployment`) = `repository.provider` |

Kind consistency is enforced by the schema itself: which blocks a kind must or must not carry, `commit_observed` coming from a commit-note (or legacy) metric event with its note digest recorded or `not_reported_by_source`, that `previous` names only ai-provenance statement kinds (any of the three, in any order: the ledger lists every earlier statement about the subject; relaxed 2026-10-13, contract finding F2 from Task15h, before any production statement existed), and `signed_late` consistency.

## Versioning rules

1. **Additive minor versions inside `…/v1`:** a minor version may only add **optional** fields. The predicate type URI does not change.
2. **The builder validates its own output strictly** against the exact version it writes (schema + S1–S12), on the parsed snapshot of the canonical bytes it signs.
3. **Verifiers ignore fields they do not know**, so an older verifier accepts a newer minor version. (The frozen v1 schema is closed; a verifier checking v1.x output validates with the v1.x schema or drops unknown fields first.)
4. **A breaking change is a new predicate type** (`…/ai-provenance/v2`), never an edit of v1.
5. **A signed statement never changes.** A later fact (merge, deployment, review, correction, enrichment) is a **new statement** that lists the earlier one in `previous`. Re-attesting an old subject is a statement with `signed_late.value = true` and its reason (`backfill`, `rebuild_requested`, `delayed_build`).
6. **New statement kinds are additive** (new enum values in a minor version, new outbox kinds); existing kinds, their rows and their keys never change.

## Provenance

Ported from SushiCorp @ `0bd67a5` (catalog EV-1, EV-2, RP-1): closed record schemas (`contracts/schemas/decision_record.schema.json`), stored canonical bytes and the statement digest as identity, anchoring separate from the record (`db/migrations/versions/0001_initial_schema.py`, handoffs B3 and A2b), and the RP-1 pattern of signing a small statement that names a report digest (`services/reporting/signing.py`). **Deviations:** the record is an in-toto Statement in a DSSE envelope (SushiCorp signed bare JCS records); Task2's trigger is an outbox in the observing transaction (SushiCorp had none); Draft 7 instead of 2020-12, to match the Task6 contracts.
