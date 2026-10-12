# Mapping to CycloneDX and SPDX 3.0 (design note; export is phase 2)

Goal: a later SBOM export (phase 2, A15.P2) carries every predicate field **losslessly**, so no predicate v2 is needed for it. No export code exists yet.

## Reserved namespace

All properties live under **`trackai:attesta:`**. Names are the predicate's JSON path, dot-separated: `trackai:attesta:lines.ai`. Nothing else in TrackAI uses this prefix.

## The lossless rule

For every predicate field `F` (a wrapped field):

| Property | Value |
|---|---|
| `trackai:attesta:F:availability` | `recorded` · `partial` · `unavailable` |
| `trackai:attesta:F` | the value as RFC 8785 JSON text (absent when unavailable) |
| `trackai:attesta:F:partial_reason` / `:reason` | when present |

Plus, once per exported subject: `trackai:attesta:statement_digest` (`sha256:<hex>`), `trackai:attesta:predicate_type`, `trackai:attesta:statement_kind`, `trackai:attesta:as_of`. Because the digest is carried, a consumer can fetch the signed statement from the evidence pack and check the SBOM properties against it. The signed statement stays the source of truth.

## CycloneDX 1.6

| Predicate | CycloneDX |
|---|---|
| subject commit | a component per commit, with the subject name in `externalReferences` (`type: "vcs"`); never the repository URL |
| every field | `component.properties[]` with the names above (CycloneDX property values are strings, hence JSON text) |
| `models[]`, `tools[]` | additionally `component.modelCard` is **not** used (it describes models, not their use); tools also go to `metadata.tools.components` with name only |
| `security_findings_observed` | properties only; never `vulnerabilities[]` (monitor-only findings are not vulnerabilities) |
| the statement and envelope | `declarations.attestations[]` referencing the statement digest; the DSSE envelope as an `externalReferences` entry of type `attestation` |

## SPDX 3.0

| Predicate | SPDX 3.0 |
|---|---|
| subject commit | a `software_File` or `software_Snippet` collection element per repository, with the subject name as `externalIdentifier` (type `other`) |
| every field | an `Annotation` (`annotationType: other`, `subject` = that element) whose `statement` is the JSON object `{ "trackai:attesta:F": …, "trackai:attesta:F:availability": … }` for the whole predicate, in one annotation per statement |
| AI involvement | a `Relationship` `generates`/`hasInput` is **not** asserted: TrackAI observed assistance, it does not claim authorship (README, honest states) |
| the statement | `externalRef` of type `securityOther` (or the SPDX 3 attestation profile when it is final) pointing at the statement digest |

## Rules

- Never map unavailable to zero or to an absent property alone: `:availability` is always exported.
- Path digests stay digests; the export never resolves them to paths unless a later per-tenant opt-in adds plain paths to the predicate itself.
- New predicate fields (minor versions) map automatically by the path rule.
