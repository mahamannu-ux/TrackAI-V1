# Handoff prompt: Task20f-security-settings-signing (rule and data settings, compiled and signed bundle, signed per-machine lease, the lease routes), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`. `main` must contain Task20d (migration `0025`, `features/security-findings/v2-authority.ts`).
> 2. **Run it as a cloud session from the terminal**, so it runs on Anthropic's cloud rather than as a local session on this Mac:
>    ```bash
>    cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only
>    claude --cloud "You are the Task20f session. Read docs/prompts/Task20/NEXT_CHAT_Task20f-security-settings-signing_PROMPT.md in this repository and follow everything below its line. This is a cloud session: push only the branch task/Task20f-security-settings-signing, never main, and never open or merge a PR."
>    ```
>    - `--cloud` clones this repository from GitHub at `main`. The Claude GitHub App must be installed on `mahamannu-ux/TrackAI-V1`; otherwise Claude Code uploads a bundle of the local repository.
>    - **Usage:** Anthropic's docs say a cloud session counts toward your plan's usage limits like any other Claude usage. A claimed cloud-session credit is applied by your account, not by this prompt, and nothing here can choose it. Check Settings > Usage after the first stage to see what was drawn.
> 3. **Checkpoints** (answer in the cloud session; send `claude -p "<answer>" --cloud <session-id>` from the terminal, or reply at claude.ai/code):
>    1. after stage 1 (the audit-catalogue contract PR text);
>    2. after stage 2 (the design note).
> 4. When it finishes, it gives you the commands to fetch its pushed branch and the review request. **Codex** reviews; this is signing and activation code, so the Task20 lead (Claude) also looks. Merge only after "ready to push".

---

You are **Claude**, building **Task20f-security-settings-signing** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task20 runs **Numbat** unchanged on developer machines. Three pieces are already merged:
- Task20a froze the security v2 contract (`docs/contracts/security-v2/`);
- Task20d stores uploads at `POST /worker/security/v2/records`, but refuses all of them through a fail-closed `SecurityV2Authority`, because no lease exists yet;
- Task20b pins and builds Numbat (in GitAI).

