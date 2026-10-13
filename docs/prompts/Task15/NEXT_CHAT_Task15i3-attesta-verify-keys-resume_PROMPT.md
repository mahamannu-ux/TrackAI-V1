# Handoff prompt: Task15i3-attesta-verify-keys-resume (key-validity windows in /verify, audited anchor resume), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Task15i2 is merged. Merge the PR that adds this prompt (`docs/Task15-prompts-i3`). Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line.
> 3. Checkpoint: after its design note (step 2.2) it sends you one short note; answer in plain words.
> 4. When it finishes, paste its review request to **Codex** (or Muse with the attack-style request, as for 15i2). Push only after "ready to push". Muse's `Task15j-attesta-verifier` can run at the same time (no shared files). `Task15i4-attesta-period-report` starts after this merges.

---

You are **Claude**, building **Task15i3-attesta-verify-keys-resume** (A15.9, the two items carried over from Task15i2) for **TrackAI**, an AI code provenance product built on a fork of Git AI. Attesta signs, chains and anchors one statement per commit, merged PR and deployment. The evidence API is merged:
- Task15i: the read routes and the audited `/verify`.
- Task15i2: evidence packs, and real published keys in `/verify`.

This session closes the two gaps Task15i2 left:
1. `/verify` accepts every key the tenant ever activated, **at any time**. A statement signed after a key was retired or compromised still shows `ok`. Trust.md step 8 says it must not.
2. A batch stopped by a terminal anchoring code (`LOG_REJECTED`, `LOG_KEY_NOT_PINNED`) cannot be resumed. The founder decided in Task15f2 that resuming needs an audited operator action.

No period report (Task15i4). No route for resume (operators only).

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles go in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task15i3-attesta-verify-keys-resume`.
- **Handoff:** `docs/handoffs/Task15i3-attesta-verify-keys-resume_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §5, §7, §9 items 3, 4, 10, 16–21, §12.4) and `CLAUDE.md`.
2. Send the founder one request for folder access: `~/AIProjects`, plus `~/dev/sushicorp` and `~/dev/agent-kit` read-only. Ask once for delete permission on `~/AIProjects`, for the bundles. Clone `main` from a bundle, run `npm ci` and `npm test` once (expect at least 791 pass), and install `postgresql-16-pgvector`.
3. Estimate in one line against T6. The plan says **about 0.12×**. If the design note shows more than 0.18×, say so and propose what to drop.

## 1. Read before writing
- **Binding:**
  - `docs/contracts/attesta/trust.md`: "Verification" step 8, "Time evidence", "Consumers".
  - `errors.md`: §Verification, §Anchoring.
  - `tables.md`: anchors and the stopped-batch rule.
  - `api.md`: the `/verify` row; it says key windows are not applied yet, and this session changes that.
- **Handoffs:**
  - `Task15i2-attesta-evidence-packs_HANDOFF.md`: Known limitations and Integration notes.
  - `Task15f2-attesta-anchoring-worker_HANDOFF.md`: Known limitations; stopped batches.
  - `Task15l2-trust-inventory_HANDOFF.md`: `publishedKeysFor`, `platformKeyWindows`, `checkDocumentChain`.
- **Code** (`apps/api/src/features/attesta/`):
  - `verify-chain.ts`: `checkEnvelope`, `AnchorChecker`, `anchorTimeMs`.
  - `read-service.ts`: `publishedKeySource`, `verifyRange`.
  - `anchor-worker.ts`: `planTenant`, the pg store's `stoppedBatch` and `terminal_code` SQL.
  - `trust-resolver.ts` and `trust-inventory.ts`: use only.
  - `trust-documents.ts`: `parseTrustDocument`.
  - `attesta-keys-cli.ts`: the dry-run / `--confirm` / `--expect` / `--actor` pattern to copy.

