# Task15i3-attesta-verify-keys-resume Handoff — Attesta: key-validity windows in /verify, audited anchor resume

> Status: ✅ done · 🟡 partial or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do (AGENTS.md §11).
Branch `task/Task15i3-attesta-verify-keys-resume` (base: `main` at `9fd6740`). Closes the two Task15i2 carry-overs: `/verify` now applies each statement key's validity window and revocation time (trust.md step 8), with the record's verified anchor as time evidence. A batch stopped by a terminal anchoring code can be resumed by an audited operator action. No period report (Task15i4) and no resume route.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | Key windows in `verify-chain.ts` (`keyWindows`, break `key_not_valid_at`, warning `key_windows_not_checked`) | ✅ |
| Scope | Keys and windows from the newest trust-verified key set (`publishedKeyWindowsFor`), default in the router | ✅ |
| Scope | Migration 0021 `attesta_anchor_resumes`, `attesta:anchor-resume` CLI, worker resume rule | ✅ |
| Scope | Contract: errors.md code, api.md `/verify` row, tables.md table and rule (additive) | ✅ |
| Quality | `npm test` 815 pass (791 → 815), typecheck, lint, `drizzle-kit check` | ✅ |
| Integration | IT-T15i3-01…04 added; IT-T15i, IT-T15i2, IT-T15f2 re-run | ✅ founder run 2026-10-13 (agent-verified the same day) |
| Review | Review subagent: 2 must-fix + 4 should-fix, all fixed (Deviations 3–5); Muse cross-review: ready to push, no fixes | ✅ |

## Implemented interfaces
```
verify-chain.ts  VerifyChainOptions.keyWindows?: Record<keyid, KeyWindow{notBeforeMs, notAfterMs, untilMs|null}>, now?: Date
                 break key_not_valid_at → ATTESTA_VERIFY_KEY_NOT_VALID_AT; warning key_windows_not_checked (report never ok)
read-service.ts  publishedKeyWindowsFor(store, tenantId, config, now?) → PublishedKey[] {keyid, publicKey, window} | null
                 publishedKeySource(store, config = trustConfigFromEnv, now)   // router default; keys seam kept for tests
CLI              npm run attesta:anchor-resume -w apps/api -- --tenant <uuid> --batch <tenant>:<from>-<to> --actor <name> --reason <text> [--confirm=RESUME]
                 (exported: runAnchorResumeCli, pgResumeStore, resumeVerdict, parseResumeArgs)
audit            security_audit_events action attesta.anchor.resume (actor_type system_operator, target attesta_anchor_batch, details {request_id, terminal_code, records, reason})
```
Rule (trust.md step 8, `recorded_at` = signedAt): `recorded_at` lies in [not_before, not_after] and is not after now + 5 min. If the key is retired, revoked or past `not_after` at `now`, a verified anchor of the record is also needed: inside [not_before, not_after] and strictly before `revoked_at` (`compromised_since` for a compromised key; `not_after` for an expired active key). A record stamped at or after the cut-off plus 5 minutes always breaks. A record with no anchor material, or only not-checkable anchors, gets the warning instead.

## Ported from
SushiCorp @ `0bd67a5`: `core/trust/revocation.py` (catalog TR-1: unknown is never clean. Here an uncheckable window is a warning and never `ok`, and it is not reported as revoked). `core/evidence/anchoring.py` (EV-2: "a rejected batch is skipped until an operator acts"; SushiCorp has no resume command, so the append-only resume row and one-resume-per-stop are new). The window tests are ported from `trust-verify.test.ts` and the `KEY_NOT_VALID_AT` / `KEY_REVOKED` trust vectors.

## Founder-approved decisions (checkpoint 2026-10-13)
1. An active key past `not_after` needs an anchor before `not_after`; an anchor counts only inside the key's validity (trust.md step 8). 2. Uncheckable anchors → warning, not a break. 3. Windows come from the signed key set, so an unpublished retirement waits for `publish`.

