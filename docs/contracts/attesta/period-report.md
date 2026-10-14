# `period_report` statement (frozen when merged; built in Task15i4, A15.9 part 3)

Added at the founder's request on 2026-10-12. It answers "what share of repository X was AI-assisted in a period, and prove it" with **one signed figure** that anyone can recompute from the signed statements behind it. Pattern: SushiCorp RP-1 (catalog), where a report's numbers carry the records they came from, and the signature covers a small statement that names the report digest.

## Why a separate predicate type

Its subject is a report document, not a commit, and its fields are aggregates. Putting it in `ai-provenance/v1` would mean the commit predicate carries fields that never apply to it. So it is **its own predicate type**: `https://trackai.dev/attesta/period-report/v1`. The JSON Schema is frozen in A15.9, when the ledger (A15.3) it counts over exists. This note fixes the parts that matter now.

## Statement

| Part | Value |
|---|---|
| `_type` | `https://in-toto.io/Statement/v1` |
| `subject[0].name` | `trackai:repository/<repository UUID>/period/<from>..<to>` (RFC 3339 UTC, ms, `Z`) |
| `subject[0].digest` | `{sha256: <hex>}`: SHA-256 of the RFC 8785 bytes of the **report document** (`period-report-document-v1.schema.json`) |
| `predicateType` | `https://trackai.dev/attesta/period-report/v1` |
| Envelope, digest, ledger | exactly as `envelope.md` and `tables.md` (`record_kind = statement`; `statement_kind`, `subject_sha` and `outbox_subject_id` null; `repository_id` from the subject name) |
| Schema | `predicate-period-report-v1.schema.json`; the whole statement is its `#/definitions/statement` |

## Predicate (fields fixed now; exact schema in A15.9)

| Field | Meaning |
|---|---|
| `scope` | `repository_id`, `from`, `to`, `basis` (`recorded_at`: statements chained in the period) |
| `chain_range` | `from_seq`, `to_seq` and the `record_hash` at `to_seq`: the tenant chain segment the report read. Because `seq` is gap-free and anchored, a verifier can prove no statement in the segment was left out. **Trade-off:** that proof needs every `canonical_record` in the segment, across all of the tenant's repositories, so a pack scoped to one repository still shows the other records' metadata (repository UUIDs, subject shas, kinds, digests), never their statements. A15.9 decides whether to add a per-repository proof (for example a per-repository Merkle commitment in each record) before packs are shared with repository-scoped outsiders |
| `inputs` | `statement_count` and `statements_root`: the RFC 6962 Merkle root (`merkle.ts`) over the included statement digests in `seq` order |
| `figures` | each figure is `{availability, value, statements_root}`, integers only. v1 figures: commits observed; AI / human / unknown lines changed; merged AI lines by tool and model; PRs merged; production deployments; lines with `unknown` attribution |
| `ratios` | **basis points** (integer 0–10000), never floats: AI share of changed lines; AI share of merged lines |
| `repo_share` | AI share of the **whole repository** as of `to`: `unavailable` (`not_captured_yet`) until the `repo_snapshot` kind (gap G1) exists |
| `completeness` | per figure, how many input statements had the field `partial` or `unavailable`, so a figure built on gaps says so |
| `builder`, `as_of`, `signed_late`, `previous` | as in ai-provenance (a re-run for the same scope lists the earlier report in `previous`) |

## The report document