## 2. Scope
### 2.1 Lead decisions
1. **Key windows in `verify-chain.ts` (additive):**
   - **New option** `VerifyChainOptions.keyWindows?: Record<keyid, { notBeforeMs; notAfterMs; untilMs: number | null }>`. `untilMs` is `revoked_at` for a retired or superseded key, `compromised_since` for a compromised one, and `null` for an active key.
   - **When to check:** only when `keyWindows` is supplied and the record's keyid is in it, and only after its signature has verified.
   - **Passes:** `recorded_at` lies in [notBefore, notAfter], and either `untilMs` is null or a **verified** anchor of the record (a rekor `integratedTime` or a tsa `gen_time` that `verifyStoredAnchor` accepted, so `AnchorChecker` must run first or expose its result) is earlier than `untilMs`.
   - **Fails:** new break kind `key_not_valid_at` with the new code `ATTESTA_VERIFY_KEY_NOT_VALID_AT` (errors.md §Verification, additive).
   - **No anchor material:** a record whose key has `untilMs` adds the warning `key_windows_not_checked`, and the report is never `ok`.
   - `CHAIN_REPORT_VERSION` stays 2; the break kind is new, the shape is not.
2. **Where the windows come from:**
   - Add `publishedKeyWindowsFor(store, tenantId, config)` in `read-service.ts`. Do not edit `trust-resolver.ts`.
   - Take the tenant's key sets and the roots, run `checkDocumentChain(config, now, roots, { tenantId, documents })` (no verified chain → no windows, and the report says `signatures: not_checked`), then parse the **newest** key set. Each statement key entry becomes a window.
   - The keys passed to verify are exactly that key set's keys, so `publishedKeySource` changes to read from the verified documents, not the inventory rows.
   - Wire it into `createAttestaRouter` as the default. Keep the `keys` seam for tests.
3. **Anchor resume (Task15f2 decision; was 15i2 item 7):**
   - **Migration `0021`** (verify the number): table `attesta_anchor_resumes`, append-only.
     - Columns: `id`, `tenant_id`, `batch_id` (composite FK `(tenant_id, batch_id)` to `attesta_anchor_batches`), `actor`, `reason` (1–256), `request_id`, `created_at`.
     - RLS on, no browser policies, composite keys.
     - Guards in the 0017–0020 style (`SECURITY DEFINER`, fixed `search_path`, ERRCODE `ATG01`; no UPDATE, DELETE or TRUNCATE).
     - Insert guard: the batch's latest failed attempt has a terminal code, and no resume row is newer than that attempt (one resume per stop).
   - **CLI:** `npm run attesta:anchor-resume -w apps/api -- --tenant <uuid> --batch <batch_id> --actor <name> --reason <text> [--confirm=RESUME]`.
     - Dry run by default: prints the batch, its terminal code and its record count.
     - With `--confirm=RESUME`, in one transaction: one `attesta_anchor_resumes` row and one `security_audit_events` row (`attesta.anchor.resume`).
     - A batch that is not stopped is refused with a clear message.
   - **Worker (`anchor-worker.ts`, the resume rule only):** a batch is stopped only while its latest terminal failure is newer than its latest resume row. Change `stoppedBatch`, the `terminal_code` aggregate and `tenants()`. `planTenant` is unchanged; it reads `terminalCode` from the store.
   - After a resume the batch is retried once with the normal backoff. A new terminal failure stops it again.
4. **Contract tidy-ups (additive):**
   - `errors.md`: the new verify code.
   - `api.md`: the `/verify` row now says windows are applied.
   - `tables.md`: an `attesta_anchor_resumes` row and the resume rule (lead-approved).

### 2.2 Design checkpoint (stop once)
Send the founder a short note:
- the key-window rule in three lines, with one worked example: key retired 10:00; a statement recorded 10:05 and anchored 10:07 fails, one anchored 09:58 passes;
- the resume flow;
- the estimate.

Continue on his answer.

### 2.3 Port from
- SushiCorp @ `0bd67a5` `core/trust/revocation.py`: REVOKED > CLEAN > UNKNOWN; never treat "unknown" as clean.
- SushiCorp `MODULE_A2b_HANDOFF.md`: operator recovery of stopped anchors.
- Catalog TR-1 and EV-2.
- Key windows are TrackAI's own (trust.md step 8): port the rule's tests from `trust-verify.test.ts` and the trust vectors' `KEY_NOT_VALID_AT` and `KEY_REVOKED` cases.

