# Handoff prompt: Task15j-attesta-verifier (the offline evidence-pack verifier, A15.10), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Task15i2 is merged. Merge the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15j-attesta-verifier && cd ~/AIProjects/TrackAI-wt/Task15j-attesta-verifier && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line. Reply "continue" if it stops. It can run at the same time as Claude's Task15i3 (no shared files).
> 3. When it finishes, paste its review request to the Task15 lead Claude chat (or TrackAI-Orchestrator). Push only after "ready to push".

---

You are **Muse**, building **Task15j-attesta-verifier** (subtask A15.10) for **TrackAI**, an AI code provenance product.

Attesta signs one statement per commit, merged PR and deployment. It chains the statements per tenant, anchors them in Rekor and an RFC 3161 timestamp authority, and exports **evidence packs**: one JSON download, `{pack, signature}`. The format is frozen in `docs/contracts/attesta/evidence-pack.md`.

This session builds the **offline verifier**: a command that an acquirer's counsel runs on a laptop with no TrackAI account and no network. Its exit code says whether the pack is genuine and complete (0), broken (1) or not checkable (2).

**Every decision is made below; do not redesign.** No database, no network, no routes, no changes to existing files except the ones listed.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15j-attesta-verifier`, branch `task/Task15j-attesta-verifier`.
- **Handoff:** `docs/handoffs/Task15j-attesta-verifier_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §5a, §6, §9 items 16–21, §11, §12.4.
2. Check where you are:
   - `pwd && git branch --show-current && git log --oneline -1`: you must be in the worktree above on `task/Task15j-attesta-verifier`; otherwise stop.
   - `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (at least 791 pass).
4. Estimate in one line against T6. The plan says **about 0.1×** (0.08× plus the anchor and trust wiring).

## 1. Read
- **Contract (binding):** `docs/contracts/attesta/evidence-pack.md`, all of it, and especially "What a verifier checks", which is your checklist. Also:
  - `trust.md`: "Verification", "Time evidence", "Consumers", "First-use limit";
  - `envelope.md`: "Verifier steps";
  - `tables.md`: per-kind `inclusion_proof` shapes;
  - `errors.md`: §Verification, §Trust;
  - `README.md`: S1–S12.
- **Handoff:** `docs/handoffs/Task15i2-attesta-evidence-packs_HANDOFF.md` (Integration notes for A15.10).
- **Code** (`apps/api/src/features/attesta/`; import these, never edit them):
  - `testing/evidence-pack-oracle.ts`: your starting point, a simplified checker. Your verifier must do everything it does, plus what its header says it skips.
  - `testing/evidence-pack-fixtures.ts` and `evidence-pack.test.ts`: how good and tampered packs are made (`trustWorld`, `buildFixtureChain`, `segmentOf`, `packFor`, `resign`).
  - `trust-contract.ts` (`verifyTrusted`, the `TrustState` and `TimeEvidence` types), `trust-documents.ts` (`parseTrustDocument`).
  - `anchor-dual.ts` (`verifyStoredAnchor`, `AnchorKeyWindow`), `anchor-rekor.ts` (`loadLogPublicKey`), `anchor-tsa.ts` (`loadTrustAnchors`).
  - `canonical.ts`, `merkle.ts`, `dsse.ts`, `contract-rules.ts` (`checkStatementRules`).
  - How `builder.ts` lines 880–905 set up `ajv` for `statement-v1.schema.json`. Copy that setup; **do not import `builder.ts`**, because it pulls in the database.
- **Port source (read-only):** `git -C ~/dev/sushicorp show 0bd67a5:services/anchoring/offline_verify.py`. Its `verify_export` structure and exit codes are what you port. Also its tests: `git -C ~/dev/sushicorp grep -l offline_verify 0bd67a5 -- tests`.

## 2. Scope (approved)
### 2.1 Decisions
1. **Files (all new):**
   - `apps/api/src/features/attesta/offline-verifier.ts`: the pure function `verifyEvidencePack(download: unknown, options: OfflineVerifyOptions): OfflineReport`. No file reads, no clock reads (`options.now` is passed in), no network.
   - `apps/api/src/features/attesta/attesta-verify-pack-cli.ts`: the command. It does the reading and printing, then calls the function.
   - Tests: `offline-verifier.test.ts` and `attesta-verify-pack-cli.test.ts` beside them.
   - The script line in `apps/api/package.json`: `"attesta:verify-pack": "tsx src/features/attesta/attesta-verify-pack-cli.ts"`.
2. **Imports allowed in `offline-verifier.ts`, and nothing else:**
   - `node:crypto`, `node:fs` (schemas only), `node:path`, `ajv`, `pkijs`;
   - `./canonical`, `./merkle`, `./dsse`, `./trust-contract`, `./trust-documents`, `./anchor-dual`, `./anchor-rekor`, `./anchor-tsa`, `./contract-rules`.
   - A test walks the import graph from `offline-verifier.ts` (read each source file, follow its `from './…'` imports) and fails if anything reaches `core/`, `drizzle-orm`, `pg`, `express`, `dotenv` or `fetch(`. This proves it can be shipped standalone later (packaging is A15.13 and Task14).
3. **Options** (`OfflineVerifyOptions`), all supplied by the **user**, never from the pack:
   - `pinnedRootKeyids: string[]`, required unless `customerPins` is given.
   - `customerPins?`: `trust.md` customer pins for the pack's tenant.
   - `rekorLogKeyPem?` and `tsaAnchorsPem?`: the auditor gets these from Sigstore and from the TSA.
   - `lastTrusted?` and `trustedTimeFloor?`: from the state file.
   - `now: string`: the CLI passes the real clock.
   - `anchorWindowMs`: default 3 600 000.
4. **The checks, in the contract's order. Each produces one `{id, status, code?, count?}` entry**, where `status` is `passed` · `failed` · `not_checkable` · `warning`.
   1. **`trust_and_signature`**: call `verifyTrusted` on the pack signature with:
      - `payloadType` `application/vnd.trackai.evidence-pack+json`, purpose `statement`, audience `manifest.tenant_id`, `signedAt` `manifest.generated_at`;
      - `state` = the user's pins, `production: true` (hard-coded; never from input), the pack's `trust.root_documents` and `{[tenant]: trust.keyset_documents}`, and `lastTrusted`.

      Then check that the payload is the JCS of `{manifest, pack_digest}`, that its manifest equals the pack's, and that `pack_digest` equals the recomputed digest. `verified` → passed; `rejected` → failed; `unavailable` → not_checkable. Keep `verdict.trusted` for step 6 and the state file.

      **An expired key set or root at `now` is `unavailable`, so exit 2.** That is intended: a pack is checked when it is handed over, and an old pack is re-exported, which ships current documents. Say this in the CLI output.
   2. **`structure`**: the top-level keys and `format` are exactly v1's; the pack validates against `evidence-pack-v1.schema.json` (ajv); every section digest matches; `counts` and `completeness` agree with the content and the mode; no statement is listed twice.
   3. **`chain`**: the record checks of the contract (contiguous seq, links, record hashes recomputed, canonical form, `seq`, `prev_hash` and `tenant_id` agree, the head).
   4. **`completeness`**:
      - mode `full`: the window and boundary rules, the 5-minute settle rule, and `statements` equal to exactly the in-scope records;
      - mode `repository_only`: `not_checkable` with code `ATTESTA_VERIFY_NOT_CHECKABLE`.
   5. **`statements`**, for each one:
      - the digest; the envelope payload equals the bytes; the bytes are their own JCS (`ATTESTA_VERIFY_NOT_CANONICAL`);
      - schema plus `checkStatementRules` (`ATTESTA_VERIFY_SCHEMA_INVALID` / `ATTESTA_VERIFY_RULE_VIOLATION`);
      - then `verifyTrusted` with `signedAt` = the record's `recorded_at` and, when step 6 verified an anchor for it, `timeEvidence` = `{kind: 'rekor_integrated_time', time: <integratedTime as ISO>, binds: 'ledger_statement', digest: sha256 of the payload}`. If only the TSA verified, use `{kind: 'tsa_gen_time', time: gen_time, …}`.
      - Count failures by code; one failed statement fails the check.
   6. **`anchors`**, run before step 5 and fed into it. Each row's binding:
      - `leaf_index` = seq − seq_from, `tree_size` = leaf_count, the batch is the tenant's, the anchor time is not before `recorded_at` − 5 min;
      - then `verifyStoredAnchor` with `rekorLogKey` from the user's PEM, `rekorLogIndexOffsets` from the pack converted from decimal tree IDs to 16-hex (copy the rule from `anchor-env.ts` `parseLogIndexOffsets`; do not import `anchor-env.ts`), and `tsaAnchors` from the user's PEM;
      - `anchorKeyWindows` comes **only from the root document `verifyTrusted` returned as `trusted.platform`**: find it by digest, take its `anchor` keys, and build windows exactly as `trust-resolver.ts` `platformKeyWindows` does (copy the 6-line rule).
      - `trust.anchoring_keys` and the pack's Rekor key and TSA anchors are only cross-checked: a mismatch with the user's material is a `warning`.
      - Without the user's Rekor key or TSA anchors: `not_checkable`.
      - `anchor_status: anchored` must have both types verified; `pending` beyond `anchorWindowMs` after `recorded_at`, measured at `generated_at`, is `failed` (`ATTESTA_VERIFY_ANCHOR_MISSING`); inside the window it is a `warning`.
   7. **`reports`**: a non-empty `reports` is `not_checkable` (code `ATTESTA_VERIFY_NOT_CHECKABLE`, detail "period reports are verified from Task15i4 on").
5. **Exit:** 1 if any check failed; otherwise 2 if any is not_checkable; otherwise 0. Warnings never change the exit code.
6. **Report** (`OfflineReport`):
   - Fields: `{report_version: 1, result: 'passed'|'failed'|'not_checkable', exit_code, tenant_id, pack_id, generated_at, checks: […], counts: {records, statements, anchors_verified}}`.
   - Codes, seqs and counts only: never statement contents, never key material.
7. **CLI:** `npm run attesta:verify-pack -w apps/api -- --pack <download.json> (--root-keyid sha256:… … | --customer-pin <file>) [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--state <file>] [--json]`.
   - Prints a short human summary (one line per check) or the JSON report, and exits with `exit_code`.
   - `--state` reads `{lastTrusted, trustedTimeFloor}`. After a `passed` trust check it writes back `verdict.trusted` merged into `lastTrusted` and `trustedTime` as the floor (trust.md "Consumers"), with a write-then-rename.
   - An unreadable or invalid file is exit 2 with a clear message, never a stack trace.
   - There is no flag that turns on `allowUnpinnedRoot` or `production: false`.

### 2.2 Port from
SushiCorp `services/anchoring/offline_verify.py` @ `0bd67a5` (catalog EV-2): the per-check structure, the "nothing missing is ever a pass" rule, exit codes 0/1/2 and its tests (port the tamper cases first).

Header comment in each file: `Ported from SushiCorp services/anchoring/offline_verify.py @ 0bd67a5 (catalog EV-2)`, plus one line per deviation:
- Node instead of Python;
- the trust documents travel in the pack, but the pin is the user's;
- DSSE and in-toto instead of JCS records;
- two pack modes.

### 2.3 Pre-approved files
The files in decision 1, `docs/handoffs/Task15j-attesta-verifier_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row and IT registry rows) and `docs/plan/TASK15.md` (A15.10 status only).

