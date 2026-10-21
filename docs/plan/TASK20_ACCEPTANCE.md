# Task20 acceptance walkthrough (E20-01…E20-12)

*Task20j runbook for the founder's Intel Mac. Record E20 results in `TASK20.md` §7–§8. The [Task19 T19.9 walkthrough](TASK19_WALKTHROUGH.md) runs in the same sitting; record its results separately in `TASK19.md` §8. This runbook replaces the removed Task15n gate 6. Status symbols follow `AGENTS.md` §11.*

## Claim and evidence rule

An agent on a platform is **monitored** only when its complete E20 row passes with a real installed Endpoint, real managed hook, accepted signed monitor lease, local Numbat record, accepted upload, and correct TrackAI view. Run the row separately for Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI. **Run Copilot CLI first** for steps that change rules, the binary or hooks. Codex CLI must be installed for its row. Mark every unrun agent **not monitored**. A pass on Intel macOS says nothing about Apple Silicon, Windows, Linux, IDE, remote or cloud routes. Monitor mode means *observed*; it never means an action was prevented. Task20k owns the later blocking pilot.

The build under test is the exact **`trackai-endpoint-macos-x64-debug.pkg` built after the GitAI Task20j fix branch merges**, using development trust pins. Every E20 verdict must say “debug package, development trust.” The placeholder bundle is inert and cannot establish monitoring. Keep package signing, Jamf and multi-device results in the [GitAI package registry](https://github.com/mahamannu-ux/git-ai/blob/main/docs/task9-endpoint-package-flavours.md) and Task9f evidence; E20 does not close those separate gates. Production trust and signing wait for `IT-T20f-02` and Task9f item 4.

Record safe evidence only: date, macOS version and architecture, Endpoint and Numbat versions, package filename and SHA-256, tenant and machine aliases, agent/version, rule id/version, lease id and expiry, bundle digest, counts, UI state, and redacted logs. Do not paste raw prompts, commands, paths, URLs, usernames, emails, tokens, record bodies, or signing material into this file. Keep machine-local evidence in the disposable test environment and cite a safe evidence locator here.

## Before the sitting

1. Use an isolated test account on the founder's Intel Mac and a disposable TrackAI stack. Confirm the daemon's actual database, tenant and machine binding before generating records. Create Company A and Company B, with separate administrator and auditor accounts. Use only synthetic activity and a test repository.
2. Confirm the exact `trackai-endpoint-macos-x64-debug.pkg` build, its SHA-256, Numbat pin and notices. Follow GitAI `packaging/macos/FOUNDER_WALKTHROUGH.md` for install and offboard. This run is unsigned, not notarized and uses no MDM/Jamf; leave the separate Task9 gates open.
3. Finish or explicitly record the prerequisite outcomes: `IT-T20d-01`, `IT-T20e-01`, `IT-T20f-01`, `IT-T20g-01`, `IT-T20h-01`, `IT-M20-02`, and the Task20i browser walkthrough. A missing prerequisite cannot be silently inherited from code or a prior debug-package run.
4. Prepare Company A's development-signed monitor lease and the default wave-one rule bundle. Confirm 44 enabled rules and the seven noisy rules disabled against the pinned catalogue; compare rule ids, versions, hashes and the active bundle digest. The placeholder bundle is intentionally inert and does not count.
5. Keep the five security data settings off initially: command previews, file paths, URLs, host identity and user identity. Opt in to day-one scan only for Company A after identifying the synthetic session files to scan.
6. Prepare [T19.9](TASK19_WALKTHROUGH.md#before-the-sitting): a Company A GitHub test repository with an AI-assisted merged PR, its App delivery/reconciliation, Attesta statements and period report, and a founder-approved and founder-denied permission request. The Task19 instructions own the Q&A verdicts.

### Local database that lasts seven days

This is a proposed isolated week stack for the founder to review before E20-W. It is named `trackai_task20h_founder` because GitAI's existing `packaging/macos/founder-live-setup.ts` refuses other database names. Keep it only for this synthetic run. `scripts/it-db.sh` remains the choice for the separate short IT commands below and must not host the week.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
docker run --name trackai-task20j-pg \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=trackai_task20h_founder \
  -p 127.0.0.1::5432 -d pgvector/pgvector:pg16
TASK20J_PG_PORT="$(docker port trackai-task20j-pg 5432/tcp | sed 's/.*://')"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${TASK20J_PG_PORT}/trackai_task20h_founder"
DATABASE_URL="$DATABASE_URL" npm run db:migrate -w apps/api
```

Expected: the container is running and migrations complete. Stop if the container name already exists; inspect the existing container rather than deleting it. After a reboot, run `docker start trackai-task20j-pg`, then repeat the `TASK20J_PG_PORT`, `DATABASE_URL`, and API/auth/web start commands. Check `docker inspect -f '{{.State.Running}}' trackai-task20j-pg` says `true`, the database name in `DATABASE_URL` is `trackai_task20h_founder`, and only the intended API process listens on 8080. A running `/health` response alone does not identify its database.

Seed once, then start the local auth, API and web processes. The seed writes four generated test-only passwords, development signing keys and the machine credential under a private directory; it prints none of their values. Keep that directory out of Git. The founder reads the four login entries locally from `private/auth.json` and transfers only the needed bootstrap and public trust files to the test Mac account, following GitAI's `packaging/macos/FOUNDER_WALKTHROUGH.md`. Never paste those values into chat or an evidence table.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
export TASK20J_PRIVATE_DIR=/Users/manishmahajan/AIProjects/TrackAI-wt/_task20j-week-private
export TASK20J_WEEK_DATABASE=1
node --import tsx apps/api/src/features/security/testing/task20j-week-setup.ts seed "$TASK20J_PRIVATE_DIR"
export SUPABASE_URL=http://127.0.0.1:54321
export FRONTEND_URL=http://localhost:3000,http://127.0.0.1:3000
export SECURITY_POLICY_BUNDLE_CREDENTIAL_ID=dev:task20f-policy-bundle
export SECURITY_DEV_POLICY_BUNDLE_KEY_FILE="$TASK20J_PRIVATE_DIR/private/policy.pem"
export SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID=dev:task20f-activation-lease
export SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE="$TASK20J_PRIVATE_DIR/private/lease.pem"
node --import tsx apps/api/src/features/security/testing/task20j-week-setup.ts auth "$TASK20J_PRIVATE_DIR" > "$TASK20J_PRIVATE_DIR/auth.log" 2>&1 &
PORT=8080 node --import tsx apps/api/src/index.ts > "$TASK20J_PRIVATE_DIR/api.log" 2>&1 &
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=task20j-local-public-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev -w apps/web
```

Expected: `task20j_week_seed=ready`, `task20j_week_auth=ready` in the private auth log, API `/health` OK, and the console at `http://localhost:3000/login`. Before each restart, obtain the current random Docker port again, export the same database URL, and restart auth/API/web with the same private directory. Do not rerun `seed`: it refuses an existing directory. Confirm the API PID listening on 8080 and its `DATABASE_URL` in that process's environment locally before generating records. The seed's Company A machine is the only Endpoint enrolment; Company B has no machine until the isolation test explicitly gives it one.

### Build under test, after GitAI Stage 0 merges

From GitAI **main** after the founder merges `task/Task20j-fixes-gitai`, build the debug package using the development trust files from the local seed. Match `--version` to the built Endpoint version; the existing Task20h-a walkthrough used `1.6.19`. The output name is intentional and identifies the E20 build.

```bash
cd /Users/manishmahajan/AIProjects/git-ai
go version
task build
packaging/numbat/build.sh darwin amd64 packaging/numbat/out
packaging/macos/build-pkg.sh \
  --binary target/debug/git-ai \
  --numbat-dir packaging/numbat/out/numbat_v0.2.0-trackai.1_darwin_amd64 \
  --trust-dir /Users/manishmahajan/AIProjects/TrackAI-wt/_task20j-week-private/trust \
  --arch x64 --version 1.6.19 \
  --output /Users/Shared/trackai-endpoint-macos-x64-debug.pkg \
  --debug-dev-pins
shasum -a 256 /Users/Shared/trackai-endpoint-macos-x64-debug.pkg
```

Expected: the audited pin/checksum and architecture checks pass, the PKG exists, and the final line is its SHA-256. Record the GitAI main SHA, package version and digest in `TASK20.md` §7 before installation. Use GitAI [`packaging/macos/FOUNDER_WALKTHROUGH.md`](https://github.com/mahamannu-ux/git-ai/blob/main/packaging/macos/FOUNDER_WALKTHROUGH.md) §§3–5 for the exact install, hook status, bootstrap, monitor and off commands, substituting this package name and Task20j's private directory. E20's extra rule, privacy, offline, expiry, tamper, scan, inventory and console checks below extend that prior walkthrough.

## Rule proof and the seven-day run

**E20-R:** After the GitAI fix merges, run the pin test from the fork's main checkout:

```bash
cd /Users/manishmahajan/AIProjects/git-ai
sh packaging/numbat/test-pin.sh
```

Expected: `numbat-tests: ok <n> packages`. The pinned Numbat `rules/*_test.go` suites provide positive and negative cases for all 51 rules. Run `numbat rules check` on the compiled default bundle for each of the five agents, then make one harmless live trigger in each rule group (secrets, exfil, exec, persistence, integrity, impact, chains, tamper). Record the exact rule IDs live-triggered and which rely on pinned tests. Each hook p95 must be at most **50 ms** on the Intel Mac; record sample size, median and p95 for Numbat and Endpoint separately. Use stripped **release artifact** sizes for both binaries; the old 69 MB Git AI measurement was unstripped.

**E20-W:** On one fixed debug build in the founder's everyday account, run the 44 first-wave rules in monitor mode for seven days. The API and a **kept local PostgreSQL database** must survive the week and be restartable after a Mac reboot; `scripts/it-db.sh` removes its database and is only for the separate IT sweep. Do not install Task13 on this account during the week. Record daily health, lease renewals (about 24/day), queue delivery across sleep/network changes, file rotation, agent failures or slowdown, and findings by rule and agent. Zero findings is valid if health stayed `ok` throughout. Triage every finding as true/false positive with an action; no critical false positive may remain untriaged.

For each UTC day, the following command reads **all pages** of Company A's Security console API with the local administrator account and prints metadata counts only. It never prints the test password, token or finding content. Record the output in the daily table and inspect each finding in the console before marking true/false positive.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
node --import tsx apps/api/src/features/security/testing/task20j-daily-triage.ts \
  /Users/manishmahajan/AIProjects/TrackAI-wt/_task20j-week-private YYYY-MM-DD
```

| Day / date | Build SHA-256 | Health layers | Renewal count | Queue / rotation | Rule and agent counts | False positives / action | Agent slowdown |
|---|---|---|---:|---|---|---|---|
| 1–7, pending | — | ⬜ | — | — | — | — | — |

## E20 checks

Perform E20-01…E20-08 separately for every agent claimed as monitored. E20-09…E20-12 can share the stack, but the recorded observation must identify which agent produced each record. Capture before/after server counts with a stable tenant/machine/agent filter; an unchanged count is the negative proof in off and failure cases. Treat an unexpected finding or upload as a failure even if the screen looks healthy.

| ID | Action on the real Mac | Pass observation |
|---|---|---|
| E20-01 | Install the exact debug package. Inspect five managed hooks as `installed` and all four health layers. Check the effective view by hand for each agent. | `hook_status`, `local_record`, `forwarder_ack` are `ok`. For Claude Code and Cursor, “runs, not listed in the view” is an accepted hand-check result; record `agent_effective_view` as actually reported. |
| E20-02 | With an accepted development-signed monitor lease, generate one harmless match through each agent's real managed hook. | A finding per agent shows matching `source_agent`, model, rule id/version and bundle digest. Codex CLI is installed and used. The action is called observed. |
| E20-03 | Change one rule's severity and turn one noisy rule on; dry-run, then apply. Use Copilot CLI first. | New bundle applies and is acknowledged. The next finding carries the changed severity and new digest. |
| E20-04 | Turn command previews on, then off through signed leases. Send a deliberately disallowed-field upload. | Stored finding first has a bounded preview, then lacks it. Server refuses the over-permissive upload. Do not record the preview content. |
| E20-05 | Set monitoring `off` and repeat a harmless match. | Placeholder restored and uploads stop. Numbat local preview records continue. The console states off, not monitored. |
| E20-06 | Restore monitor; disconnect network, make actions, restart daemon, then reconnect. | Each eligible record arrives once through the queue; no unauthorized upload occurs while offline. Record queue/server counts before and after. |
| E20-07 | Stay offline past lease expiry and repeat; reconnect and renew with the same bundle digest. | Expiry sets monitoring off and stops uploads. Renewal restores the same bundle without a needless rule change. |
| E20-08 | Corrupt a cached rule file and replay an old lease in the isolated setup. | Neither activates. Last good is kept or refetched, and refusal is visible in Coverage. Restore legitimate state after the check. |
| E20-09 | Opt in to day-one scan of synthetic prior sessions, including one agent with no session files; then switch off and on. | `found_at_rest` findings and one summary per agent arrive. Zero-artifact agent reads “no session files found”. A second scan does not run after off/on. |
| E20-10 | Compare inventory with installed and unmanaged agents on the Mac. | Inventory rows arrive and unmanaged agents remain visible in S19. Unknown versions remain unavailable. |
| E20-11 | In Security, use Findings filters and drawer, Coverage and Settings. Apply with a reason, attempt stale two-tab apply, then sign in as auditor. | Coverage shows literal “Not checked by the Endpoint” and “Failed”; two-tab conflict appears, auditor is read-only, and no “blocked” or “prevented” claim appears. |
| E20-12 | Read console, Q&A and machine routes as Company B; try Company A identifiers. | Company A sees none of B and B sees none of A; cross-tenant machine/record lookups have safe not-found responses. |

After E20, run [Task19's fifteen T19.9 steps](TASK19_WALKTHROUGH.md#steps) in the same sitting using the generated Endpoint records. T19.9 is a separate pass/fail decision, including auditor and Company B checks. Do not mark E20 passed because a Q&A answer rendered, or T19.9 passed because a finding appeared.

### Founder IT sweep in the same sitting

Run these in disposable databases after the E20 and T19.9 observations. Their verdicts belong to their own `STATUS_BOARD.md` rows. The commands below are the registered scripts; no success is inferred until the founder returns their safe summary lines.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
scripts/it-db.sh npm run verify:task19a-qa-live -w apps/api
scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api
scripts/it-db.sh npm run verify:task19f-qa-live -w apps/api
IT_PG_DATABASES=trackai_task20d_ingest_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20d_ingest_live scripts/it-db.sh npm run verify:task20d-ingest-live -w apps/api
```

`IT-T20g-01` is the E20-07/08 live Mac lease and tamper run. `IT-M20-02` is the E20-02/06 Endpoint-to-real-server run. Record each independently against its original expected checks; a script-only replacement for either is not registered. Run `IT-M20-01` only if the Task15o signer is available on this development stack; otherwise keep it ⬜ with that reason.

## Result worksheet for `TASK20.md` §7–§8

Copy the completed rows into `TASK20.md` §7–§8. A row is **passed** only after E20-01…E20-08 pass for that exact agent and E20-09…E20-12 pass for the same stack. If a check fails, record the ID, safe observation and owner; do not change the claim until rerun. Record conditional agents as **not monitored**, rather than treating them as failed product tests.

| Date | Host / OS | Agent | E20-01…08 | Shared E20-09…12 | Claim | Safe evidence locator / issue |
|---|---|---|---|---|---|---|
| — | Intel macOS | Claude Code | ⬜ not run | ⬜ not run | not monitored | — |
| — | Intel macOS | Codex | ⬜ not run | ⬜ not run | not monitored | — |
| — | Intel macOS | Cursor | ⬜ not run | ⬜ not run | not monitored | — |
| — | Intel macOS | Gemini CLI | ⬜ not run | ⬜ not run | not monitored | — |
| — | Intel macOS | Copilot CLI | ⬜ not run | ⬜ not run | not monitored | — |
| — | Apple Silicon / Windows / Linux | all agents | ⬜ not run | ⬜ not run | not monitored | Separate Task9/Task9g and Linux gates |

| Date | Package / SHA-256 | Tenant A/B and machine aliases | Wave-one tests | One-week normal-work interval | Untriaged critical false positives | E20 mismatches / disposition | T19.9 result |
|---|---|---|---|---|---|---|---|
| — | — | — | ⬜ | ⬜ | unknown | ⬜ not run | ⬜ see `TASK19.md` §8 |

## Closure

`T20.14` passes only when the wave-one rule proof and at least Claude Code and Codex's Intel Mac rows pass, with every other agent/platform explicitly bounded as not monitored. `T20.20` updates `AGENTS.md` and the Task6.a tracker to match these recorded facts. `IT-T20f-02`, signed/notarized package distribution, Jamf, second Mac, Apple Silicon, Windows and Linux keep their own gates. Task20k and Task20l need the founder's separate go after this walkthrough.
