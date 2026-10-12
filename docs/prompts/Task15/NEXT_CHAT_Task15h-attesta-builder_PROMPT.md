# Handoff prompt: Task15h-attesta-builder (outbox → statement → signed → chained), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line. It can run at the same time as `Task15f-attesta-anchoring` (Claude) and `Task15g-attesta-kms` (Muse): no shared files.
> 3. When it finishes, paste its review request to **Codex** (it reads Task2's tables, which Codex owns; Muse if Codex is busy). Push only after "ready to push".

---

You are **Claude**, building **Task15h-attesta-builder** (subtask A15.8) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Everything Attesta needs to produce its first real signed statement is merged: the primitives, the tenant-bound signer contract and dev signer, the frozen contract (`docs/contracts/attesta/`), Task2's outbox writes (A15.7) and the hash-chained ledger with `chainStatement` (A15.3). This session builds the **worker** that turns each `attesta_subjects` row into an `ai-provenance/v1` statement, signs it and chains it. It does not anchor (A15.5), serve routes (A15.9) or hold production keys (A15.6, A15.12).

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task15h-attesta-builder`.
- **Handoff:** `docs/handoffs/Task15h-attesta-builder_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §7, §9 items 3, 8, 16–20, §12.4) and `CLAUDE.md`.
2. One request to the founder for folder access to `~/AIProjects/TrackAI-v1` and `~/AIProjects/_bundles` (plus delete permission on `_bundles`). Clone `main`, `npm ci`, `npm test` once (444 expected). Install `postgresql-16-pgvector` for `scripts/it-db.sh`.
3. Estimate one line against T6. The plan says **about 0.2×** (0.1× in the tracker; raised because three statement kinds, size truncation, the claim/retry protocol and an end-to-end live test are four surfaces; Task15c and 15d each ran 1.25–1.5× on similar scopes). If you expect more than 0.25×, propose a split (for example `pr_merged`/`deployed` in a follow-up).

## 1. Read before writing
- **Binding:** `docs/contracts/attesta/envelope.md` (builder steps 1–7, verbatim the algorithm you implement), `fields.md` (the only allowed source for each field, rules 1–3, and B1–B3), `outbox.md` (worker protocol: claim, success, retryable and terminal failure, lease recovery, audited re-queue), `errors.md` (Builder, Signer, Ledger codes), `statement-v1.schema.json`, `predicate-ai-provenance-v1.schema.json`, `README.md`.
- **Merged code:** `features/attesta/{canonical,dsse,signer-contract,signer-local-dev,outbox,contract-rules,ledger}.ts`, and the fixture test harness in `contract-fixtures.test.ts` (reuse its Ajv setup to validate the snapshot).
- **Handoffs:** `Task15d-attesta-ledger_HANDOFF.md` ("Integration notes": call order, reading `claimed_at` with microseconds, retryable mapping), `Task15c-attesta-contract_HANDOFF.md`, `Task2-attesta-trigger_HANDOFF.md`.

## 2. Scope (approved)
### 2.1 Decisions
1. **Signer resolution (interface first, AGENTS.md §5):** `apps/api/src/features/attesta/signer-resolver.ts` exports `interface SignerResolver { resolve(tenantId: string): Promise<{ adapter: SigningAdapter; credentialId: string } | null> }`. `null` → the row fails with `ATTESTA_SIGNER_NO_CREDENTIAL` (terminal until configured, re-queued by the audited action). Ship one implementation, `devSignerResolver(...)`, backed by `LocalDevSigner`, which refuses production exactly as the dev signer does. The KMS adapters (A15.6) and the trust layer (A15.12) supply production resolvers later; nothing else changes.
2. **Builder:** `apps/api/src/features/attesta/builder.ts`: `buildStatement(readTx, subjectRow): Promise<{ statement; canonical; digest; previousSeen }>` for all three kinds, following `fields.md` field by field (cite the row for each), with availability on every field and the v1 `unavailable` fields exactly as the schema forces them. Steps 2–4 of `envelope.md`: canonicalize, validate the parsed snapshot (schema + `checkStatementRules`), shrink `files.entries` with `partial` / `entries_truncated` until `pae(...)` fits `maxPayloadBytes`, else `ATTESTA_BUILDER_TOO_LARGE`. Never drop a field to fit.
3. **Worker:** `apps/api/src/features/attesta/worker.ts`: `runBuilderPass(db, resolver, { limit, now, leaseMs = 600_000, maxAttempts })`. One pass: recover claims older than the lease; claim with the `FOR UPDATE SKIP LOCKED` statement in `outbox.md`; for each row, outside any transaction: read sources and build (one read transaction; `as_of` = its `now()`), resolve the signer, `signVerified` the PAE bytes; then `db.transaction(tx => chainStatement(tx, …))` with the claim read back with microseconds. Map every outcome to the protocol: retryable codes → `pending` with exponential backoff on `not_before` and `last_error_code`; terminal → `failed`; `CLAIM_LOST` → stop that row; `DUPLICATE_STATEMENT` → done. The worker runs across tenants but every read and write is tenant-bound to the row's `tenant_id` (`withTenant`). A CLI `npm run attesta:build -w apps/api` runs one pass (`--loop` with a sleep for local use); production scheduling is Task14's.
4. **Audited re-queue:** `npm run attesta:requeue -w apps/api -- --tenant <id> --code <ATTESTA_…> [--confirm=REQUEUE]`: dry-run by default (prints counts only), then moves matching `failed` rows to `pending` as `outbox.md` says and writes one `security_audit_events` row per run (actor, tenant, code, count; no IDs of customer content). AGENTS.md §9 item 10.
5. **No raw content anywhere:** the builder reads the Git AI note only to derive `note_digest`, file hashes and counts; it never logs or stores note text, paths, messages or emails. Logs carry codes and counts only.

