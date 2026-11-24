# Task20 acceptance walkthrough (E20-01…E20-12)

*Task20j runbook for the founder's Intel Mac. Record E20 results in `TASK20.md` §7–§8. The [Task19 T19.9 walkthrough](TASK19_WALKTHROUGH.md) runs in the same sitting; record its results separately in `TASK19.md` §8. This runbook replaces the removed Task15n gate 6. Status symbols follow `AGENTS.md` §11.*

**Close-out change (founder and Task20 lead, 2026-11-25):** Task20j stops its E20-07 outage before lease expiry; restore the week API and continue the nonblocking soak. The pre-expiry offline action and four locally queued record IDs are partial evidence only. **E20-07 moves to the next installed Endpoint build and runs separately**; this run does not pass E20-07 or the full per-agent E20 claim. The historical wait-to-expiry instructions below describe that later run, not a command to keep the present API down.

## Claim and evidence rule

An agent on a platform is **monitored** only when its complete E20 row passes with a real installed Endpoint, real managed hook, accepted signed monitor lease, local Numbat record, accepted upload, and correct TrackAI view. Run the row separately for Claude Code, Codex, Cursor, Gemini CLI and Copilot CLI. **Run Copilot CLI first** for steps that change rules, the binary or hooks. Codex CLI must be installed for its row. Mark every unrun agent **not monitored**. A pass on Intel macOS says nothing about Apple Silicon, Windows, Linux, IDE, remote or cloud routes. Monitor mode means *observed*; it never means an action was prevented. Task20k owns the later blocking pilot.

