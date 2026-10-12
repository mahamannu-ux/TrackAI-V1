# `period_report` statement (design, binding; phase 1, built in A15.9)

Added at the founder's request on 2026-10-12. It answers "what share of repository X was AI-assisted in a period, and prove it" with **one signed figure** that anyone can recompute from the signed statements behind it. Pattern: SushiCorp RP-1 (catalog), where a report's numbers carry the records they came from, and the signature covers a small statement that names the report digest.

## Why a separate predicate type

Its subject is a report document, not a commit, and its fields are aggregates. Putting it in `ai-provenance/v1` would mean the commit predicate carries fields that never apply to it. So it is **its own predicate type**: `https://trackai.dev/attesta/period-report/v1`. The JSON Schema is frozen in A15.9, when the ledger (A15.3) it counts over exists. This note fixes the parts that matter now.

## Statement

| Part | Value |
|---|---|
| `_type` | `https://in-toto.io/Statement/v1` |
| `subject[0].name` | `trackai:repository/<repository UUID>/period/<from>..<to>` (RFC 3339 UTC, ms, `Z`) |
| `subject[0].digest` | `{sha256: <hex>}`: SHA-256 of the RFC 8785 bytes of the **report document** |
| `predicateType` | `https://trackai.dev/attesta/period-report/v1` |
| Envelope, digest, ledger | exactly as `envelope.md` and `tables.md` (`record_kind = statement`, `outbox_subject_id = null`) |

## Predicate (fields fixed now; exact schema in A15.9)

| Field | Meaning |
|---|---|
| `scope` | `repository_id`, `from`, `to`, `basis` (`recorded_at`: statements chained in the period) |
| `chain_range` | `from_seq`, `to_seq` and the `record_hash` at `to_seq`: the tenant chain segment the report read. Because `seq` is gap-free and anchored, a verifier can prove no statement in the segment was left out |
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
