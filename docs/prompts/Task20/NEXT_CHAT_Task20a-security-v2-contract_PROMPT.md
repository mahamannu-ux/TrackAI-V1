# Handoff prompt: Task20a-security-v2-contract (the frozen security v2 contract), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the `docs/Task20-plan` PR (it holds this prompt), after `scripts/pr-preflight.sh docs/Task20-plan` says ok. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Codex:** start a new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`), and paste everything below the line.
> 3. Nothing else to provide: Numbat is already at `~/AIProjects/numbat` (commit `20a5a52`), read-only.
> 4. Checkpoint: after step 2 of §3 (README and decisions table, before the schemas), Codex sends a short summary of any decision it had to make beyond §2.1. Paste it to the Task20 lead (Claude) and paste the answer back.
> 5. When it finishes, paste its review request to the **Task20 lead chat (Claude)**. Push only after "ready to push". The contract lands as its own PR, before any other Task20 session.

---

You are **Codex**, building **Task20a-security-v2-contract** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task20 replaces Task6.a's own three-rule detector with **Numbat** (`perplexityai/numbat`, Apache-2.0), run unchanged on developer machines. The **TrackAI Endpoint** ships Numbat's records to the server. The CISO's rule and data settings come back to the Endpoint as two separately signed documents.

This session writes the **frozen contract** every other Task20 session builds against: the upload kinds, the data settings, the rule-bundle manifest, the activation lease, the lease reference in Task9's fleet configuration, the machine-authenticated routes and the error codes, plus fixtures and an interface-first TypeScript module. It does **not** write ingest, storage, a migration, signing, routes or any Endpoint (GitAI) code.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task20a-security-v2-contract`, branch `task/Task20a-security-v2-contract`.
- **Handoff:** `docs/handoffs/Task20a-security-v2-contract_HANDOFF.md`.
- **Naming (AGENTS.md §2):** "the Endpoint" for anything on or delivered to a machine; "GitAI" only for the repository.

## 0. Before anything else
1. **Read `AGENTS.md` in full**, in particular §1 rules 1 and 6–9, §2 "Names", §4 (Task20 row), §5 (interfaces first), §5a (third-party sources), §10 (API conventions), §12.1, the §12.4 reply shape, §8 Effort, and explicit staging.
2. **Check location and identity:** `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`; if not, stop and tell the founder. If the branch is detached or `codex/...`, run `git switch -c task/Task20a-security-v2-contract`. Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only. The checkout must contain `docs/plan/TASK20.md`; otherwise stop.
3. **Toolchain:** `npm ci`, then `npm test` once as a baseline (1020 tests passed on 2026-10-16).
4. **Estimate:** one line against T6. The plan says **about 0.12×** (a contract with fixtures, no migration).

## 1. Read before writing anything
- `docs/plan/TASK20.md` **§1** (boundaries) and **§3** (interfaces to freeze first: the meanings are fixed there, you decide names and exact shapes). Then `docs/plan/primers/Task20_PRIMER.md` "Facts from the code" 1–10, and `docs/plan/NUMBAT_ADOPTION_REVIEW.md` §13–§14.
- **Numbat, read-only, at `~/AIProjects/numbat` (`20a5a52`):**
  - `docs/schema/v0.5.0/*.schema.json` and its `README.md`: the record shapes you project from;
  - `docs/cli.md:274-324` (the record stream);
  - `docs/agent-coverage.md:117-141` (permission events and per-action ids);
  - `docs/enforcement.md:105-128` (enforcement records);
  - `cmd/numbat/testdata/*.ndjson` (real record streams for fixtures).
- **TrackAI:**
  - `docs/contracts/task6/` (style and fixture manifest; frozen, history only);
  - `docs/contracts/attesta/envelope.md` (DSSE) and `trust.md` "Consumers";
  - `docs/contracts/audit/catalog.md:66-78` (reserved events);
  - `apps/api/src/features/fleet/contract.ts` (configuration schema versions 1 and 2, `securityActivation`);
  - `apps/api/src/features/security-findings/contract.ts` (Task6.a upload, for comparison);
  - `apps/api/src/features/attesta/contract-fixtures.test.ts` (how fixtures are validated with `ajv`).

## 2. Scope (approved by the founder)
### 2.1 Approved decisions
1. **Folder:** new `docs/contracts/security-v2/`, frozen once merged, with a README stating `[CONTRACT - FROZEN]`, a versioning rule (additive minor versions only; a breaking change is a new major version beside this one) and the accepted Numbat record schema range (exactly `0.5.0` for now).
2. **Schemas:** JSON Schema Draft 7 (the style of `docs/contracts/task6/`), `additionalProperties: false` everywhere, bounded strings and arrays, RFC 3339 UTC timestamps.
3. **One upload envelope.** `trackai.security-upload/2` carries `records[]`, at most 500 records and 4 MiB per request. Each record has a `kind` and a `record_id`:
   - the `record_id` is a deterministic idempotency key, built from Numbat's own id (`finding_id`, `decision_id`, `event_id`, or `(run_id, type, value)` for indicators) plus the kind;
   - **no tenant or machine identity appears in the body**; the server derives both from the machine credential.