The build under test is the exact **`trackai-endpoint-macos-x64-debug.pkg` built after the GitAI Task20j fix branch merges**, using development trust pins. Every E20 verdict must say “debug package, development trust.” The placeholder bundle is inert and cannot establish monitoring. Keep package signing, Jamf and multi-device results in the [GitAI package registry](https://github.com/mahamannu-ux/git-ai/blob/main/docs/task9-endpoint-package-flavours.md) and Task9f evidence; E20 does not close those separate gates. Production trust and signing wait for `IT-T20f-02` and Task9f item 4.

Record safe evidence only: date, macOS version and architecture, Endpoint and Numbat versions, package filename and SHA-256, tenant and machine aliases, agent/version, rule id/version, lease id and expiry, bundle digest, counts, UI state, and redacted logs. Do not paste raw prompts, commands, paths, URLs, usernames, emails, tokens, record bodies, or signing material into this file. Keep machine-local evidence in the disposable test environment and cite a safe evidence locator here.

## Before the sitting

1. Use the founder's everyday account on the Intel Mac for the joint sitting and ongoing E20-W soak, with the kept local TrackAI stack. Confirm the daemon's actual database, tenant and machine binding before generating records. Create Company A and Company B, with separate administrator and auditor accounts. E20-W observes **real everyday work** and feeds Task20l; use synthetic triggers and a test repository for the targeted E20 checks. Every Endpoint record goes only to this Mac's local API and kept local database. Defer final offboarding until the ongoing soak ends: it removes managed hooks **machine-wide**, including hooks visible from other accounts.
2. Confirm the exact `trackai-endpoint-macos-x64-debug.pkg` build, its SHA-256, Numbat pin and notices. Follow GitAI `packaging/macos/FOUNDER_WALKTHROUGH.md` for install and offboard. This run is unsigned, not notarized and uses no MDM/Jamf; leave the separate Task9 gates open.
3. Keep these gates distinct:
   - **Already passed:** `IT-T20f-01` founder run on 2026-10-18. `IT-T20h-01` has qualified Intel debug-package evidence from 2026-10-20: install, a Claude finding, off and manual offboard passed; Codex CLI was absent, Claude/Cursor hook lists did not show Numbat despite execution, and unattended cleanup with a locked Keychain remains unproven. Repeat the relevant checks for this exact Task20j package and everyday account.
   - **Covered by E20 rows:** `IT-T20e-01` by E20-06 restart/rotation delivery; `IT-T20g-01` by E20-07/08; `IT-M20-02` by E20-02/06; Task20i browser walkthrough by E20-11. Record each original gate's verdict separately after its E20 evidence exists.
   - **Swept after E20:** `IT-T20d-01` and the Task19 registered scripts in the IT sweep below. No pending item is a prerequisite to performing its own E20 proof.
4. Prepare Company A's development-signed monitor lease and the default wave-one rule bundle. Confirm 44 enabled rules and the seven noisy rules disabled against the pinned catalogue; compare rule ids, versions, hashes and the active bundle digest. The placeholder bundle is intentionally inert and does not count.
5. Keep the five security data settings off initially: command previews, file paths, URLs, host identity and user identity. On day 1, opt in to Company A's day-one scan **only after the founder consents to scanning the everyday account's real prior agent history**. The Endpoint uploads only minimized findings and summaries to this Mac's local stack; no raw session files are copied into the evidence worksheet. If the founder does not consent, do not enable the scan.
6. Prepare [T19.9](TASK19_WALKTHROUGH.md#before-the-sitting): a Company A GitHub test repository with an AI-assisted merged PR, its App delivery/reconciliation, Attesta statements and period report, and a founder-approved and founder-denied permission request. The Task19 instructions own the Q&A verdicts.

### Kept local acceptance database

The isolated local stack is named `trackai_task20h_founder` because GitAI's existing `packaging/macos/founder-live-setup.ts` refuses other database names. Keep it for the sitting, E20-07 and ongoing soak. `scripts/it-db.sh` remains the choice for the separate short IT commands below and must not host this kept run.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
docker run --name trackai-task20j-pg \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=trackai_task20h_founder \
  -p 127.0.0.1:55432:5432 -d pgvector/pgvector:pg16
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/trackai_task20h_founder
DATABASE_URL="$DATABASE_URL" npm run db:migrate -w apps/api
```

Expected: the container is running and migrations complete. Stop if the container name or port already exists; inspect the existing container rather than deleting it. After a reboot, run `docker start trackai-task20j-pg`, export the same fixed `DATABASE_URL`, and restart auth/API/web with the same private directory. Check `docker inspect -f '{{.State.Running}}' trackai-task20j-pg` says `true`, the database name in `DATABASE_URL` is `trackai_task20h_founder`, and only the intended API process listens on 8080. A running `/health` response alone does not identify its database.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
docker start trackai-task20j-pg
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/trackai_task20h_founder
docker inspect -f '{{.State.Running}}' trackai-task20j-pg
```

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
umask 077
node -e 'const fs=require("node:fs"); const p=process.env.TASK20J_PRIVATE_DIR+"/private/preview-master-keyring.json"; if(!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({"task20j-local-v1":require("node:crypto").randomBytes(32).toString("base64")}), {flag:"wx",mode:0o600})'
export MASTER_ENCRYPTION_KEY_ACTIVE_VERSION=task20j-local-v1
export MASTER_ENCRYPTION_KEYS_JSON="$(cat "$TASK20J_PRIVATE_DIR/private/preview-master-keyring.json")"
node --import tsx apps/api/src/features/security/testing/task20j-week-setup.ts auth "$TASK20J_PRIVATE_DIR" > "$TASK20J_PRIVATE_DIR/auth.log" 2>&1 &
PORT=8080 node --import tsx apps/api/src/index.ts > "$TASK20J_PRIVATE_DIR/api.log" 2>&1 &
echo $! > "$TASK20J_PRIVATE_DIR/private/api.pid"
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=task20j-local-public-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev -w apps/web
```

Expected: `task20j_week_seed=ready`, `task20j_week_auth=ready` in the private auth log, API `/health` OK, and the console at `http://localhost:3000/login`. The private preview master keyring must persist across API restarts; never replace it while encrypted previews exist, print it or commit it. On restart, export the same database URL, signing variables and both `MASTER_ENCRYPTION_*` variables, then restart auth/API/web with the same private directory. Do not rerun `seed`: it refuses an existing directory. Confirm the API PID listening on 8080 and its `DATABASE_URL` in that process's environment locally before generating records. The seed's Company A machine is the only Endpoint enrolment; Company B has no machine until the isolation test explicitly gives it one.

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

**Fixed build recorded 2026-11-17:** GitAI `e6bfe77b6`; Endpoint `1.6.19 (debug)`; Numbat `v0.2.0-trackai.1` (`b80672486b0e05b4eb13033b0546fddddde71c7792a6e1cceb9cd19240771667`); package SHA-256 `34ccd4cd60f079d4d6e863d2a8de58f4214f859099aba7af3e7c159eadb69c74`. The package's `PackageInfo` identifier is `com.git-ai.git-ai` and its receipt version is `1.6.19`; verify the *installed* `pkgutil` receipt after installation. GitAI `main` may receive merges; they do not change the installed Endpoint. The founder subsequently moved E20-07 to the next installed build. Record each later installed build change in the soak log.

## Rule proof, sitting and ongoing soak

### Run order

1. **Day 1 (completed):** install the exact debug package, obtain the signed monitor lease, record E20-01's install/health baseline, obtain the founder's consent to scan prior history, and run E20-09 day-one scan. The eight-group live proof with matching IDs and `found_at_rest=false` and the 200-run hook latency measurements remain separate accepted evidence.
2. **Before the sitting:** record the observed Nov 19 07:09 IST Mac reboot and Nov 19–20 status gap (see handoff), and verify the recovered stack and current lease. Status uploads are hourly when the shipper is active, not change-only. The available logs cannot establish the daemon's post-reboot uptime; if later evidence establishes it ran silently with a reachable API, record an E20-01/06 defect. Collect E20-W noise data every 2–3 days during real work; a consecutive-day run is not a close-out gate.
3. **Joint sitting (recorded Nov 24/25):** E20-01…06 and E20-08…12 were exercised on the Intel debug package; E20-06 login start and E20-09 Cursor empty history were mismatches, and E20-08 cached-rule recovery remained inconclusive. Task19's available security steps and the disposable-database sweep were recorded with their separate verdicts. See the handoff and `TASK19.md` §8.
4. **Close-out decision:** the founder stopped the API for E20-07 and recorded a pre-expiry offline action, then chose to restart it before the signed expiry. E20-07 is **deferred to the next installed build**. Continue the soak on the restored stack and record the four queued IDs' delivery if observed; that delivery is not an expiry pass. Full E20 and IT-T20g-01 expiry claims stay open.

### Day-1 signed monitor lease and consented scan

The founder explicitly consented on 2026-11-17 to the one-time scan of the everyday account's prior agent history. Publish Company A's first settings change only while the kept local database, auth and API are healthy. The default rule settings enable 44 of the 51 pinned rules; all five optional data fields default to off. This change turns on monitoring and the consented scan together. The settings CLI plans first, then publishes with the development signing keys from the private directory. Keep the change file private and do not paste its tenant id or the resulting scan records into the worksheet.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
export TASK20J_PRIVATE_DIR=/Users/manishmahajan/AIProjects/TrackAI-wt/_task20j-week-private
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/trackai_task20h_founder
export SECURITY_POLICY_BUNDLE_CREDENTIAL_ID=dev:task20f-policy-bundle
export SECURITY_DEV_POLICY_BUNDLE_KEY_FILE="$TASK20J_PRIVATE_DIR/private/policy.pem"
export SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID=dev:task20f-activation-lease
export SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE="$TASK20J_PRIVATE_DIR/private/lease.pem"
export TASK20J_TENANT_A="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.TASK20J_PRIVATE_DIR + "/aliases.json", "utf8")).a.tenantId')"
umask 077
cat > "$TASK20J_PRIVATE_DIR/private/day1-monitor.json" <<'JSON'
{"reason":"Task20j founder-consented local acceptance week","monitor_mode":"monitor","day_one_scan":true}
JSON
npm run security:settings -w apps/api -- --tenant "$TASK20J_TENANT_A" --operator task20j-founder-day1 --change "$TASK20J_PRIVATE_DIR/private/day1-monitor.json"
# Only after the dry run says off -> monitor, zero rule changes, bundle yes,
# one active machine and no signer-limit refusal:
npm run security:settings -w apps/api -- --tenant "$TASK20J_TENANT_A" --operator task20j-founder-day1 --change "$TASK20J_PRIVATE_DIR/private/day1-monitor.json" --confirm
"$HOME/.git-ai/bin/git-ai" bg restart --hard
readlink "$HOME/.git-ai/internal/security/rules/current"
```

Expected: a signed bundle v1 and lease for Company A, an `applied` acknowledgement, and a version folder rather than `placeholder` after refresh. In the Security Settings screen verify 44 enabled rules, seven disabled, all five data fields off, monitor mode on and day-one scan on. Wait for the scan to finish; confirm the private `~/.git-ai/internal/security/day-one-scan-done` marker exists, and inspect only the per-agent summary/status and counts in the local console. A partial marker, missing agent summary or refused acknowledgement is a mismatch to record, not a pass. The triage command below supplies safe Coverage and finding counts. Do not rerun `seed` or reinstall the Endpoint before the sitting and E20-07.

**E20-R:** After the GitAI fix merges, run the pin test from the fork's main checkout:

```bash
cd /Users/manishmahajan/AIProjects/git-ai
sh packaging/numbat/test-pin.sh
```

Expected: `numbat-tests: ok <n> packages`. The pinned Numbat `rules/*_test.go` suites provide positive and negative cases for all 51 rules. Run `numbat rules check` on the compiled default bundle for each of the five agents, then make one harmless live trigger in each rule group (secrets, exfil, exec, persistence, integrity, impact, chains, tamper) during working days 1–2. Use a disposable test repository and synthetic files; first prove the real managed-hook path and accepted server finding with `found_at_rest=false` for Claude Code, Codex and Cursor. Match each server record ID to the local record ID. Do not count the three historical findings as live proof. Record the exact rule IDs live-triggered and which rely on pinned tests. Each hook p95 must be at most **50 ms** on the Intel Mac; record sample size, median and p95 for Numbat and Endpoint separately. Use stripped **release artifact** sizes for both binaries; the old 69 MB Git AI measurement was unstripped.

**First live-path proof (working days 1–2):** The disposable test directory has a synthetic `kubeconfig` file containing no credential. In each real Claude Code, Codex CLI and Cursor Agent session, ask the agent to run `head -c 1 kubeconfig >/dev/null` using its ordinary terminal tool from that directory. This reads one byte from a dummy file without displaying it and matches the enabled `secrets.read_private_key` rule. Confirm the tool completes. The first Claude Code attempt used `head -c 0`, which macOS rejected with exit 1, but the pre-action hook emitted a live finding visible in Company A Security. The corrected command passed a macOS shell check and an isolated installed-Numbat diagnostic. Compare the local finding's derived record ID against Company A's server row with the same `record_id`, `source_agent`, rule ID and `found_at_rest=false`; the Security tab's list alone does not display all of those fields, so use a bounded metadata-only database query. Do not paste synthetic command output or real session content into evidence. Proceed to one safe synthetic trigger for each remaining rule group after this first upload proof. Do not change the signed settings or installed package for this check. The earlier `cat .env` suggestion was wrong: `secrets.agent_read_env` is disabled by default in the seven-rule noisy set and therefore produced only local events, not a finding.

**First live result:** Company A's kept database has matching derived record IDs and `found_at_rest=false` for Claude Code, Cursor and founder-run Codex CLI. A separate Codex desktop-session diagnostic row is excluded from the CLI claim. This establishes the secrets-group real hook-to-server path for those three agents; it does not close their other E20 checks. For the next group, an isolated installed-Numbat diagnostic matched the enabled `exfil.curl_post_file` rule with `curl --max-time 1 --data-binary @kubeconfig http://127.0.0.1:1 >/dev/null` from the disposable test directory. The file contains only dummy text and port 1 should refuse the connection; inspect the actual tool result and live finding separately, and stop if a listener is present there.

**E20-W (ongoing, nonblocking):** Observe the 44 first-wave rules in monitor mode during the founder's **real agent work** on Claude Code's desktop Code tab and CLI agents over the coming weeks. Collect safe counts every 2–3 days and feed noise and false-positive findings to Task20l. Keep the local API and PostgreSQL available or restart the same stack after reboot; `scripts/it-db.sh` is only for the separate IT sweep. Record each *installed* Endpoint build's version/SHA-256 and change date, status and lease freshness, queue/rotation behavior, agent failures or slowdown, and findings by rule and agent. Zero findings is valid only as a finding count; it does not prove coverage when status is stale. Triage critical findings promptly and record uncertain dispositions honestly. E20-W has no required consecutive-day duration and does not block Task20 acceptance.

Every 2–3 days, run the following command for each UTC date since the previous collection. It reads **all pages** of Company A's findings and Coverage APIs with the local administrator account. It prints counts, the seeded Company A machine's four health layers, *latest* status time, lease id/expiry and last acknowledgement; the Coverage row is not historical for the requested date. It never prints the test password, token or finding content. Check dated snapshots separately when Coverage is stale; inspect queue/rotation locally with the E20-06 commands below. Record each installed build change and inspect findings in the console before disposition.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
node --import tsx apps/api/src/features/security/testing/task20j-daily-triage.ts \
  /Users/manishmahajan/AIProjects/TrackAI-wt/_task20j-week-private YYYY-MM-DD
```

| Day / date | Build SHA-256 | Health layers | Renewal count | Queue / rotation | Rule and agent counts | False positives / action | Agent slowdown |
|---|---|---|---:|---|---|---|---|
| 1 / 2026-11-17 | `34ccd4cd60f079d4d6e863d2a8de58f4214f859099aba7af3e7c159eadb69c74` | hook/local/forwarder `ok`; effective view `unavailable`, hand check pending; applied monitor ack | ≥1 observed: lease ID changed from `65516a16-027f-405b-84ed-5de6a82d2048` to `c24bab9d-49bc-4e90-ba96-dccde904ca9b` | Not checked | 17 total: 14 synthetic live, 3 historical at-rest; see handoff for rule/agent counts | Historical 3 `uncertain`; synthetic requests are benign test matches, not real incidents | Not assessed; normal-work and slowdown notes pending |
| 2 / 2026-11-18 | same fixed build | hook/local `ok`; effective view `unavailable`; forwarder `unavailable` after >24h without finding ack; applied monitor ack | New lease ID `a7a7ea3b-703f-427e-9704-eb7dcfdfe812` | Local finding queue 0; rotation not checked | 0 Company A findings; 24 local Codex events | No new finding to triage; 3 earlier at-rest rows remain `uncertain` | Founder normal-work and slowdown notes pending |
| 3 / 2026-11-19 | same fixed build | **Evidence gap:** no Company A status snapshot dated Nov 19 UTC; latest displayed triage status belonged to Nov 18 | Not proven for day | Nov 21 archive holds session events dated this day; queue state during day unknown | 0 server findings in retrospective query; founder reports non-CLI managed-agent work, exact surface/hook use pending | No new finding to triage | Pending founder note |
| 4 / 2026-11-20 | same fixed build | **Evidence gap:** no Company A status snapshot dated Nov 20 UTC; latest displayed triage status belonged to Nov 18 | Not proven for day | Nov 21 archive holds session events dated this day; queue state during day unknown | 0 server findings in retrospective query; founder reports non-CLI managed-agent work, exact surface/hook use pending | No new finding to triage | Pending founder note |
| 2026-11-21 recovery (non-working day) | same fixed build | Fresh monitor status 06:55:07Z, applied ack, hook/local `ok`, effective view/forwarder `unavailable` | New lease `5ca29b88-fb1a-4fcb-88b3-e94f74809b89` expires Nov 24 06:54:40Z | Restart completed; rotation pending | 0 server findings | No new finding to triage | Not assessed |
| Nov 22–24 UTC (retrospective count on Nov 24) | same fixed build | Nov 22 02:01 IST Mac reboot; auth/API restored Nov 24; latest status Nov 24 09:53:39Z, hook/local `ok`, effective view/forwarder `unavailable`; no historical status claim for Nov 22/23 | Applied lease `1dc8b288-fb1e-4687-8130-2286c393dea0` expires Nov 27 09:53:36Z | Queue 0 after recovery; rotation pending | 0 server findings each day; local ordinary events: Nov 22 Codex 631, Nov 23 Claude Code 440 and Codex 139, Nov 24 Codex 46 as inspected | No new finding to triage; 3 historical at-rest rows still `uncertain` | Founder reported Claude Code use; slowdown not assessed |
| Ongoing soak, collect every 2–3 days | record each installed build/version/SHA-256 and change date | Latest status plus dated snapshot checks if needed; Nov 19–20 remain an evidence gap | Observe renewals when available | Track queue/rotation as exercised | Counts by rule/agent; distinguish CLI, desktop Code tab and unsupported surfaces | Triage critical findings promptly; carry uncertainty explicitly | Note any slowdown |

**Installed Endpoint build log (E20-W):** A GitAI source merge is not a build change on this Mac. Add a row only when the everyday account's installed Endpoint changes, with the package receipt and installed binary versions and package SHA-256.

| Installed date | Source revision | Endpoint / Numbat | Package SHA-256 | Reason |
|---|---|---|---|---|
| 2026-11-17 | GitAI `e6bfe77b6` | Endpoint `1.6.19 (debug)` / Numbat `v0.2.0-trackai.1` | `34ccd4cd60f079d4d6e863d2a8de58f4214f859099aba7af3e7c159eadb69c74` | Initial Task20j fixed-build install; E20-07 moved to next installed build |

## E20 checks

Perform E20-01…E20-08 separately for every agent claimed as monitored. E20-09…E20-12 can share the stack, but the recorded observation must identify which agent produced each record. Capture before/after server counts with a stable tenant/machine/agent filter; an unchanged count is the negative proof in off and failure cases. Treat an unexpected finding or upload as a failure even if the screen looks healthy.

| ID | Action on the real Mac | Pass observation |
|---|---|---|
| E20-01 | Install the exact debug package. Inspect five managed hooks as `installed` and all four health layers. Check the effective view by hand for each agent. | `hook_status`, `local_record`, `forwarder_ack` are `ok`. For Claude Code and Cursor, “runs, not listed in the view” is an accepted hand-check result; record `agent_effective_view` as actually reported. |
| E20-02 | With an accepted development-signed monitor lease, generate one harmless match through each agent's real managed hook. | A finding per agent shows matching `source_agent`, model, rule id/version and bundle digest. Codex CLI is installed and used. The action is called observed. |
| E20-03 | Change one rule's severity and turn one noisy rule on; dry-run, then apply. Use Copilot CLI first. | New bundle applies and is acknowledged. The next finding carries the changed severity and new digest. |
| E20-04 | Turn command previews on, then off through signed leases. Send a deliberately disallowed-field upload. | Stored finding first has a bounded preview, then lacks it. Server refuses the over-permissive upload. Do not record the preview content. |
| E20-05 | Set monitoring `off` and repeat a harmless match. | Placeholder restored and uploads stop. Numbat local preview records continue. The console states off, not monitored. |
| E20-06 | Restore monitor; disconnect the local API, make actions, restart daemon, then reconnect. Check automatic login start after the observed Mac reboot separately. | Each eligible record arrives once through the queue; no unauthorized upload occurs while offline. Record queue/server counts before and after. Login start has a recorded mismatch on this install; passing the manual queue test does not erase it. |
| E20-07 | Stay offline past lease expiry and repeat; reconnect and renew with the same bundle digest. | Expiry sets monitoring off and stops uploads. Renewal restores the same bundle without a needless rule change. |
| E20-08 | Corrupt a cached rule file and replay an old lease in the isolated setup. | Invalid cached rules are refetched, the restored file digest matches the original, and an `applied` acknowledgement arrives with no new refusal. Old state cannot regress the accepted lease. Restore legitimate state after the check. |
| E20-09 | At day-1 enrolment, opt in to scanning real prior sessions after founder consent; later switch off and on. | Minimized `found_at_rest` findings and one summary per agent arrive on the local stack. Zero-artifact agent reads “no session files found”. A second scan does not run after off/on. |
| E20-10 | Compare inventory with installed and unmanaged agents on the Mac. | Inventory rows arrive and unmanaged agents remain visible in S19. Unknown versions remain unavailable. |
| E20-11 | In Security, use Findings filters and drawer, Coverage and Settings. Apply with a reason, attempt stale two-tab apply, then sign in as auditor. | Coverage shows literal “Not checked by the Endpoint” and “Failed”; two-tab conflict appears, auditor is read-only, and no “blocked” or “prevented” claim appears. |
| E20-12 | Read console, Q&A and machine routes as Company B; try Company A identifiers. | Company A sees none of B and B sees none of A; cross-tenant machine/record lookups have safe not-found responses. |

### Commands and console paths for E20-03…E20-12

Run these against the kept local stack and the exact installed package. `TASK20J_PRIVATE_DIR` and `DATABASE_URL` are the exports from setup above. On the Mac, `ENDPOINT="$HOME/.git-ai/bin/git-ai"` and `SECURITY_DIR="$HOME/.git-ai/internal/security"`. Do not paste tokens, credentials, record bodies or local paths into the evidence worksheet. `http://localhost:3000/dashboard?view=security&tab=settings` is the Company A administrator's Settings screen; use the dry-run plan before Apply, with a written synthetic reason. Coverage is `?view=security&tab=coverage`; Findings is `?view=security&tab=findings`.

**E20-03:** In Settings, choose one enabled rule, change its severity by one level, then enable one of the seven initially disabled noisy rules. Press **Review changes**, check the named rule changes and bundle version, then **Apply** with a reason. Start with a real Copilot CLI action. In the Mac terminal force a refresh and check the active pointer:

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
ENDPOINT="$HOME/.git-ai/bin/git-ai"
"$ENDPOINT" bg restart --hard
sleep 10
readlink "$HOME/.git-ai/internal/security/rules/current"
```

The pointer must name the new bundle. Confirm the new digest and severity in the next Copilot finding and `applied` in Coverage. Restore the noisy rule to disabled after proof, again selecting **Review changes** and **Apply** with a reason.

**E20-04:** In the same Settings screen, turn on **Command previews**, select **Review changes** and **Apply**; make one harmless action and inspect its finding locally. This data-setting-only change increments the lease/data-settings version; it does **not** publish a new rule bundle or change the active rules pointer. Confirm the setting in the signed lease/coverage before the action. Turn **Command previews** off, again select **Review changes** and **Apply**, make another action, and check that its finding lacks `observed_command`. With previews off, run the machine-credential negative probe below. It reads the credential locally, sends one synthetic upload, and prints only the refusal code:

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
node --import tsx apps/api/src/features/security/testing/task20j-forbidden-upload.ts "$TASK20J_PRIVATE_DIR"
```

Expected: `SECURITY_V2_FIELD_NOT_PERMITTED`. The script fails if the record is accepted or refused for a different reason.

**E20-05:** In Settings, switch Monitor mode to **Off**, select **Review changes** and **Apply**. On the Mac, run `"$ENDPOINT" bg restart --hard`; `readlink "$SECURITY_DIR/rules/current"` must say `placeholder`. Repeat a harmless agent action; `wc -l "$HOME/.numbat/records.ndjson"` may rise, while the Company A Findings count must not. Restore **Monitor** in Settings with **Review changes** and **Apply** before E20-06.

**E20-06 / IT-T20e-01 / IT-M20-02:** On the Mac first record `wc -l "$HOME/.numbat/records.ndjson"` and the Company A Findings count in the console. This week API is on **loopback**, so disabling Wi-Fi alone cannot take the Endpoint offline from it. Stop the saved API process, verify that `/health` is unreachable, make synthetic agent actions, and restart the same API against the kept database. `networksetup -setnetworkserviceenabled "Wi-Fi" off`/`on` may additionally simulate a network outage if the active service is Wi-Fi, but the API stop is required for this local topology.

**Restart prerequisite after E20-04:** The API must retain the private persistent preview master keyring and the development signing settings on every restart. An API lacking `MASTER_ENCRYPTION_*` returned HTTP 500 when storing encrypted command previews; the installed GitAI uploader misleadingly labelled 5xx retries `SECURITY_V2_LEASE_REQUIRED`. Verify the private keyring file exists, then export `MASTER_ENCRYPTION_KEY_ACTIVE_VERSION=task20j-local-v1` and `MASTER_ENCRYPTION_KEYS_JSON="$(cat "$TASK20J_PRIVATE_DIR/private/preview-master-keyring.json")"` together with the database URL and both development signers **before** stopping the working API. Never print the keyring or the API's process environment.

**Existing reboot mismatch to retain:** After the Nov 19 07:09 IST reboot, `~/Library/LaunchAgents/com.usegitai.bg.plist` and `launchctl` service `gui/502/com.usegitai.bg` were absent. The Endpoint did not resume automatically at login; Task9/Task20 own the fix after the sitting. Six local Nov 19–20 session events were *not* eligible v2 security uploads, so they do not prove queue delivery. Record the reboot finding as an E20-06 mismatch even if the synthetic manual-restart/queue test below passes. Do not install login-start or replace the installed Endpoint before the sitting and E20-07.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
ENDPOINT="$HOME/.git-ai/bin/git-ai"
TASK20J_API_PID="$(cat "$TASK20J_PRIVATE_DIR/private/api.pid")"
ps -p "$TASK20J_API_PID" -o command= | grep -F 'apps/api/src/index.ts' || exit 1
kill "$TASK20J_API_PID"
sleep 2
if curl --silent --max-time 2 http://127.0.0.1:8080/health >/dev/null; then echo 'API still reachable; stop' >&2; exit 1; fi
# Perform two harmless monitored agent actions here.
"$ENDPOINT" bg restart --hard
wc -l "$HOME/.numbat/records.ndjson"
PORT=8080 NODE_ENV=development TASK20J_WEEK_DATABASE=1 node --import tsx apps/api/src/index.ts >> "$TASK20J_PRIVATE_DIR/api.log" 2>&1 &
echo $! > "$TASK20J_PRIVATE_DIR/private/api.pid"
for E20_READY in 1 2 3 4 5; do
  if curl --fail --silent http://127.0.0.1:8080/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:8080/health >/dev/null
"$ENDPOINT" bg restart --hard
sleep 15
"$ENDPOINT" bg tail -n 80
```

Compare local record IDs and the server's received IDs/count after reconnect; each eligible ID must arrive once. To prove file rotation, stop the daemon, make one harmless monitored agent action that Numbat writes into the **old active file** while it is not being tailed, then move that active file to an unoccupied **`records.ndjson.YYYY-MM-DD.N`** filename in the same directory. Create a new owner-only active file, restart the Endpoint, make a second harmless action in the **new** active file, and compare both locally derived finding IDs with Company A exactly once. Confirm the daemon remained stopped and the queue did not advance after the first action, so the rotated file actually held an unread entry. The real-account active file can contain earlier ordinary agent history; preserve its rotated copy and never delete it for this test. GitAI's tailer looks for filenames beginning `records.ndjson.` when following a saved inode; a name such as `records.e20-06-before-rotation.ndjson` does not test that rotation path. An absent record or duplicate fails IT-T20e-01.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
ENDPOINT="$HOME/.git-ai/bin/git-ai"
"$ENDPOINT" bg shutdown --hard
# Make one harmless monitored agent action before the move; confirm the daemon stayed down.
test ! -e "$HOME/.numbat/records.ndjson.2026-11-24.99" || exit 1
mv "$HOME/.numbat/records.ndjson" "$HOME/.numbat/records.ndjson.2026-11-24.99"
umask 077
touch "$HOME/.numbat/records.ndjson"
"$ENDPOINT" bg restart --hard
# Make one harmless monitored action and compare its record ID with Company A Findings.
wc -l "$HOME/.numbat/records.ndjson.2026-11-24.99" "$HOME/.numbat/records.ndjson"
```

**E20-07 / IT-T20g-01 (next installed build only):** The present debug build's outage ended before expiry by founder decision; apply this procedure in the separately scheduled next-build run. The Task19 lead's 2026-11-25 decision defers GitHub/Attesta-dependent T19.9 steps to a separate Task19 session, and records the S26 approval/denial mismatch in `TASK19.md` §8; neither is silently counted as passed. The server issues a **72-hour lease** (`SECURITY_V2_DEFAULT_LEASE_VALIDITY_HOURS=72`); it normally renews after one hour. There is no development environment switch to shorten that signed lifetime. Read the actual expiry from Coverage and record the local queued-record count before disconnecting. Stop the local API using the E20-06 PID and `/health` checks, and keep it stopped until **after that exact expiry** (up to 72 hours from issuance); do not alter the Mac clock or signed lease. Make a harmless monitored action before expiry to exercise the offline queue, then another after expiry. Check `readlink "$SECURITY_DIR/rules/current"` is `placeholder` after expiry. Restart the API using the E20-06 start command, verify no expired-lease upload arrived, run `"$ENDPOINT" bg restart --hard`, and check the new lease id, acknowledgement and restored pointer. Compare queued and server record IDs/counts: each eligible pre-expiry record must deliver once after restart. The bundle digest should stay the same. This outage can overlap a weekend or time away.

On the Mac, run this at outage start, after the pre-expiry action and after API restart; record only the counts. Match the queued record IDs to Company A Findings locally before calling delivery complete.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
sqlite3 "$HOME/.git-ai/internal/security-findings.db" 'SELECT count(*) FROM security_record_queue;'
```

**E20-08 / IT-T20g-01:** Save the active Copilot rule file and its SHA-256 in the private evidence directory, then overwrite **only that disposable cached copy** with invalid YAML (`not: [valid`). Do not edit the package's Numbat binary or trust documents. **Make no agent actions while the file is corrupted:** a hook load error can fail open. Restart the Endpoint immediately. Its reconciliation must detect the bad cached folder, refetch the same signed bundle, and restore a version-folder `rules/current` whose selected file digest equals the saved original. Coverage must show an **`applied` acknowledgement and no new refusal row**; a refusal is expected only for a bad document delivered by the server. If the file stays corrupted, the pointer is `placeholder`, or a refusal appears, E20-08 fails. A *valid* local edit to a cached rule can affect behavior without per-hook integrity enforcement; the server sees only digest and health evidence. As `TASK20.md` §1 item 8 states, phase 1 is **tamper-evident at the server, not tamper-resistant**.

For stale-lease replay, save `state.json` before an ordinary settings-triggered lease renewal, then after the newer lease is accepted stop the daemon, substitute that saved **older signed state** only in this disposable run, restart and confirm it cannot regress the active lease. Keep both state copies in the private directory and restore the newer state afterward. A local state swap is a replay of the cached signed lease; record that scope explicitly. If the server never issues a newer lease, do not mark replay passed.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
ENDPOINT="$HOME/.git-ai/bin/git-ai"
SECURITY_DIR="$HOME/.git-ai/internal/security"
umask 077
E20_RULE_FILE="$(find "$SECURITY_DIR/rules/current/copilot" -type f -name '*.yaml' -print -quit)"
test -n "$E20_RULE_FILE" || exit 1
E20_RULE_SHA="$(shasum -a 256 "$E20_RULE_FILE" | awk '{print $1}')"
test ! -e "$TASK20J_PRIVATE_DIR/private/e20-rule-before.yaml" || exit 1
cp -p "$E20_RULE_FILE" "$TASK20J_PRIVATE_DIR/private/e20-rule-before.yaml"
printf 'not: [valid\n' > "$E20_RULE_FILE"
# Do not run an agent action while the cached YAML is invalid.
"$ENDPOINT" bg restart --hard
sleep 10
test "$(shasum -a 256 "$E20_RULE_FILE" | awk '{print $1}')" = "$E20_RULE_SHA" || exit 1
test "$(readlink "$SECURITY_DIR/rules/current")" != placeholder || exit 1
# Coverage must now show an applied acknowledgement and no new refusal.
cp -p "$SECURITY_DIR/state.json" "$TASK20J_PRIVATE_DIR/private/e20-state-old.json"
# In Settings, Review changes and apply an ordinary monitor-setting change; wait for a newer lease id.
"$ENDPOINT" bg restart --hard
cp -p "$SECURITY_DIR/state.json" "$TASK20J_PRIVATE_DIR/private/e20-state-new.json"
"$ENDPOINT" bg shutdown --hard
cp -p "$TASK20J_PRIVATE_DIR/private/e20-state-old.json" "$SECURITY_DIR/state.json"
"$ENDPOINT" bg restart --hard
sleep 10
# Inspect Coverage: no regression to the old lease or bundle is allowed.
"$ENDPOINT" bg shutdown --hard
cp -p "$TASK20J_PRIVATE_DIR/private/e20-state-new.json" "$SECURITY_DIR/state.json"
"$ENDPOINT" bg restart --hard
```

**E20-09:** Run the scan **at installation/enrolment on day 1**, after the founder consents to scanning the everyday account's real prior agent history. Record consent as yes/date or no in the safe E20-09 evidence row, without copying session content. Those prior sessions may produce minimized `found_at_rest` findings and summaries; they stay on this Mac's local stack. Do not delete or replace real history. Before enabling scan, run the pinned Numbat inventory below to record which managed agents already have artifacts. Cursor's at-rest store was “none found; deferred SQLite” in the checkpoint inventory, so its scan may provide the zero-artifact case; verify the actual result. If Cursor now has artifacts and all five agents do too, use an isolated fixture for the no-artifacts wording and keep the everyday-account zero-artifact branch explicitly unproven. In Settings, turn **Day-one scan** on with Monitor active, select **Review changes**, then **Apply**. Run `"$ENDPOINT" bg restart --hard`; check the done marker, its `partial` flag and the Company A S20 scan summaries. The zero-artifact agent should read “no session files found.” During the later joint sitting, toggle Monitor off and on through Settings, restart again, and confirm the marker and server summary count did not change. If an agent's scan fails, inspect `day-one-scan-attempts`; after 24 failed attempts the local marker is partial, and S20 must treat a missing summary as **not scanned**.

**Observed E20-09 mismatch:** The first two Cursor attempts exited with zero artifacts and two diagnostics, which the Endpoint did not recognize as the no-artifacts case. A later attempt completed after a Cursor action. The fifth summary's artifact count is needed to confirm whether the action created the first readable artifact; successful delivery does not erase the earlier zero-artifact bug. Fix the matcher with a Numbat diagnostic fixture after the fixed-build run.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
SECURITY_DIR="$HOME/.git-ai/internal/security"
/Library/Application\ Support/TrackAI/Endpoint/bin/numbat agents --all --format json > "$TASK20J_PRIVATE_DIR/private/e20-agent-inventory.json"
"$HOME/.git-ai/bin/git-ai" bg restart --hard
test -f "$SECURITY_DIR/day-one-scan-done"
jq '{partial,failed_agents}' "$SECURITY_DIR/day-one-scan-done"
```

**E20-10:** On the Mac run `/Library/Application\ Support/TrackAI/Endpoint/bin/numbat agents --all --format json` and compare its detected/wired agents with Company A's latest stored inventory snapshot and S19 live answer. Coverage shows only the status report's **wired agents** and health layers; it does not render the full inventory. Include an installed but unmanaged agent in the S19 detected/unwired comparison; it must remain visible as inventory, never described as monitored. Unknown versions remain unavailable. The Endpoint inventory refresh is lease-gated, so wait for a current monitor lease and the next reported inventory before comparing.

**E20-11:** Open the three Security tabs at the console paths above as Company A admin. In Findings, filter to the test rule/agent and open the drawer; in Coverage inspect all four health layers and acknowledgement. In Settings, select **Review changes**, then **Apply** with a reason. Open two tabs on the same initial settings version, apply a change in the first and attempt the stale plan in the second; expect `SECURITY_SETTINGS_CONFLICT`. Sign out and use the Company A auditor login from `private/auth.json`; Settings must be read-only. Record the literal “Not checked by the Endpoint” and “Failed” labels where the corresponding health states are present, without manufacturing those states in production data.

**E20-12:** Sign in with Company B admin and auditor accounts from `private/auth.json` and open `?view=security&tab=findings`, `?view=security&tab=coverage`, `?view=security&tab=settings`, and `?view=questions`. Company B has no seeded machine, so Coverage and Findings must have no Company A rows. Run the local read probe below: it pages both tenants' findings and coverage, asks B for A's finding detail (safe 404), and checks B's `/api/admin/machines` list for A's machine. It prints counts only. Repeat the visual reads as Company A and verify no B rows appear. If no Company A finding exists, E20-12 is not yet runnable.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
node --import tsx apps/api/src/features/security/testing/task20j-isolation-probe.ts "$TASK20J_PRIVATE_DIR"
```

After the joint sitting's E20-01…06 and E20-08…12 checks, run [Task19's fifteen T19.9 steps](TASK19_WALKTHROUGH.md#steps) using the generated Endpoint records. T19.9 is a separate pass/fail decision, including auditor and Company B checks. E20-07 remains last after the IT sweep. Do not mark E20 passed because a Q&A answer rendered, or T19.9 passed because a finding appeared.

### Founder IT sweep in the same sitting

Run these in disposable databases after the sitting's E20 and T19.9 observations, **before** the E20-07 outage. Their verdicts belong to their own `STATUS_BOARD.md` rows. The commands below are the registered scripts; no success is inferred until the founder returns their safe summary lines.

```bash
cd /Users/manishmahajan/AIProjects/TrackAI-wt/Task20j-acceptance
scripts/it-db.sh npm run verify:task19a-qa-live -w apps/api
scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api
scripts/it-db.sh npm run verify:task19f-qa-live -w apps/api
IT_PG_DATABASES=trackai_task20d_ingest_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20d_ingest_live scripts/it-db.sh npm run verify:task20d-ingest-live -w apps/api
```

`IT-T20e-01` is the E20-06 live Mac restart/rotation and upload run. `IT-T20g-01` is the E20-07/08 live Mac lease and tamper run. `IT-M20-02` is the E20-02/06 Endpoint-to-real-server run. Record each independently against its original expected checks; a script-only replacement for these is not registered. Run `IT-M20-01` only if the Task15o signer is available on this development stack; otherwise keep it ⬜ with that reason.

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

| Date | Package / SHA-256 | Tenant A/B and machine aliases | Wave-one tests | Ongoing E20-W soak (nonblocking) | Untriaged critical false positives | E20 mismatches / disposition | T19.9 result |
|---|---|---|---|---|---|---|---|
| — | — | — | ⬜ | ⬜ | unknown | ⬜ not run | ⬜ see `TASK19.md` §8 |

## Closure

`T20.14` passes only when the wave-one rule proof and at least Claude Code and Codex's Intel Mac rows pass, with every other agent/platform explicitly bounded as not monitored. `T20.20` updates `AGENTS.md` and the Task6.a tracker to match these recorded facts. `IT-T20f-02`, signed/notarized package distribution, Jamf, second Mac, Apple Silicon, Windows and Linux keep their own gates. Task20k and Task20l need the founder's separate go after this walkthrough.
