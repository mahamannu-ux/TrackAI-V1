# Attestation in the Console — Complete Walkthrough Guide (Task15k)

Covers the Task15k console: the attestation card, Verify chain, evidence-pack export.
All data is synthetic; the acceptance database, accounts and keys are disposable.
IT-T15k-01 passed on this setup 2026-10-14 (pass log at the end).

> Markdown has no colors, so this guide uses three callouts instead:
> `> EXPECTED` — what you should see when things work.
> `> GOTCHA` — a trap that looks like a bug but is the system working.
> `> NOTE` — background that saves you a question later.

## Part A — Run the console

Prerequisites: Docker, Node 20+, and this branch checked out
(`task/Task15k-attesta-console` — main does **not** have the console or the CORS fix).

```bash
# terminal 1: disposable database (first time only; later just `docker start`)
docker run --name trackai-task5-uat-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=trackai -p 127.0.0.1:55432:5432 -d pgvector/pgvector:pg16
docker exec trackai-task5-uat-pg pg_isready -U postgres -d trackai
DATABASE_URL='postgresql://postgres@127.0.0.1:55432/trackai' npm run db:migrate -w apps/api

# terminal 2: fake login server (run from anywhere with the API code)
TASK5_EPHEMERAL_DATABASE=1 npm run serve:task5-acceptance-auth -w apps/api

# terminal 3: API from the WORKTREE (anchoring unset is deliberate; TASK4_EXPORT_DIR
# is required or pack export fails; restart this process to pick up new env vars)
cd ~/AIProjects/TrackAI-wt/Task15k-attesta-console
DATABASE_URL='postgresql://postgres@127.0.0.1:55432/trackai' \
MASTER_ENCRYPTION_KEY_ACTIVE_VERSION='local-v1' \
MASTER_ENCRYPTION_KEYS_JSON='{"local-v1":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}' \
SUPABASE_URL='http://127.0.0.1:54321' \
FRONTEND_URL='http://localhost:3000,http://127.0.0.1:3000' \
TASK4_EXPORT_DIR='/tmp/trackai-exports' \
npm run dev -w apps/api

# terminal 4: web from the WORKTREE
cd ~/AIProjects/TrackAI-wt/Task15k-attesta-console
NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321' \
NEXT_PUBLIC_SUPABASE_ANON_KEY='task5-local-public-placeholder' \
NEXT_PUBLIC_API_URL='http://127.0.0.1:8080' npm run dev -w apps/web
# open http://localhost:3000/login
```

| Role | Email | Password | Sees |
|---|---|---|---|
| Administrator | `admin@task5.acceptance.invalid` | `task5-acceptance-only` | Everything, including Attestation |
| Auditor | `auditor@task5.acceptance.invalid` | `task6-auditor-only` | Card + Attestation (needs the Task6 seed below, else "no access") |
| Viewer | `developer@task5.acceptance.invalid` | `task5-viewer-only` | No Administration at all |

## Part B — If / else troubleshooting (every incident from the first run)

| Symptom | Cause | Fix |
|---|---|---|
| `docker run` says the name is in use | Container already exists | `docker start trackai-task5-uat-pg`, carry on |
| API fails with `Cannot find module 'canonicalize'` | Wrong directory: main checkout was never installed and lacks the branch code | Run terminals 3–4 from the worktree, never main |
| Commits/PRs lists are empty | Fresh database, no seed data | Corpus seed, then build (Part C); auditor also needs `seed:task6-acceptance` for its membership |
| `attesta:build` prints `claimed=0 done=0` | Old commits have no outbox rows (nothing to build) | Ingest through the real writer path first, then rebuild |
| Verify is red `KEY_UNKNOWN` on some rows | Those statements were signed by a key that was never published | Correct behavior; re-seed with the published key for clean rows |
| Pack POST fails red "request parameters are invalid" (400) | **To** is less than 5 minutes old | Set To ≥ 20 minutes in the past and retry |
| Pack job fails `ATTESTA_SIGNER_NO_CREDENTIAL` | Tenant has no published statement key | Key ceremony (register → activate → publish + root import), restart the API with the trust env vars, export again (new job) |
| Pack has `statements: 0` but the chain is non-empty | Window ends before the records (`to` older than their `recorded_at`) | Move To past the records (still 5+ min old); boundary record proves the skip was honest |
| Transient `M_ID` runtime error / `bis_skin_checked` hydration warning | Browser-safety extension rewriting the page | Benign; restart clean or disable the extension for localhost |
| Date picker icons invisible in dark mode | Missing `color-scheme` (fixed in `0f849cc`) | Hard-refresh the tab |

## Part C — What attestation is (30 seconds)

Per commit observed, PR merged and production deployment, TrackAI writes one short signed
**statement** (who/what/when — never code or prompts), links statements into one **chain**
per organization, and **anchors** the chain in public tamper-evident logs. Two honesty levels:

- The **card** reports a database fact ("we wrote a statement"). Never proof.
- **Verify** checks signatures against the org keys and anchors against the logs. Only its
  green box is proof. Everything else is an explicitly-labeled lesser state.

## Part D — The attestation card (commit / PR drawers)

| You see | Meaning |
|---|---|
| Nothing | No repository/SHA to look up (sessions never show a card) |
| "Checking attestation…" (grey) | Loading |
| "Not attested yet" (grey) | No statement for this commit — normal for fresh or pre-attestation data |
| "…need the administrator or auditor role." (no badge) | Login lacks both roles |
| "Attestation unavailable" (amber) + code | Server/network problem; code is for support |
| Row per statement, oldest first | Kind, date, 12 hex of the fingerprint, anchor badge: "Signed · anchored" (green), "Signed · anchoring pending" (amber, < 1 h old), "Signed · anchor overdue" (amber, older) |
| "Attested when merged." | Open PR: no merge commit exists yet |

