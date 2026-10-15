# Handoff prompt: Task15n-attesta-live-gates (Attesta on real KMS, real Rekor and TSA, offline verification on a clean machine; plus the Task6.a founder acceptance walkthrough), Codex (or Muse) with the founder

> **Founder setup (agent: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Codex:** start a new thread in **Worktree** mode in the TrackAI project and paste everything below the line. (Muse works too: `make worktree M=Task15n-attesta-live-gates`, then `opencode`.)
> 3. Have ready:
>    1. your personal Google Cloud (Blaze) account in `gcloud` (the same email as GitHub and Claude). The `purpletealabs.net` Google Workspace is not involved;
>    2. a **second macOS user account** on this Mac, for the offline root signing and the clean-machine check;
>    3. about 2.5 hours.
>
>    Never paste a secret, key file content or access token into the chat.
> 4. The agent gives you numbered steps. Paste back only the safe summary lines it asks for.
> 5. When done, paste its review request to the **lead Claude chat**. Push only after "ready to push".

---

You are **Codex** (or Muse), running **Task15n-attesta-live-gates** (Task15 A15.13) for **TrackAI** with the founder.

Attesta is built and tested against fakes. The fakes cover the KMS signer (Task15g), the Rekor and RFC 3161 anchors (Task15f/15f2), the trust layer and key inventory (Task15l/15l2), evidence packs (Task15i2) and the offline verifier (Task15j). Nothing has yet signed with a real cloud KMS, anchored in a real transparency log or timestamp authority, or been verified on a machine that never saw TrackAI. This session proves those three things live.

It also runs the **Task6.a founder acceptance walkthrough** (gate 6). Codex's 2026-10-14 report recommends it, and it must pass before Task15o starts signing security findings.

It is mostly **founder-live**: you write exact numbered steps, the founder runs them, and you diagnose. Code changes are allowed only for a defect the live run exposes, kept minimal, each with a regression test. If a fix is larger than about 30 lines, stop and write it up for the lead.

- **Worktree:** under `~/AIProjects/TrackAI-wt/`, branch `task/Task15n-attesta-live-gates`. **Handoff:** `docs/handoffs/Task15n-attesta-live-gates_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rule 4: never print a secret; §9 items 10, 16–21; §11; §12.4).
2. Check your location and branch; set the identity for this worktree only. Run `npm ci && npm test` once.
3. Read the founder-live notes in:
   - `docs/handoffs/Task15g-attesta-kms_HANDOFF.md` (the A15.13 row: P-256 key, IAM `kms:Sign` and `kms:GetPublicKey`, or GCP `useToSign` and `viewPublicKey`);
   - `Task15f-attesta-anchoring_HANDOFF.md` (decision 5: Rekor shard offsets);
   - `Task15f2-attesta-anchoring-worker_HANDOFF.md` ("Integration notes": `ATTESTA_REKOR_*`, `ATTESTA_TSA_*`);
   - `Task15l2-trust-inventory_HANDOFF.md` ("A15.13 founder-live steps" 1–6; `ATTESTA_TRUST_ROOT_KEYIDS`, `ATTESTA_KMS_CREDENTIALS_FILE`);
   - `Task15j-attesta-verifier_HANDOFF.md` (the clean-machine command);
   - `Task16e-audit-tamper_HANDOFF.md` (sealing needs a tenant statement key).
4. Estimate in one line against T6. The plan says **about 0.05×**, plus founder time.

## 1. Environment (decided)
- **Database:** the persistent local acceptance database used by Task15k and Task16f, `docker run --name trackai-task5-uat-pg … -p 127.0.0.1:55432:5432` (exact commands in `docs/handoffs/Task16f-audit-console_HANDOFF.md`). It is synthetic data only and never a customer database. Seed it as that handoff says, so there is a tenant with commits to attest.
- **Files the founder keeps outside the repository**, in `~/AIProjects/_secrets/attesta-live/`:
  - the offline root private key;
  - the KMS credentials file;
  - the pinned Rekor log key;
  - the FreeTSA root.

  The offline root private key lives only in the second macOS account (`~/attesta-root/` there). Your steps reference these paths only; nothing under them is committed.
- **Endpoints:** `https://rekor.sigstage.dev` (the Sigstore staging log, a test log, as A15.13 says) and `https://freetsa.org/tsr` (FreeTSA).
- **Google Cloud (decided):**
  - the founder's personal Blaze account, with a **dedicated project** `trackai-attesta-dev` (or another name the founder picks), so the live keys are isolated from anything else;
  - one key ring `attesta`, location `global`, with P-256 `EC_SIGN_P256_SHA256` keys, one per platform purpose plus one tenant statement key;
  - **no service-account key file:** authenticate with `gcloud auth application-default login` as the founder, and grant only `roles/cloudkms.signerVerifier` and `roles/cloudkms.publicKeyViewer` on the key ring;
  - the cost is a few cents a month per key version: say so in step 1, and give the `gcloud kms keys versions destroy …` cleanup commands at the end.

  AWS is optional and skipped unless the founder asks. Production moves to an organization-owned project in Task14; record that in the handoff.
- **Second macOS account ("clean machine"):**
  - a standard user created in System Settings;
  - holds the offline root private key (gate 1 step 4) and runs the clean-machine verification (gate 4);
  - its own clone of the public repository files (`git clone` over HTTPS with the founder's GitHub login, or the pack and a copy of the repository folder through `/Users/Shared`), `npm ci`, no TrackAI credentials, no database.

  Files move between the accounts only through `/Users/Shared/attesta-live/`, and only public files go there (drafts, signed root document, pack, public keys), never the root private key.
## 2. The gates (founder runs, you guide)
Write each gate as **numbered** founder steps (one bash block per gate, sections `# 1.`, `# 2.` …, each with its expected output). After each gate, the founder pastes back only the lines you name.

1. **Gate 1, platform trust (root ceremony)** (Task15l2 steps 1–6):
   1. create the platform KMS keys (one per platform purpose) and list them in `ATTESTA_KMS_CREDENTIALS_FILE` with tenant `00000000-0000-0000-0000-000000000000`;
   2. `attesta:keys register --purpose <p>` for each;
   3. `export-root-draft`;
   4. in the second macOS account, `attesta:trust-root sign` (the draft arrives through `/Users/Shared/attesta-live/`, and the signed root document goes back the same way);
   5. `import-root` with `ATTESTA_TRUST_ROOT_KEYIDS` set;
   6. register and activate the seeded tenant's statement key, then the first `publish --all-tenants`.

   **Pass:** `attesta:keys list` shows the root, the platform keys and the tenant key active, and a published key set at version 1.
2. **Gate 2, real KMS signing:**
   1. `attesta:build` signs the seeded tenant's pending statements with the KMS-backed tenant key;
   2. `GET /api/attesta/verify` (or the CLI path the Task15i handoff names) reports `ok` with signatures checked.

   Prove one statement's signature with the KMS public key fetched separately (`gcloud kms keys versions get-public-key …` or `aws kms get-public-key …`): the SPKI hash matches the registered keyid. If both clouds are available, do GCP first and AWS as an optional second pass.
3. **Gate 3, real anchoring:**
   1. pin the sigstage log key into `ATTESTA_REKOR_LOG_KEY_FILE`, and `ATTESTA_REKOR_LOG_INDEX_OFFSETS` from one current entry (Task15f decision 5: decimal tree id → offset);
   2. put the FreeTSA root in `ATTESTA_TSA_ANCHORS_FILE`;
   3. run `attesta:anchor` once against the real endpoints.

   **Pass:** every record is `anchored` for both types, and verify reports anchors checked with no break. Record one Rekor entry UUID and one TSA serial as evidence; both are public values.
4. **Gate 4, offline verification on a clean machine:**
   1. on the main machine, request an evidence pack (`attesta:pack` or `POST /api/attesta/evidence-packs`, mode `full`) and download it;
   2. in the second macOS account: its own clone and `npm ci`, **no** database and **no** TrackAI credentials, Wi-Fi off while verifying;
   3. run `npm run attesta:verify-pack -w apps/api -- --pack <file> --root-keyid <pin> --rekor-log-key <pem> --tsa-anchors <pem> --rekor-log-index-offsets '<json>'`.

   **Pass:** exit 0. Then edit one statement byte in a copy: the verifier exits 1. If Task16f2 has merged, also run `audit:verify-export` on a signed audit export, with the same expectations.
5. **Gate 5, sealing on real keys** (short): `attesta:audit-seal --confirm` seals the seeded tenant's audit trail with the KMS-backed key, the seal anchors in gate 3's pass, and `GET /api/audit/verify` is green.

6. **Gate 6, Task6.a founder acceptance walkthrough** (Codex's report, "Recommended next step"), on the same local stack, in the browser:
   1. Set monitoring to `off`, trigger one synthetic safe test pattern: no finding appears.
   2. Enable `monitor`.
   3. Trigger the same synthetic safe pattern (OpenCode terminal on macOS, route `AC-CLI-03`; use the approved safe test case from Task6's rule fixtures, never a real destructive command).
   4. As admin: the finding appears in Security findings, and its `security_findings.read` audit entry appears in the Audit view.
   5. As auditor: the same finding, read-only, with no mutation control.
   6. As developer: findings and administration are refused.
   7. Confirm that the action was **not blocked** (monitor-only) and that no raw command text appears anywhere: UI, API response, audit details.

   Read `TASK6_SECURITY.md` and the Task6 handoffs for how the founder triggers the safe pattern through GitAI on this Mac. **Pass:** all seven confirmed. Screenshots go in the founder's own records, not the repository. Record one line per step in the handoff.

## 3. Pre-approved files
- `docs/handoffs/Task15n-attesta-live-gates_HANDOFF.md`.
- `docs/plan/TASK15.md` (the A15.13 row and the Task15n session row only); the founder-acceptance row in `TASK6_SECURITY.md` (one line, gate 6 result).
- `docs/plan/STATUS_BOARD.md` (new rows IT-T15n-01…05, one per gate, and IT-T6-ACC-01 for gate 6; the remaining-plan actual).
- Minimal fixes in `apps/api/src/features/attesta/` for defects the live run exposes, each with a regression test. Name every one in the handoff.

**Never touch:** `docs/contracts/`, migrations, any key file, the root private key.

## 4. Close-out
- Handoff under 60 lines:
  - each gate's result, with the public evidence (keyids, Rekor UUID, TSA serial, exit codes);
  - every defect found and its fix;
  - the production notes Task14 needs: how many keys, which IAM permissions, the endpoints, the weekly `publish --all-tenants`, the `attesta:anchor` cadence, `attesta:build -- --loop`;
  - Effort.

  No secret, token or private key material in it.
- **Final reply** in the AGENTS.md §12.4 shape, with every founder step numbered. The bash block contains, in order:
  - `npm test`;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task15n-attesta-live-gates --title "[Task15n] Attesta live gates" --body-file docs/handoffs/Task15n-attesta-live-gates_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; the preflight; and the merge only after the preflight says ok.

  Then the review request for the lead in a `text` block.

## Lessons so far
- **Founder steps are numbered** (founder, 2026-10-15): every list and every bash-block section (`# 1.`, `# 2.`), with the expected output, so the founder can say "step 4 failed".
- **Task15f2/15l2:** shard offsets are keyed by decimal tree id. The resolver signs only with a key the latest published key set lists active, so run `publish` after every `activate`.
- **Sandbox vs live:** a failure in your sandbox is not a product failure (AGENTS.md §9 item 15); the founder's run decides.