### 2.2 Port from
None for the builder (SushiCorp builds decision records, not in-toto statements); the worker's claim/lease/backoff pattern follows `outbox.md`, written in Task15c from SushiCorp's anchoring worker (`services/anchoring/service.py` @ `0bd67a5`, catalog EV-2). Say so in the file header.

### 2.3 Pre-approved files
`apps/api/src/features/attesta/{signer-resolver,builder,worker}.ts` with tests, two CLI scripts under `apps/api/src/features/attesta/`, a live verifier `t15h-builder-live-verify.ts`, `apps/api/package.json` (scripts only), `docs/handoffs/Task15h-attesta-builder_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row, registry rows), `docs/plan/TASK15.md` (A15.8 status).

### 2.4 Never touch
`docs/contracts/` (frozen; if a field's source looks wrong, stop and report it), every migration (none is needed: if one seems to be, stop and ask), `outbox.ts`, `ledger.ts`, `verify-chain.ts` (Task15f is changing it), Task2/Task4 files, `apps/web/`, dependencies.

## 3. Working rules
- Commits `Task15h-attesta-builder: …`: resolver interface; builder per kind; worker and protocol; CLIs; live test.
- **Unit tests:** every fixture in `docs/contracts/attesta/fixtures/` named `valid-*` is reproduced byte for byte by the builder from equivalent seeded rows, with the clock and builder version injected to the fixture's `as_of` and `builder` (the strongest check that the builder matches the frozen contract; if a fixture cannot be reproduced from any rows Task2 could write, report it as a contract finding); every `fields.md` availability branch; truncation; each error code's mapping to `pending` / `failed` / stop.
- **Live (`scripts/it-db.sh`, `npm run verify:task15h-builder-live -w apps/api`):** `IT-T15h-01` end to end: Task2 ingestion of a commit note, a merged PR and a production deployment → outbox rows → one pass → three chained statements whose envelopes verify, `verifyChain` with the dev key `ok`, `previous` linking the PR and deployment statements to the commit statement; `IT-T15h-02` replay and crash: a second pass adds nothing; a worker killed after signing and before chaining leaves the row claimed, lease recovery re-runs it, and exactly one statement exists; two workers in parallel never chain one row twice; `IT-T15h-03` failures: no credential → `failed` / `ATTESTA_SIGNER_NO_CREDENTIAL`, then re-queue (dry-run, confirm, audit row) → done; `SigningUnavailable` → `pending` with backoff; `IT-T15h-04` Company A/B: each tenant's rows build only from its own sources and chain only into its own ledger. Run each once in the sandbox.
- Before the handoff, one **review subagent** that has not seen the work: give it this prompt, `envelope.md`, `fields.md` and the diff; ask it to attack field sourcing (a value from the wrong table or tenant), the claim protocol and anything that could put raw content into a statement or log.

## 4. Close-out
- Handoff under 80 lines: interfaces (`SignerResolver`, `buildStatement`, `runBuilderPass`, CLIs), the field-by-field source check result, Integration test impact, Effort.
- `TASK15.md` A15.8 🟡; status board and registry rows. Bundle to `~/AIProjects/_bundles`; PR via `git show <branch>:<handoff> | gh pr create … --body-file -`. Final reply in the AGENTS.md §12.4 shape; review request for Codex in a `text` block.

## Lessons so far
- **Task15c/15d (Claude):** sessions with several surfaces ran over; attack the rules before writing them; read `claimed_at` with microseconds, never through `Date`.
- **Task15a/15b/15e (Muse):** validate and use one snapshot; check every claim a component returns; use an independent oracle where one exists (here: the frozen `valid-*` fixtures).
- **Task2-attesta-trigger (Codex):** persistent errors must end in a visible terminal state, never an endless retry that starves other work.