> EXPECTED: the card never says "verified"/"proven" and never shows red. That is deliberate.

## Part E — Verify chain: where the numbers come from

Each **record** is one link, numbered by a gap-free per-organization counter **`seq`**
(0, 1, 2, …), allocated at chain time — never reused, never skipped (a rollback consumes
no number, so a gap always means a missing record). "From record" / "To record" are
optional bounds on that counter; empty means the whole chain (production caps a run at
10,000). To map a number back to a commit, open a pack: `records[].subject_sha` sits next
to each `seq`.

> GOTCHA: the card does not show `seq`, so a break row like `#1 … ATTESTA_VERIFY_…`
> cannot be traced to a commit without a pack. Record-number affordances are a proposed
> UX follow-up (Part J), not in this branch.

| Result box | Meaning |
|---|---|
| Green "Chain verified: N records. Signatures and anchors checked." | Proof. Only possible with configured keys + anchors (i.e. not this laptop). |
| Amber "Signatures checked; anchors not checked on this server." | Signatures verify; no log configured so anchors skipped — not a pass on anchors. |
| Amber "Not fully checkable: N records read; some checks could not run." | Evidence missing (e.g. signatures never checked); rows listed below. |
| Red "Verification found problems in N records." (N = distinct records) | Broken link, changed content, bad/unknown signature or anchor. Rows: `#seq`, plain label, machine code. |

Errors: "already running" (one verify per org — retry in seconds); "range too large or
invalid" (narrow to ≤ 10,000); anything else carries code + request ID.

## Part F — Export evidence pack

A signed file a third party checks offline: window statements, surrounding chain, anchors,
public keys, trust documents, one signature saying who exported what, when. Never prompts,
code or secrets. **Repository**: all or one (Repository-only mode needs one picked).
**Mode**: Full proves completeness; Repository-only hides other repos so completeness is
not provable. **Jobs** live in this tab only (grey → green/red, 3 s refresh); **ready**
downloads `trackai-evidence-pack-<id>.json` plus fingerprint; the pending line is honesty,
not an error; **failed** shows the code and, when retryable, **Try again** (same inputs,
fresh key). `NO_CREDENTIAL` is terminal until keys exist; `UNAVAILABLE` means the export
sink (`TASK4_EXPORT_DIR`) is unset.

> GOTCHA — dates: the picker sends your local time as UTC. **To must be ≥ 5 minutes old**
> or the server 400s (late records must never silently miss a pack). Use 20+ minutes of
> margin. Future dates are accepted by the picker today and refused by the server —
> clamping `max` to now is a proposed follow-up, not in this branch.

## Part G — Reading the pack JSON (annotated with the real 2026-10-14 download)

- `manifest.scope`: your window (`from/to/mode`, `repository_id: null` = all repos).
- `manifest.chain_range`: `from_seq`/`to_seq` bound the segment (each ±1 boundary record
  proves nothing was skipped); `prev_hash` chains backwards; `head` is set only when the
  segment reaches the tip (`next_seq` = first free number).
- `manifest.counts`: `records` (in segment) vs `statements` (in window) vs
  `anchored`/`pending` (anchor state at read time). `pending: 2` + the console's "not yet
  anchored" line is the expected local result.
- `records[]`: the raw links in seq order — check each `prev_hash` equals the previous
  `record_hash`. `statements[]`: the in-scope ones with `anchor_status` and signed envelopes.
- `trust`: `root_documents` (who the org pins), `keyset_documents` (key history from v1 —
  find your keyid `active` here), `verification_hint.pinned_root_keyids`.
- `signature`: DSSE envelope over `{manifest, pack_digest}`, payload type
  `.../evidence-pack+json`, signed by the active statement key. Verifier-grade checking of
  all of the above is A15.10's offline verifier, not this walkthrough.

## Part H — What this laptop proves vs production (Task14 / VPC)

| Capability | This laptop (done) | Production / Task14 (still to test) |
|---|---|---|
| Card states, drawer wiring | ✅ proven | Same code; real data volumes |
| Verify wording, break rows, 429/400 paths | ✅ proven | Same code |
| Pack build/download, counts honesty | ✅ proven | Same code; 50k-record packs, sink on object storage |
| Green "verified" + "anchored" badges | Cannot happen here (no logs/keys by design) | Real Rekor + TSA anchoring, KMS signing, scheduled builder/anchor/pack workers |
| Key rotation/revocation effects on Verify | Walkthrough keys only | Founder ceremony with platform KMS + offline root |
| Independent trust (clean-machine check) | — | Offline verifier (A15.10) against a pack on a clean host |

## Part I — IT-T15k-01 pass log (2026-10-14, admin + auditor)

1. Commit with statement → "Signed · anchoring pending"; without → "Not attested yet". ✅
2. Merged PR → card; open PR → "Attested when merged." ✅
3. Verify empty range → amber "Not fully checkable" (pre-ceremony); range 2–3 → amber "Signatures checked; anchors not checked"; full chain → red `KEY_UNKNOWN` on the two pre-ceremony rows (correct: their key was never published). ✅
4. Full export → ready → download; pack verified field-by-field (Part G); pending line shown. ✅
5. Auditor repeats 3–4 identically (export grant proven). ✅
6. F12 clean throughout, no CORS errors. ✅