This session gives the CISO's settings their server side:
- per-tenant **rule settings** (on/off and severity for each of Numbat's 51 rules) and **data settings** (the five switches);
- a **compiler** that turns them into Numbat override files, one folder per agent;
- the **rule bundle**, signed with the platform `policy_bundle` key;
- a **per-machine activation lease**, signed with the `activation_lease` key, kept as history;
- the machine routes `GET /lease`, `GET /bundles/{sha256}` and `POST /acknowledgements`;
- the **real `SecurityV2Authority`**, which switches Task20d's ingest on;
- the **fleet configuration version 3** (lease reference), with its database check widened;
- one `app.ts` fix that Task20d deferred.

It does **not** build the console (Task20i), Endpoint code (Task20e, Task20g), blocking (Task20k), or new signing keys or trust layers. It consumes Task15's.

- **Repository:** `mahamannu-ux/TrackAI-V1`, cloned by the cloud session. **Branch:** `task/Task20f-security-settings-signing`, from `main`. **Handoff:** `docs/handoffs/Task20f-security-settings-signing_HANDOFF.md`.
- **Cloud-session rules (founder exception to AGENTS.md §1 rule 3):**
  - You may `git push` **only** `task/Task20f-security-settings-signing` (and the stage-1 branch `docs/Task20f-audit-events`), because a cloud session has no other way to hand work back.
  - Never push `main`, never force-push, never open or merge a PR. The founder pulls your branch.
  - You cannot reach the founder's Mac. Everything you need is in this repository, or in the public Numbat mirror `https://github.com/mahamannu-ux/numbat`, tag `v0.2.0-trackai.1`.
- **Effort and usage:** keep the session lean. Read the files named here rather than exploring broadly, and run the long test suites once per stage, not after every edit (CLAUDE.md "Effort").

## 0. Before anything else
1. **Read `AGENTS.md` and `CLAUDE.md` in full.** In particular:
   - §1 rules 1, 6, 7 and 9; §2 "Names"; §4 (Task20 row);
   - §5 (interfaces first); §5a (third-party: the rule YAML is adapted Apache-2.0 material);
   - §7; §9 items 3, 4, 9, 10, 16–23;
   - §10 (AP-1); §12.
2. `git log --oneline -1`, then `git switch -c task/Task20f-security-settings-signing`. Set `mahamannu-ux` / `mahamannu@gmail.com` for this repository only.
3. **Toolchain:** run `npm ci` and then `npm test` once. Integration databases run through `scripts/it-db.sh` in local mode: install `postgresql-16-pgvector` first (CLAUDE.md), since there is no Docker in the cloud.
4. **Clone Numbat read-only:**
   ```bash
   git clone --depth 1 --branch v0.2.0-trackai.1 https://github.com/mahamannu-ux/numbat /tmp/numbat
   ```
   Then check that `git -C /tmp/numbat rev-parse HEAD` is `20a5a52bab41c9bf6ee857efd43c7b198b055de5`, or stop.
5. **Estimate:** one line against T6. The plan says **about 0.30×**. If you see more than 0.4×, propose a split at checkpoint 2: (a) settings, compiler and bundle; (b) leases, routes, authority and fleet v3.

## 1. Read before writing
- **Task20:**
  - `docs/plan/TASK20.md` §1, §3, §5 (your row) and §9;
  - `docs/plan/primers/Task20_PRIMER.md` facts 2, 3 and 9, and the "Founder decisions" fallback table.
- **The contract**, in full: `docs/contracts/security-v2/`, above all the README sections "Rule bundle and activation lease", "Lease acknowledgement" and "Fleet configuration schema version 3", plus `api.md` routes and isolation cases 3–8.
- **Task20d:**
  - `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md`, especially decision 3, the deferred 5 MiB parser;
  - in `features/security-findings/`: `v2-authority.ts`, `v2.routes.ts`, `v2-storage.ts` and `security-findings.routes.ts` (`createSecurityFindingsRouter({ v2Dependencies })`).
- **The trust layer, which you consume:**
  - `docs/contracts/attesta/trust.md`, especially "Hierarchy", "Consumers" and "Verification";
  - `envelope.md`;
  - in `features/attesta/`: `signer-contract.ts`, `signer-resolver.ts`, `signer-kms*.ts`, `trust-inventory.ts`, `trust-resolver.ts`, `attesta-keys-cli.ts`, `anchor-env.ts` (how the platform `anchor` key is resolved: copy that pattern for `policy_bundle` and `activation_lease`), `dsse.ts` and `canonical.ts`;
  - the vectors folder `vectors/trust/` (`03-good-activation-lease.json` and the `policy_bundle` cases).
- **Fleet:**
  - `features/fleet/{contract,service}.ts` and `fleet.test.ts`;
  - `core/db/schema.ts:330-380` (`fleet_configurations` and its checks at `:350` and `:352`);
  - `docs/plan/TASK9.md` decision 10.
- **Audit:**
  - `docs/contracts/audit/catalog.md:60-80` (reserved `fleet.lease.issued`, `fleet.lease.refused`, `policy.bundle.*`, `security.monitor.changed`);
  - `core/audit/catalog.ts`;
  - `features/audit/` (how events are written).
- **The app:** `apps/api/src/app.ts:55-70` (the global `express.json({ limit: '5mb' })` before `/worker` authentication).
- **Numbat:**
  - `/tmp/numbat/rules/*/*.yaml` (51 files);
  - `docs/rules.md:100-125` and `:630-660` (fields; a same-id replacement replaces the whole file; `enabled: false`);
  - `docs/enforcement.md:54-66`.

## 2. Scope (approved by the founder)
### 2.1 Decisions
1. **Stage 1: audit contract PR first, a separate small branch** (`docs/Task20f-audit-events`, pushed as above). It contains an additive change to the frozen `docs/contracts/audit/catalog.md`:
   - flip `fleet.lease.issued`, `fleet.lease.refused`, `policy.bundle.published` and `policy.bundle.acknowledged` from reserved to active, with owner Task20;
   - widen `security.monitor.changed`'s mode to include `monitor_and_pilot_block`;
   - add `security.settings.changed` (rule or data settings published; details: settings version, bundle version, epoch, `changed_rule_count`, data-settings booleans).

   `policy.bundle.activated` stays reserved: monitor mode needs no separate activation. Make the matching additive entries in `core/audit/catalog.ts` in the main branch, after the founder approves stage 1.
   **Checkpoint 1:** send the PR text to the founder (the Task16 owner reviews it).
2. **Catalogue as data.**
   - Copy the 51 rule YAML files at the pin, byte for byte, into `apps/api/src/features/security/catalogue/20a5a52/<group>/<file>.yaml`.
   - Add a generated `manifest.json` (rule id, group, path, SHA-256, upstream `version`, `severity`, `enabled`) and a `NOTICE.md` (Numbat, commit, Apache-2.0, "modified by TrackAI" for compiled outputs).
   - Add a script `catalogue-import.ts` that regenerates both from a Numbat checkout and refuses a non-pinned commit.
   - Add a test that the manifest matches the files and that the count is 51.
3. **Rule settings,** versioned per tenant, one active version, history kept (append-only). Each rule gets `{enabled: boolean, severity: info|low|medium|high|critical}`. There is no per-agent block switch yet (Q10: block switches arrive with Task20k); the stored shape leaves room for `mode_by_agent` later as an additive field.
   - **Default policy** (TASK20.md §1 item 7): all 51 at their upstream severity, **enabled except these 7**:
     - `exec.agent_runtime_bypass_flags`, `integrity.git_hooks_bypass`, `persistence.git_hook_write`;
     - `privilege.container_runtime_socket_access`, `secrets.agent_read_env`;
     - `source.git_config_exec`, `source.git_remote_tamper`.
4. **Data settings,** versioned per tenant, the five switches of `trackai.security-data-settings/1`, all default `false`. A tenant with no row gets the defaults.
5. **Compiler** (pure function, unit-tested). Input: the catalogue, the tenant's rule settings, and the agents list from item 7. For each agent:
   - Write **one override file only for a rule that differs from upstream**. Rules equal to upstream ship no file; Numbat's embedded catalogue applies.
   - An override is the complete upstream YAML (a same-id replacement replaces the whole file, `numbat@20a5a52:docs/rules.md:630-634`), with only these top-level scalars changed:
     - `enabled: false`, when off;
     - `severity: <new>`, when changed;
     - `version: "<upstream>-trackai.<n>"`, where `n` is the tenant's rule-settings version.
   - Add a first comment line: `# Modified by TrackAI (Task20f) from perplexityai/numbat@20a5a52 <path>; Apache-2.0`.
   - Edit those keys as text, line by line. Every one of the 51 files has them as plain top-level scalars; add a test that asserts this, and fail loudly if a future pin breaks it. No new YAML dependency.
   - `enforce` is never set in this session.
   - The output paths are `<group>/<file>.yaml`. The bundle's `enabled_rule_ids` is the effective enabled set.
6. **Bundle.**
   - **Payload:** `trackai.security-rule-bundle/1` exactly as the contract schema says: tenant, `bundle_version`, `epoch` (monotonic per tenant, never reused), `issued_at`, `numbat_pin`, `compiler_version`, and per agent its files and enabled ids.
   - **Serialization:** RFC 8785 canonical bytes (`canonical.ts`), within the size limits (256 KiB per file, 4 MiB in all).
   - **Signing:** a DSSE envelope signed by the platform `policy_bundle` key through the signer contract (verify before use). Use the dev signer in tests; in production, the key is resolved like `anchor-env.ts` resolves `anchor`, and fails closed with no key.
   - **Storage:** the exact envelope bytes and the digest (SHA-256 of the payload bytes).
   - **Publishing:** a publish creates one bundle for the new settings version, writes `security.settings.changed` and `policy.bundle.published`, and is dry-run first (AGENTS.md §9 item 10: it prints the changed rules and the affected machine count, and needs `--confirm` in the CLI form).
7. **Agents.** The first wave is `claude-code`, `codex`, `cursor`, `gemini-cli` and `copilot-cli`, as Numbat names them in `source_agent`. Check them against the contract's `SecuritySourceAgent` and use those spellings. Every bundle carries all five folders; the lease's `agents` selects the active ones.
8. **Leases.**
   - **Payload:** per machine, `trackai.security-activation-lease/2` with:
     - tenant, machine and a new `lease_id`;
     - `issued_at`, and `expires_at` = issued + 72 h;
     - `mode` `off` or `monitor` (from the tenant's monitor setting; `monitor_and_pilot_block` is accepted by the schema but never issued here);
     - the agents, the current bundle digest, the current data settings, and `day_one_scan` (default `false`; tenant setting).
   - **Signing:** with the `activation_lease` key, the same way as the bundle.
   - **Issuance is lazy:** `GET /lease` returns the newest stored lease if it is less than 1 h old and still valid for the current bundle and settings; otherwise it issues, stores and returns a new one, writing `fleet.lease.issued`.
   - **Storage:** leases are append-only and kept for provenance (Task20d's `leaseForMachine`).
   - **Revocation:** a revoked or inactive machine gets no lease (`SECURITY_V2_LEASE_NOT_ISSUED`).
9. **Machine routes,** in the v2 router (`createSecurityV2Router` dependencies) or a sibling router mounted the same way, exactly as `api.md` describes, and following isolation cases 3–8:
   - `GET /worker/security/v2/lease`;
   - `GET /worker/security/v2/bundles/{sha256}`;
   - `POST /worker/security/v2/acknowledgements`, which stores the result and writes `policy.bundle.acknowledged` or `fleet.lease.refused` with the refusal code.

   Tenant and machine come only from the credential, and a foreign resource answers like a missing one.
10. **Real authority.** Implement `SecurityV2Authority` over your lease and data-settings tables (`currentLease`, `leaseForMachine`, `currentDataSettings`), and pass it to `createSecurityFindingsRouter({ v2Dependencies: { authority } })` in the production mount. Task20d's ingest then accepts records under a valid lease.
11. **The `app.ts` fix (Task20d decision 3).** Exclude `/worker/security/v2` from the global `express.json({ limit: '5mb' })`, so machine authentication runs before the body is parsed and the v2 router's own 4 MiB limit applies. Keep it minimal, for example: skip the global parser when `req.path` starts with `/worker/security/v2`. Every other route keeps its current parser. Add an in-process test that an unauthenticated 4.5 MiB v2 request is refused before parsing, and that the 4 MiB limit holds.
12. **Fleet configuration version 3.**
    - **Code and checks:**
      - `features/fleet/contract.ts`, `service.ts` and `fleet.test.ts`: version 3 replaces `securityActivation` with `securityLease {leaseId, bundleDigest, expiresAt}`, following the contract's `fleet-configuration-v3.schema.json`;
      - versions 1 and 2 stay readable, with their activation treated as `off`;
      - `fleet_configurations_schema_version_check` (`schema.ts:350`) is widened to `(1, 2, 3)`;
      - `fleet_configurations_release_contract_check` (`:352`) is extended so version 3 carries version 2's release fields.
    - **When version 3 is written:** a new configuration for a machine is written as version 3 when the tenant has security monitoring on, referencing the machine's current lease.
    - **Review:** Codex reviews these files as Task9's owner.
13. **Migration,** one, generated on a fresh `main` (the next number after `0025`). It creates:
    - `security_rule_settings_versions`;
    - `security_data_settings_versions`;
    - `security_rule_bundles` (envelope bytes, digest, epoch, version, unique `(tenant_id, epoch)` and `(tenant_id, digest)`);
    - `security_activation_leases` (envelope bytes, machine, issued, expires, bundle digest);
    - `security_acknowledgements`.

    Plus the two fleet checks of item 12. Every table follows the tenant rules: `withTenant()`, RLS with no browser policies, composite tenant keys, append-only history, and Company A/B tests.
14. **Admin API,** minimal, for Task20i to build on:
    - `GET /api/admin/security/settings` (current rule settings, data settings, bundle and epoch);
    - `PUT /api/admin/security/settings` (a dry-run body flag, then apply; returns the new versions).

    It uses `requireAdminAction` with the existing security admin action, or one new action added to the catalogue in stage 1. It follows AP-1, sends `no-store`, and is audited.

### 2.2 Port from
- No SushiCorp module applies beyond what Task15 already ported: the trust layer is consumed, not ported.
- Numbat rule YAML is adapted material. Keep the `NOTICE.md`, the per-file header, and the pin (`docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` "Task20: binary redistribution").

### 2.3 Pre-approved files
- New `apps/api/src/features/security/**`: catalogue, settings, compiler, bundle, lease, authority, routes, CLI, tests, `task20f-signing-live-verify.ts`.
- The v2 router wiring in `features/security-findings/{v2.routes,security-findings.routes}.ts`: dependency injection only.
- `features/fleet/{contract,service}.ts` and `fleet.test.ts` (item 12).
- `core/db/schema.ts` (the new tables and the two fleet checks only), one migration and its `meta/`.
- `apps/api/src/app.ts` (item 11 only).
- `core/audit/catalog.ts` (the stage-1 entries, after approval).
- `docs/contracts/audit/catalog.md` (stage-1 branch only).
- `apps/api/package.json` (scripts, in alphabetical order).
- The handoff, your own rows in `docs/plan/TASK20.md` (T20.8, Task20f) and in `docs/plan/STATUS_BOARD.md` (row 9f, IT-T20f-01).

### 2.4 Never touch
- `docs/contracts/security-v2/**` and other frozen contracts (except the stage-1 audit PR);
- merged migrations;
- `features/attesta/**` (use only), `features/qa/**`, the web app;
- GitAI.

If you need any of these, stop and describe it at a checkpoint.

## 3. Working rules
- **Stages,** each committed (`Task20f: …`) and pushed to the task branch:
  1. the audit contract PR (checkpoint 1);
  2. **the design note** in the handoff draft, covering the tables, issuance rules, the compiler edits, key resolution and the `app.ts` change (**checkpoint 2**);
  3. the catalogue and compiler with tests;
  4. settings and bundle signing;
  5. leases, routes and the authority;
  6. fleet version 3;
  7. the `app.ts` fix;
  8. the live verify;
  9. the handoff.
- **Tests,** in-process, real services, the dev signer:
  - compiler golden tests;
  - bundle bytes verify with the TypeScript `verifyTrusted` against a test trust state (purpose `policy_bundle`, audience `platform`); a tampered payload is rejected;
  - the lease likewise (`activation_lease`);
  - an epoch that only goes up; lazy issuance; lease history;
  - every `api.md` isolation case 3–8;
  - Task20d ingest accepting records under an issued lease and refusing them after expiry;
  - fleet versions 1/2/3, and the database check through the migration;
  - the `app.ts` test.
- **IT-T20f-01** (blocking for this merge): `scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api`. It covers settings → publish → signed bundle and lease → retrieval → acknowledgement → an ingest upload accepted → Company A/B and machine X/Y → audit rows. Run it once, small, here. **IT-T20f-02** (production KMS keys) waits for Task15n; leave it ⬜.
- **Review:** an independent review subagent before the handoff (CLAUDE.md "Reviews"), then Codex.

## 4. Close-out
- **The handoff,** under 100 lines, naming:
  - the routes and tables;
  - the authority wiring;
  - the compiler rules;
  - what Task20g must verify on the Endpoint (epoch, digest binding, lease freshness, refusal codes);
  - what Task20i reads (the admin API);
  - Effort.
- Push the final branch. Do not open a PR.
- **Final reply** in the AGENTS.md §12.4 shape, with one numbered bash block for the founder:
  1. `cd ~/AIProjects/TrackAI-v1 && git fetch origin task/Task20f-security-settings-signing docs/Task20f-audit-events`;
  2. make a worktree from it, `npm ci`, `npm test`;
  3. `scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api`;
  4. under `# after the cross-agent review`:
     - the two `gh pr create --base main --head … --repo mahamannu-ux/TrackAI-V1` commands (audit contract first);
     - `scripts/pr-preflight.sh`;
     - `gh pr merge … --merge`.

  Then the review request in a `text` block, for Codex.

## Lessons so far
- **Task20a/20d:** tenant and machine come only from the credential, a foreign resource answers like a missing one, and the server refuses rather than strips.
- **Task15l (Claude):** a missing key is `unavailable` and never a pass; a production build hard-codes `production: true`.
- **Task15i2 (Claude):** sign the exact canonical bytes and store them; never re-serialize to verify.
