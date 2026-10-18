# Handoff prompt: Task20f-security-settings-signing, part b (leases, machine routes, authority, fleet v3, app.ts fix), Claude

> **Founder setup:** none. Started as a cloud session by the part-a session on 2026-10-17, from branch `task/Task20f-security-settings-signing`. The founder fetches the branch once this part finishes.

---

You are **Claude**, finishing **Task20f-security-settings-signing** for **TrackAI**. Part a is done on this same branch. The founder split the session at checkpoint 2 and approved the whole design. **There are no checkpoints in this part:** build it, and stop only if you are genuinely blocked.

## 0. Start
1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read the original prompt, `docs/prompts/Task20/NEXT_CHAT_Task20f-security-settings-signing_PROMPT.md`, in full. Its §2.1 items 8–12, §2.3 (pre-approved files), §2.4 (never touch), §3 (tests) and §4 (close-out) are your scope and rules.
3. Read `docs/handoffs/Task20f-security-settings-signing_HANDOFF.md`: part a's results, then the **approved design note D1–D7**. D4–D7 are your design; do not re-derive them.
4. Confirm you are on `task/Task20f-security-settings-signing`, with `git log --oneline -3` showing part a's review-fix commit (`Task20f: review fixes …`). Set `mahamannu-ux` / `mahamannu@gmail.com` for this repository only.
5. **Toolchain:**
   - `npm ci`, then `npm test` once;
   - install `postgresql-16-pgvector` (apt) for `scripts/it-db.sh`, since there is no Docker;
   - the Numbat catalogue is already in the repository, so no clone is needed.
6. **Cloud rules:** push only `task/Task20f-security-settings-signing`. Never push `main`, never force-push, never open or merge a PR.

## 1. What part a already built (use it; do not rebuild it)
- **`features/security/`:**
  - `catalogue.ts`, `compiler.ts`, `settings.ts`, `bundle.ts`;
  - `signing.ts`: `signSecurityDocument`, the payload types, `SecuritySigningUnavailable`, `SecurityDocumentTooLarge`;
  - `signing-env.ts`: `securitySignerFromEnv('activation_lease')` is ready;
  - `service.ts`: `readSecuritySettings` returns `lease` (data, agents, day-one scan), `monitor` and `bundle`; also `bundleEnvelopeByDigest`;
  - `admin.routes.ts`, `settings-cli.ts`;
  - `testing/trust-fixture.ts`: a test root plus dev signers for both purposes, and `verify()` through the real `verifyTrusted` with `production: true`.
- **Migration `0026` already creates every table you need**, including `security_activation_leases` and `security_acknowledgements`, plus the widened fleet checks `(1, 2, 3)`. **Do not add a migration** unless a real gap appears; if one does, say why in the handoff.
- **Review fix that changes D4:** the v2 monitor switch is `security_data_settings_versions.monitor_mode`, and its version is the data-settings version. Never read or write Task6.a's `tenant_security_monitor_settings` for v2 (writing it would activate the Task6.a route, AGENTS.md §9 item 11). The lease table therefore has `data_settings_version` and no `monitor_version`.
- **Audit:** `fleet.lease.issued`, `fleet.lease.refused` and `policy.bundle.acknowledged` are reshaped and still `reserved` in `core/audit/catalog.ts`. Flip them to `emitted` with their real `file:line` sources, add fixtures in `audit-contract.test.ts` and update its counts, run `npm run audit:catalog -w apps/api`, and update `docs/contracts/audit/catalog.md` (regenerated).

## 2. Build (original prompt §2.1 items 8–12, as D4–D7 decide)
1. **Lease service and lazy issuance**, D4:
   - payload `trackai.security-activation-lease/2`, valid for 72 h;
   - reuse the newest lease while it is under 1 hour old, unexpired, and matches the current bundle digest and data-settings version;
   - an `off` lease carries `agents: []`;
   - a tenant with no bundle, or a machine that is not `active`, gets `SECURITY_V2_LEASE_NOT_ISSUED`;
   - sign outside any transaction; write `fleet.lease.issued` (actor `machine`).