4. **Kinds**, as projections of Numbat 0.5.0 records:
   - `finding` (from `finding-record`): `rule_id`, `rule_version`, `severity` (Numbat's five values), `title`, `source_agent`, `source_type`, `model`, `model_provider`, `session_id`, `parent_session_id`, `sub_agent_id`, `confidence`, `tags`, `detected_at`, `numbat_schema_version`, `bundle_digest`, `lease_id`, `found_at_rest` (boolean, day-one scan), `repository` as `{kind: "enrolled", id}` or `{kind: "not_enrolled"}`;
   - `enforcement` (from `enforcement-record`): `decision` (`deny` or `no_override`), `mode`, `rule_ids`, `deny_rule_id`, `deny_rule_version`, `finding_record_ids`, `tool_name`, `tool_call_id`, `session_id`, `source_agent`, `timestamp`;
   - `indicator` (from `indicator-record`): `type`, `value`, `count`, `first_seen`, `last_seen`, `source_agent`;
   - `scan_summary`: status and counts only;
   - `permission_event` (from event records with `event_type` `permission.*`): `outcome`, `tool_name`, `tool_call_id`, `session_id`, `source_agent`, `timestamp`, and `join` (`exact`, `same_session_window` or `unavailable`);
   - `security_status`: Numbat version, wired agents, active bundle digest, lease id, last record time, the four health-check layers as `ok`, `failed` or `unavailable`;
   - `agent_inventory`: agent, version, config/artifact/wired flags as in `numbat agents --format json`.
5. **Never in any kind:**
   - `tool_input`, `tool_result`, `content`, `content_preview` of messages, `evidence_refs`;
   - `project_path`, `project_path_hash`, `sample_project_path_hash`;
   - `endpoint.uid`, `endpoint.device_id`;
   - any field not listed in a schema.

   Invalid fixtures prove each of these is refused.
6. **Data settings:** `trackai.security-data-settings/1` has five boolean groups, all `false` by default:
   - `command_previews` → `observed_command`;
   - `file_paths` → `observed_file_path`;
   - `urls` → `observed_url` and every indicator kind (`domain`, `ip`, `url`, `email`, hashes): **indicators do not leave the machine by default**;
   - `host_identity` → `endpoint.hostname`;
   - `user_identity` → `endpoint.username`.

   The finding schema allows these fields only as optional, redacted strings (Numbat's own redaction, at most 200 code points). The README states that the server **refuses** a record carrying a field the tenant's current settings do not allow (`SECURITY_V2_FIELD_NOT_PERMITTED`), rather than silently dropping it.
7. **Rule bundle:** `trackai.security-rule-bundle/1` is one JSON document. It carries:
   - the tenant, `bundle_version`, `epoch`, `numbat_pin` and `compiler_version`;
   - `agents{}`: for each agent, `files[]` (`path`, `sha256`, `content_b64`, each file ≤ 256 KiB, the bundle ≤ 4 MiB) and the `enabled_rule_ids`.

   It travels as a DSSE envelope (`envelope.md`) with purpose `policy_bundle` and audience `platform` (`trust.md` "Consumers"). Its digest is the SHA-256 of the payload bytes.
8. **Activation lease:** `trackai.security-activation-lease/2`, a DSSE envelope with purpose `activation_lease` and audience `platform`. It names:
   - `tenant_id`, `machine_id`, `lease_id`, `issued_at`, `expires_at`;
   - `mode` (`off`, `monitor` or `monitor_and_pilot_block`), `agents[]`, `bundle_digest`;
   - `data_settings` (the object of item 6), `day_one_scan` (boolean).

   The default validity is **72 hours, refreshed hourly**. A machine that is offline longer stops uploading new records; switching monitoring off takes effect at the next refresh. Put both numbers in the README as contract constants.
9. **Lease reference in Task9's fleet configuration:** a new **configuration schema version 3**, identical to version 2 except that `securityActivation` is replaced by `securityLease: {leaseId, bundleDigest, expiresAt}`. Versions 1 and 2 stay valid, and their `securityActivation` is treated as `off`. You write the shape and fixtures only. Task20f changes `features/fleet/` and widens the database check `fleet_configurations_schema_version_check`, not you.
10. **Routes**, specified in `api.md` only (Task20d and Task20f build them). All are machine-authenticated under `/worker/security/v2`, `no-store`, with RFC 7807 errors and an echoed `X-Request-ID`:
    - `POST /records`: the upload envelope; per-record results `accepted`, `duplicate` or `rejected` with a code;
    - `GET /lease`: this machine's current lease envelope, or 404 with `SECURITY_V2_LEASE_NOT_ISSUED`;
    - `GET /bundles/{sha256}`: the bundle envelope;
    - `POST /acknowledgements`: `{lease_id, bundle_digest, result: "applied" | "refused", refusal_code?}`.

    **Tenant and machine come only from the credential.** A digest of another tenant or a lease of another machine answers exactly like a missing one (`SECURITY_V2_NOT_FOUND`). Write the required negative cases (Company A/B, machine X/Y) as a numbered list in `api.md`, so Task20d and Task20f copy them into tests.
11. **Errors:** `errors.md` lists safe codes only, never echoing a value. At least: `SECURITY_V2_INVALID_BODY`, `_UNSUPPORTED_SCHEMA`, `_UNKNOWN_FIELD`, `_FIELD_NOT_PERMITTED`, `_LEASE_REQUIRED` (no valid lease: uploads refused), `_PAYLOAD_TOO_LARGE`, `_NOT_FOUND`, `_LEASE_NOT_ISSUED`, `_RATE_LIMITED`.
12. **Fixtures:**
    - `fixtures/manifest.json` (the style of task6) with valid and invalid cases for every kind, the bundle, the lease, data settings and fleet configuration version 3;
    - valid finding and enforcement fixtures are **projections of real records** from Numbat's `cmd/numbat/testdata/` streams, with every path, host and user replaced by placeholders;
    - put a `NOTICE.md` in the fixtures folder naming Numbat, the commit `20a5a52` and Apache-2.0, as `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` requires.
13. **TypeScript, interface first** (AGENTS.md §5): new `apps/api/src/features/security-findings/v2-contract.ts` marked `[CONTRACT - FROZEN]`. It contains:
    - the types for every schema and constants for limits and codes;
    - `validateSecurityUploadV2(value): SecurityUploadV2` and `checkDataSettings(record, settings): void`, as **stubs that throw** `not implemented (Task20d)`.

    Task20d implements them.

### 2.2 Port from
- **Catalog:** none applies. The SushiCorp catalogue has no endpoint security contract; `trust.md` (TR-1) is consumed, not ported.
- **Third-party:** Numbat `20a5a52` record schemas (Apache-2.0). Record the source and pin in the README and in `NOTICE.md`; projected fixtures count as adapted material.

### 2.3 Pre-approved files
- `docs/contracts/security-v2/**`: README, `api.md`, `errors.md`, `*.schema.json`, `fixtures/**`;
- `apps/api/src/features/security-findings/v2-contract.ts` and `v2-contract.test.ts`, which validate every fixture against its schema with `ajv` and assert each stub throws;
- `apps/api/package.json`: the test script entry only;
- `docs/handoffs/Task20a-security-v2-contract_HANDOFF.md`;
- your own rows in `docs/plan/TASK20.md` (T20.1, Task20a) and `docs/plan/STATUS_BOARD.md` (row 9a actual).

### 2.4 Never touch
- every other path under `docs/contracts/` (frozen);
- merged migrations, `schema.ts`, `features/fleet/`, `features/security-findings/` files other than the two above;
- `docs/contracts/audit/catalog.md`: Task20f flips the reserved events through a Task16 contract PR;
- GitAI;
- `~/AIProjects/numbat`, which is read-only.

If the contract seems to need any of these, **stop and describe it** in the checkpoint.

## 3. Working rules
1. Commit `Task20a: …` at each stage.
2. **Stage 1: README and decisions table first** (what each field means, which Numbat field it comes from, which data-settings group governs it). Then the checkpoint (founder setup step 4).
3. **Stage 2: the schemas and `api.md`, `errors.md`.**
4. **Stage 3: the fixtures and the manifest.**
5. **Stage 4: `v2-contract.ts` and the test.**
6. Then `npm test`, `npm run lint`, `npm run typecheck` and `npm run check`, all clean.

**Tests:** every valid fixture passes, every invalid one fails for the reason the manifest names, and the stubs throw. There is no integration test (no database or network); say so in the handoff.

**Review:** one independent review (`/review` or a fresh thread) before the handoff, then the Task20 lead's cross-review.

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 90 lines**. It names:
  - every decision you took beyond §2.1;
  - the file list;
  - what Task20d, Task20e and Task20f must implement;
  - Effort.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape: the effort line, then one bash block:
  - `# 1.` the unit tests;
  - under `# after the cross-agent review`: `git push -u origin task/Task20a-security-v2-contract`;
  - `gh pr create --base main --head task/Task20a-security-v2-contract --title "[Task20a] Security v2 contract" --body-file docs/handoffs/Task20a-security-v2-contract_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`;
  - `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task20a-security-v2-contract`;
  - `gh pr merge task/Task20a-security-v2-contract --merge --repo mahamannu-ux/TrackAI-V1`, only after the preflight says ok.

  Then the review request for the Task20 lead (Claude) in a `text` block.
- **Founder steps are numbered**, with the expected result after each.
- **Ledger lines (AGENTS.md §9 item 23):** edit only your own rows.

## Lessons so far
- **Task6.a (Codex):** the closed-schema, refuse-unknown-fields style and the valid/invalid fixture manifest worked; keep them.
- **Task19-numbat-review (Claude):** facts not taken from the code cost review rounds. Cite `numbat@20a5a52:path:line` for every Numbat field you map.
- **Task20-plan (Claude):**
  - Numbat's finding has no repository, only an unsalted path hash, which must never leave the machine;
  - per-action ids for approvals mostly do not exist, so `join` must say `unavailable` rather than guess;
  - Task9's database check allows only configuration versions 1 and 2. You define version 3; Task20f widens the check.