## Deviations from spec
1. **Superseded and compromised keys:** they break as `KEY_NOT_VALID_AT` (one verify code), where trust.md's own verifier says `KEY_REVOKED`. The spec names one code.
2. **Not pre-approved file:** `t15i2-evidence-packs-live-verify.ts`, one line. Its inventory is now set up 2 hours back. Its statements are stamped up to 50 minutes in the past, which is before the keys' `not_before`, and the windows now reject that. This was a test-oracle artefact, not a product change.
3. **Review fix, resume rule:** the guard and the CLI use the worker's rule, "a terminal failure newer than the latest resume". The prompt's rule was "latest failed attempt is terminal". With two concurrent passes, a retryable failure recorded after a terminal one left the batch stopped with no way to resume it (reproduced). One resume still lifts exactly one stop.
4. **Review fix, guards:**
   - A resume row needs its `attesta.anchor.resume` audit row (same `request_id`, unique per tenant), checked at commit.
   - An invoker-rights visibility guard fires before the definer guard, so an RLS-bound caller cannot probe another tenant's batch state.
   - The insert guard refuses anything but READ COMMITTED (a REPEATABLE READ snapshot could let two concurrent resumes pass).
5. **Review fix, verify:** a record stamped at or after the cut-off plus the skew breaks even without anchor material, because no anchor could save it.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Failure rows carry `now()` (the worker's transaction start), so one recorded concurrently with a resume can be lifted with it. Rekor/TSA times are whole seconds | One extra retry at most; sub-second ordering only |
| 🟡 | An expired key set (not published for 31 days) or a missing `ATTESTA_TRUST_ROOT_KEYIDS` makes `/verify` report `signatures: not_checked` | Fail-closed; Task14 schedules the weekly `publish --all-tenants` |

## Test coverage
- **Windows** (one `T0`): active inside/outside validity and past `not_after`; cut-offs before, at and after the anchor; the 10:00 / 10:05 / 10:07 example; a failed anchor never counts, one verified type does; the warning without anchor material; unlisted key; bad signature.
- **Key source:** status → cut-off from real key sets; unpublished retirement; no pin, wrong pin, no key set, expired or tampered key set → `null`; Company A/B; route wiring.
- **Worker and CLI:** resume → retry with backoff → stopped again → resumed → anchored; dry run, apply, every refusal, two resumes per stop, a race lost to the guard, terminal-then-retryable, argument validation.

## Integration test impact
> ~~**FOUNDER:** blocking the Task15i3 merge.~~ Done 2026-10-13: all passed. Prerequisites: PostgreSQL 16 with pgvector (Docker or local). Expected: 4 + 3 + 3 + 4 passed, about 2 minutes.
> ```bash
> scripts/it-db.sh npm run verify:task15i3-verify-keys-resume-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15i3-01 | Rotation with `attesta:keys`: the old key's anchored statements stay ok; a statement the retired key signs afterwards is `KEY_NOT_VALID_AT`, before and after anchoring | Blocking: merge | ✅ founder run 2026-10-13 |
| IT-T15i3-02 | `revoke compromised --compromised-since`: anchored before → ok, after → break | Blocking: merge | ✅ founder run 2026-10-13 |
| IT-T15i3-03 | `LOG_REJECTED` stop → CLI dry run and apply (audited) → anchored. Second resume refused (CLI, API role, RLS role, REPEATABLE READ); new stop needs a new resume, also behind a retryable failure; no audit → refused at COMMIT; `created_at` stamped; append-only | Blocking: merge | ✅ founder run 2026-10-13 |
| IT-T15i3-04 | Company A/B: A cannot resume B's batch (CLI, store, API role, RLS role; same refusal as an unknown batch); windows only from the tenant's own key set | Blocking: merge | ✅ founder run 2026-10-13 |

Regressions re-run in the sandbox: IT-T15i-01…03, IT-T15i2-01…03, IT-T15f-01…04 passed.
## Integration notes
- **A15.10 (Muse, 15j):** apply the same rule offline, with trust.md's `KEY_REVOKED` / `KEY_NOT_VALID_AT` split. **Task15i4:** period reports are statements; their windows are checked the same way.
- **Operators:** rotate with `activate --replace` then `publish`; `/verify` reads only the published key set.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.15× (plan 0.12×) | about 0.17× | ~75 turns + 1 review subagent | ~1.5 h | n/a |

Within 1.25× of the estimate; the review round was the main addition.