2. **The three machine routes**, in a sibling router injected into `createSecurityV2Router` (dependency injection only), behind the existing credential check, `no-store` and `X-Request-ID` middleware:
   - `GET /lease` returns the exact stored bytes;
   - `GET /bundles/{sha256}`: a malformed, missing or foreign digest gets `SECURITY_V2_NOT_FOUND`;
   - `POST /acknowledgements`: `applied` must name the lease's digest; a refusal stores the reported digest; the answer is `204`; it writes `policy.bundle.acknowledged` or `fleet.lease.refused`; unknown fields get `SECURITY_V2_UNKNOWN_FIELD`.
3. **The real `SecurityV2Authority`**, D5:
   - `currentLease` returns the machine's newest lease, and only while it is not `off` and inside its window;
   - `leaseForMachine` returns any non-`off` lease of that machine;
   - `currentDataSettings` returns the newest data-settings row.

   Wire it, with the routes, into the production mount in `security-findings.routes.ts`.
4. **Fleet configuration v3**, D6, in `features/fleet/{contract,service}.ts` and `fleet.test.ts`:
   - a configuration created while v2 monitoring is on is stored as `schema_version = 3`;
   - its `securityLease` is resolved when the configuration is served, from the machine's current lease (issued lazily);
   - no lease → `409 state_conflict`;
   - v1 and v2 are unchanged. The audit `fleet_configuration.created` details stay as they are.
5. **`app.ts` fix**, D7: skip the global JSON parser for `/worker/security/v2`, and add the in-process test (an unauthenticated 4.5 MiB body is refused before parsing; the 4 MiB limit holds; other routes keep 5 MB).

## 3. Tests and integration
- **Unit tests:**
  - every `api.md` isolation case 3–8 (Company A/B, machine X/Y);
  - lazy issuance and reuse;
  - lease history;
  - the lease verifies with the fixture (`activation_lease`), and a tampered lease is rejected;
  - Task20d's ingest accepts records under an issued lease and refuses them after expiry or under an `off` lease;
  - fleet v1/v2/v3;
  - the `app.ts` test.

  Register new test files in `apps/api/package.json`'s `test` script.
- **IT-T20f-01:** extend `features/security/task20f-signing-live-verify.ts`. Keep part a's checks; add settings → lease → `GET /lease` and `GET /bundles` over HTTP with real machine credentials → acknowledgement → an ingest upload accepted → expiry/off refused → machine X/Y and Company A/B → audit rows. Also cover the fleet v3 database check. Run it once here:

  `IT_PG_DATABASES=trackai_task20f_signing_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20f_signing_live scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api`

- **Gates:** run `npm run check` once at the end.
- **Review:** run one independent review subagent before the handoff (CLAUDE.md "Reviews") and fix what it finds.

## 4. Close-out (original prompt §4)
- **Rewrite the handoff** into its final form, under 100 lines.
  - Keep part a's results and the design note's decisions.
  - Add what Task20g must verify on the Endpoint: the payload types, the epoch, the digest binding, lease freshness, the refusal codes, and the v3 `securityLease`.
  - Add what Task20i reads (the admin API), and Effort for the whole Task20f.
- **Update your rows:** `docs/plan/TASK20.md` (T20.8 and the Task20f session row) and `docs/plan/STATUS_BOARD.md` (row 9f, IT-T20f-01).
- **Push the branch.**
- **Final reply**, in the AGENTS.md §12.4 shape with the original prompt's numbered bash block:
  1. fetch both branches;
  2. a worktree, `npm ci`, `npm test`;
  3. IT-T20f-01;
  4. under `# after the cross-agent review`:
     - `gh pr create` for `docs/Task20f-audit-events` first (body `docs/handoffs/Task20f-audit-events_HANDOFF.md`);
     - then `gh pr create` for `task/Task20f-security-settings-signing`;
     - `scripts/pr-preflight.sh` for each;
     - `gh pr merge … --merge` (the audit PR first).

  Then the `text` review request for Codex (Task9's owner for the fleet files; the Task20 lead also looks, because this is signing and activation code).

## Lessons from part a
- **Drizzle wraps driver errors:** a trigger's message is on `error.cause`.
- **`0025`'s snapshot drift is fixed in `0026`'s snapshot.** A new `drizzle-kit generate` should emit nothing for `security_findings`; if it does, compare before keeping anything.
- **Run every touched test file before pushing,** not only the obvious suite: a Task16 test hard-coded the catalogue version.