### 2.4 Never touch
Everything else: no existing Attesta file (import only), no `docs/contracts/`, no migrations, `core/`, `apps/web/`, no dependencies. If something seems to need another file, stop and describe it.

## 3. Tests (node:test, in-process; build packs with `testing/evidence-pack-fixtures.ts`)
- **A good pack exits 0** in both the `full` and `repository_only` modes. `repository_only` exits 2, because completeness is not checkable.
- **Tampered packs exit 1, one test each:**
  - a record's bytes, a link, a dropped record or statement, a statement's bytes, a Merkle path, a batch root, `counts`, `completeness`, the scope, a section digest, the signature bytes;
  - a pack re-signed with `resign()` after each lie in the oracle's re-sign tests;
  - a forger's root under the user's pin; reordered or truncated key sets; another tenant's key sets.
- **Not-checkable packs exit 2:** no Rekor key or TSA anchors given; a key set expired at `now`; `reports` non-empty; a pin the pack's roots do not list.
- **Real anchors:** build anchors with the in-process fakes (`testing/fake-rekor.ts`, `testing/fake-tsa.ts`), as `anchor-dual.test.ts` and `t15i2-evidence-packs-live-verify.ts` do. Then:
  - a valid pair verifies;
  - a Rekor entry signed by an anchor key outside its window (retired before the integrated time) fails;
  - a TSA token from another root fails.
- **Key time evidence:** a statement whose key was retired, with an anchor before `revoked_at`, passes; without one, it fails with `ATTESTA_TRUST_KEY_NOT_VALID_AT`.
- **State file:** written after a pass and read back; a rollback to an older key set after the state was written is rejected.
- **Import-graph purity** (decision 2), and that the CLI exit codes equal the report's.
- **Integration tests:** none (no database). The founder's clean-machine run is A15.13.

## 4. Working rules
- Commits `Task15j-attesta-verifier: …`, with explicit `git add <path>`, in this order: ported tests, verifier, CLI, handoff.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run check` clean.
- Assume the pack is written by an attacker. Every value inside it is a claim, and only the user's pin, Rekor key and TSA anchors are trusted. For each check, write the test that would pass if you forgot the check.
- Re-read your full diff as a reviewer before the handoff (AGENTS.md §12.3).

## 5. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 70 lines: the CLI usage with a synthetic example, the check list, "Ported from", every deviation, test counts and Effort.
- Status board row; `TASK15.md` A15.10 🟡 (merging makes it ✅).
- Clean tree; do not push.
- Final reply in the AGENTS.md §12.4 shape, with the review request in a `text` block naming the branch and commit.
