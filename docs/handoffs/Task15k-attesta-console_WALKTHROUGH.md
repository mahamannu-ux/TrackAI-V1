# Attestation in the Console — Visual Walkthrough Guide (Task15k)

For the founder validating IT-T15k-01 in the browser. All data below is synthetic.
Open the console at `http://localhost:3000/login` (admin: `admin@task5.acceptance.invalid`
/ `task5-acceptance-only`; auditor: `auditor@task5.acceptance.invalid` / `task6-auditor-only`).

## What attestation is (the 30-second version)

For every commit TrackAI observes, every merged PR and every production deployment,
TrackAI writes one short signed **statement** (who, what, when — never code or prompts),
links statements into one **chain** per organization, and **anchors** the chain in public
tamper-evident logs. The console surfaces this in two honesty levels:

- The **attestation card** (commit / PR drawers) reports a *database fact*: "we wrote a
  statement for this". It never claims anything was cryptographically checked.
- **Verify chain** (Administration → Attestation) actually *checks*: signatures against
  the organization's keys and anchors against the public logs. Only its green box is proof.

## Where things live, and who sees them

| Surface | Location | Admin | Auditor | Everyone else |
|---|---|---|---|---|
| Attestation card | Click any commit or PR → drawer, "Attestation" section after the metrics | ✅ | ✅ | ✅ (card only; drawer itself is unchanged) |
| Verify + Export | Administration → Attestation (last item in the section nav) | ✅ | ✅ | Hidden; the API refuses anyway |

## 1. The attestation card

| You see | What it means |
|---|---|
| Nothing (no section content) | The drawer has no repository/SHA to look up (e.g. sessions never show a card) |
| "Checking attestation…" (grey) | Loading; resolves in under a second locally |
| "Not attested yet" (grey) + "Attesta signs a commit after TrackAI observes it…" | No statement for this commit yet — normal for fresh or pre-attestation data |
| "Attestation details need the administrator or auditor role." (no badge) | Your login lacks both roles |
| "Attestation unavailable" (amber) + code | Server or network problem; the code (e.g. `ATTESTA_API_INTERNAL`) is for support |
| One row per statement, oldest first | Kind ("Commit observed" / "Merged" / "Deployed to production" / "Period report"), date, 12 hex characters of the statement fingerprint, and an anchor badge: "Signed · anchored" (green), "Signed · anchoring pending" (amber, inside the 1-hour window), "Signed · anchor overdue" (amber, past it) |
| "Attested when merged." | An still-open PR: there is no merge commit to attest yet |
| Footer line | Points at Verify; a reminder that the card alone is not proof |

You will never see "verified", "proven" or red in this card — that is deliberate.

## 2. Verify chain

The chain is the organization's append-only ledger: each **record** gets the next gap-free
**sequence number** (`seq`: 0, 1, 2, …). "From record" / "To record" are optional bounds on
that counter — leave both empty to check everything (fine for local data; production caps
a run at 10,000 records). Click **Verify chain**; the button disables while it runs.

| Result box | Meaning |
|---|---|
| Green: "Chain verified: N records. Signatures and anchors checked." | Real proof. N records linked, signed and anchored. |
| Amber: "Signatures checked; anchors not checked on this server." | Expected locally: no public-log keys configured, so anchors were skipped — not a pass on anchors. |
| Amber: "Not fully checkable: N records read; some checks could not run." | Some evidence was missing (e.g. signatures never checked); listed row by row below. |
| Red: "Verification found problems in N records." | Something is broken or forged (missing record, broken link, changed content, bad signature or anchor). Each row shows the record number, a plain-language label and the machine code. |

Errors: "already running" (one verify per organization at a time — wait seconds and retry);
"range too large or invalid" (narrow From/To to ≤ 10,000); anything else shows a code plus
a request ID for support.

## 3. Export evidence pack

A pack is one signed file a third party (auditor, acquirer's counsel) can check offline:
the statements in a time window, the chain around them, anchors, public keys and one
signature saying who exported what, when. It never contains prompts, code or secrets.

- **Repository**: "All repositories" or one by name.
- **From / To**: native calendar + clock pickers (click the icons; no typing needed — if the
  icons are invisible, hard-refresh: a recent fix restores them in dark mode). Times are sent
  as UTC. **Set To at least a day in the past**: the server refuses windows younger than
  5 minutes so late-arriving records cannot silently miss the pack.
- **Mode**: Full (default — proves nothing was left out; shows other repositories' record
  IDs/hashes, never content) vs Repository only (for outsiders; hides other repositories, so
  completeness cannot be proven; stays disabled until you pick a repository).
- **Jobs list** (this browser tab only — the API keeps no list): grey while queued/running
  (auto-refreshes every 3 s), green when ready, red when failed.
- **Ready**: Download saves `trackai-evidence-pack-<id>.json`; the fingerprint line identifies
  the file; "`N` statements were not yet anchored; the pack says so." is honesty, not an error.
- **Failed**: shows the code and, when retryable, a **Try again** button (same inputs, fresh key).

## Click-through checklist (IT-T15k-01)

1. As admin, open a commit with a statement → "Signed · anchoring pending/overdue" row.
2. Open a commit without one → "Not attested yet". Open a merged PR → card; an open PR → "Attested when merged."
3. Administration → Attestation → Verify chain (empty range) → amber box (locally expected).
4. Export a Full pack over old data → ready → Download → file saves.
5. Sign out; repeat 3–4 as auditor → identical access.
6. Browser console (F12) shows no CORS error throughout.

## If everything says "Not attested yet"

That means the database holds commits but no statements. Verify/Export still work (empty
chain verifies; empty packs export), but step 1 needs data: re-run the corpus seed if the
lists are empty, then build statements with `npm run attesta:build -w apps/api --
--ephemeral-dev-key` (terminal 3's directory, `DATABASE_URL` set). New statements show
"anchoring pending" with anchoring unconfigured — exactly the state step 1 expects.