### 2.4 Pre-approved files
- **Contract:** `docs/contracts/attesta/errors.md` (§Verification addition), `api.md` (the `/verify` row), `tables.md` (the resume table).
- **Database:** `apps/api/src/core/db/schema.ts` (the one table) and one new migration with its `meta/` snapshot.
- **Attesta code** (`apps/api/src/features/attesta/`), each with its tests:
  - `verify-chain.ts`, `read-service.ts`, `attesta.routes.ts` (the default key source only), `anchor-worker.ts` (the resume rule only);
  - new `attesta-anchor-resume-cli.ts`;
  - new `t15i3-verify-keys-resume-live-verify.ts`.
- `apps/api/package.json` (scripts only).
- **Docs:** the handoff, `docs/plan/STATUS_BOARD.md`, `docs/plan/TASK15.md` (A15.9 row and §5 actual).

### 2.5 Never touch
- Other contract files.
- Merged migrations `0000`–`0020`.
- In `apps/api/src/features/attesta/`: `ledger.ts`, `builder.ts`, `worker.ts`, `trust-*.ts`, `anchor-rekor.ts`, `anchor-tsa.ts`, `anchor-dual.ts`, `evidence-pack-service.ts`.
- `core/operations`, `core/middleware`, `app.ts`, `apps/web/`, dependencies.

## 3. Working rules
- **Commits:** `Task15i3-attesta-verify-keys-resume: …`, in this order: ported tests; contract; verify windows; key source; migration; worker rule; CLI; live test; handoff.
- **Unit tests:**
  - Every window case: active key inside its validity; outside `not_after`; retired with an anchor before and after `revoked_at`; superseded; compromised with anchors before and after `compromised_since`.
  - A failed anchor never counts as time evidence; `key_windows_not_checked` without anchor material.
  - A key set that does not verify gives `signatures: not_checked`, never `ok`.
  - Resume: dry run, apply, a non-stopped batch refused, two resumes for one stop refused, a new terminal failure stops the batch again.
- **Live:** `scripts/it-db.sh npm run verify:task15i3-verify-keys-resume-live -w apps/api`.
  - `IT-T15i3-01`: rotate a key with the CLI. A statement signed by the old key before its retirement and anchored → `/verify` ok. One recorded after `revoked_at` with no earlier anchor → `KEY_NOT_VALID_AT`.
  - `IT-T15i3-02`: revoke compromised. Statements anchored before `compromised_since` pass; later ones break.
  - `IT-T15i3-03`: a batch stopped by `LOG_REJECTED` (via the fake) is resumed by the CLI, audited, and anchors on the next pass. A second resume without a new stop is refused by the guard, as the API role and as an RLS-bound role.
  - `IT-T15i3-04`: Company A/B. B cannot resume A's batch; A's windows never come from B's key set.
  - Run each once in the sandbox, and re-run the IT-T15i and IT-T15i2 regressions.
- **Review:** one review subagent before the handoff. Ask it first: "which signature does /verify now accept that trust.md step 8 rejects, or reject that it accepts?", then "can a resume row restart a batch it should not?". Budget one cross-review round.

## 4. Close-out
- **Handoff:** under 80 lines.
- **Tracking:** `TASK15.md`; status board and registry rows.
- **Delivery:** bundle; PR via `git show <branch>:<handoff> | gh pr create … --body-file -`.
- **Final reply:** in the AGENTS.md §12.4 shape, with an attack-style review request in a `text` block (as for 15i2: concrete attacks, each with a reproduction).

## Lessons so far
- **Task15i2 (Claude):** the review subagent found two must-fixes in the *test oracle*, not the product: trust-document order and rollback. Test helpers that judge security deserve the same review as product code.
- **Task15i2 (founder):** Muse finds issues when the request lists attacks to execute and asks for a reproduction per attack. A "please review" request finds nothing.
- **Task15l2 (Claude):** give every fixture one injected clock. Here, every window test computes its times from one `T0`.
- **Task15i (Claude):** validate every path and header before it reaches the store.
- **Task15f2 (Claude):** exercise the real environment path once in the live test (`ATTESTA_TRUST_ROOT_KEYIDS`, `ATTESTA_DEV_CREDENTIALS_FILE`, the `attesta:keys` CLI, as IT-T15i2 does).