The report document lists, per figure, the statement digests it summed (RP-1's `{count, records}`) and the per-statement contributions. It is stored by A15.9 and shipped in the evidence pack; its digest is the subject. Re-generating a report for the same scope and chain range from the same statements must give byte-identical document bytes (database clock, figures from the signed statements only, never from live Task2 tables).

## Rules

- Figures are computed **only from signed statements**, never from live tables. A live dashboard can show today's numbers; the report shows what was signed.
- A report never claims more than its inputs: if a statement in range is not yet anchored, the report is still produced and its anchor state says `pending`.
- No per-developer report kind exists or will be added (README, "Other levels").

## Figures v1 (Task15i4; founder checkpoint 2026-10-14)

**Inputs.** Every signed **ai-provenance** statement of the repository whose ledger `recorded_at` lies in [`from`, `to`] (both inclusive, RFC 3339 UTC ms), read from the stored statement bytes in one repeatable-read snapshot. Earlier `period_report` statements are never inputs. The document lists them in `statements` (`seq`, `digest`, `statement_kind`), seq ascending; `inputs.statements_root` is the RFC 6962 root over their digests (leaf data: the 32 raw digest bytes; the empty list's root is SHA-256 of the empty string).

**One statement per subject (founder decision 2026-10-14).** A commit seen in several statements of a kind counts once, by its **latest** statement in range (highest `seq`): a later note supersedes an earlier one. `commit_observed` and `pr_merged` are keyed by subject sha, `deployed` by `deployment.value.id` (one commit can be deployed twice). Lines come from `commit_observed` only and merged figures from `pr_merged` only, so "observed, then merged" never double-counts.

| Figure | Signed field summed (Task2 semantics, `fields.md`) | Kind | Contribution per statement |
|---|---|---|---|
| `commits_observed` | the subject (identity; always recorded) | `commit_observed` | `1` |
| `lines_changed` | `lines.value` `{ai, human, unknown, added, deleted}` (svc:770–774); "lines with unknown attribution" is its `unknown` | `commit_observed` | the line counts |
| `prs_merged` | `pull_request` (identity) | `pr_merged` | `1` |
| `merged_lines` | `lines.value` of the merge result commit | `pr_merged` | the line counts |
| `merged_ai_lines` | `lifecycle.value.ai_lines` (stage `merged`, Task2's Merged metric) | `pr_merged` | the integer |
| `merged_ai_lines_by_model` | `models.value[].ai_lines`, grouped by `model_key` (sessions summed), sorted by `model_key` | `pr_merged` | the statement's grouped rows |
| `production_deployments` | `deployment` (identity) | `deployed` | `1` |

`merged_ai_lines` and the sum of `merged_ai_lines_by_model` are different Task2 measures (surviving lines vs attributions of the carried commits) and are never forced to agree.

| Ratio (basis points, 0–10000) | Value |
|---|---|
| `ai_share_of_changed_lines_bp` | `floor(10000 · ai / (ai + human + unknown))` of `lines_changed` |
| `ai_share_of_merged_lines_bp` | the same of `merged_lines` |

A ratio is `unavailable`/`source_missing` when its figure is, `unavailable`/`not_applicable` when the denominator is 0, `partial` when its figure is. Floor, never round up: a report never claims more than its inputs. `repo_share` is `unavailable`/`not_captured_yet` until `repo_snapshot` (G1).

**Availability and completeness.** Per figure, `completeness = {inputs, recorded, partial, unavailable}` counts the selected statements by the availability of the field the figure reads. The figure is `recorded` when every input is recorded (zero inputs give an honest recorded 0, or `[]`); `partial` / `only_some_sources_reported` when some input is partial or unavailable and at least one contributes; `unavailable` / `source_missing` when inputs exist and none contributes. Each figure's `statements_root` is the root over the digests of its contributing statements (seq order); the document lists them as RP-1 `{count, records: [{seq, digest, availability, contribution}]}`.

**What is where.** The document holds `format`, `tenant_id`, `scope`, `statements`, the figures with their contributions, `ratios`, `repo_share` and `completeness`: no generation time, builder version or chain head, so the same statements give the same bytes. The predicate holds the same figures without contributions, plus `chain_range` (the window's records and one boundary record each side, the evidence-pack rule; `to_record_hash` is the `record_hash` at `to_seq`), `inputs`, `builder` (`trackai-attesta-report-builder`), `as_of` (database clock), `signed_late` (always `{false, none}`) and `previous`. `to` must be at least 5 minutes before `as_of` (`evidence-pack.md`). At most 50 000 input statements.

## Rules P1–P10 (`period-report-rules.ts` `checkPeriodReport`)

| ID | Rule |
|---|---|
| P1 | `subject[0].name` = `trackai:repository/<scope.repository_id>/period/<scope.from>..<scope.to>`; `subject[0].digest.sha256` = SHA-256 of the document bytes; `from` ≤ `to` ≤ `as_of` − 5 min; all three real instants |
| P2 | The document's `scope` = the predicate's; its `tenant_id` = the ledger record's tenant |
| P3 | `statements` seq ascending, digests unique, all inside `chain_range`; `inputs.statement_count` and `inputs.statements_root` match them; `to_seq = −1` exactly when `to_record_hash` is null |
| P4 | Each figure's records are listed statements of the figure's kind, seq ascending, once; `count` = their number; `statements_root` matches |
| P5 | Each figure's value is the sum of its contributions |
| P6 | `recorded + partial + unavailable = inputs`; records are exactly the recorded and partial inputs; the figure's availability follows the rule above |
| P7 | Ratios follow from `lines_changed` and `merged_lines` |
| P8 | The predicate's figures (without contributions), `ratios`, `repo_share` and `completeness` equal the document's |
| P9 | With the input statements at hand (a database read, a `full` evidence pack): recomputing the document from their signed fields gives the same bytes, so no statement is left out, added, or misread |
| P10 | `previous` lists each earlier report for the same subject name once, oldest first |

The builder refuses to sign a report that breaks P1–P10 (`ATTESTA_BUILDER_SCHEMA_INVALID` / `ATTESTA_BUILDER_RULE_VIOLATION`). P9 needs the statements, so it is checked by the builder and by a verifier holding a `full` pack; whether **every** in-window statement was given needs the chain segment (evidence-pack.md "Which records").

## Jobs and routes (Task15i4)

`POST /api/attesta/period-reports` (`{repository_id, from, to}`, `Idempotency-Key` required; 202), `GET /api/attesta/period-reports/{id}` (status, `report_digest`, `statement_digest` when chained), `GET /api/attesta/period-reports/{id}/document` (the stored document bytes, `no-store`, audited). Action `attesta.export`. A job moves `queued` → `running` → `ready` | `failed`, never back (table `attesta_period_reports`, migration 0022). The document, its digest and the chained record are written in the **same ledger transaction**; signing happens before it, with no network call inside it. A job a restart left queued or stranded is run by `npm run attesta:report -w apps/api -- --run-queued`.

**Evidence packs:** `reports` stays `[]` until the follow-up (founder 2026-10-14). A pack whose window holds a report record lists that statement under `statements` like any other; the offline verifier checks it against this schema and the record's typed columns, and reports the `reports` check as not checkable (exit 2), because P1–P10 need the document.
