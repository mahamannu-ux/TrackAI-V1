# Handoff prompt: Task15k-attesta-console (attestation status in the console, verify panel, evidence-pack export), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15k-attesta-console && cd ~/AIProjects/TrackAI-wt/Task15k-attesta-console && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; paste everything below the line. Reply "continue" if it stops. Start it after Muse finishes Task15j (one Muse session at a time). No shared files with Claude's Task15i3/15i4 or Muse's Task15m.
> 3. At the end it gives you a short browser walkthrough (§3, IT-T15k-01); run it and tell it what you saw.
> 4. When it finishes, paste its review request to the Task15 lead Claude chat. Push only after "ready to push".

---

You are **Muse**, building **Task15k-attesta-console** (subtask A15.11) for **TrackAI**, an AI code provenance product (Next.js console + Express API).

Attesta signs one statement per commit, merged PR and production deployment, chains them per tenant and anchors them in public logs. The API already serves them (Task15i) and exports signed evidence packs (Task15i2). Nobody can see any of this in the console yet. This session adds three things to the existing dashboard: an **attestation card** in the commit and pull-request drawers, a **verify panel**, and **evidence-pack export**, both in a new Administration section "Attestation". It also fixes the API's CORS settings so the browser can send the two headers these routes use.

**Every decision is made below (this is the lead's design note); do not redesign.** No new API routes, no database, no migration, no new dependency.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15k-attesta-console`, branch `task/Task15k-attesta-console`.
- **Handoff:** `docs/handoffs/Task15k-attesta-console_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §4, §7, §10, §11, §12.4.
2. Check where you are: `pwd && git branch --show-current && git log --oneline -1` (the worktree above, branch `task/Task15k-attesta-console`; otherwise stop). Then `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. `npm test` once; `npm run build -w apps/web` once (baseline).
4. Estimate in one line against T6. The plan says **about 0.1×** (0.08× plus the CORS fix).

## 1. Read (read-only)
- `docs/contracts/attesta/api.md` (routes and conventions), `errors.md` §API and §Verification (codes you will show), `evidence-pack.md` (what a pack is; first two sections only).
- `docs/handoffs/Task15i-attesta-evidence-api_HANDOFF.md` ("Implemented interfaces": the exact JSON of each GET route) and `docs/handoffs/Task15i2-attesta-evidence-packs_HANDOFF.md` ("Implemented interfaces": the pack routes; "Known limitations": the CORS gap).
- `apps/web/src/app/dashboard/page.tsx` (`DetailDrawer` at about line 150, `AdminSection` and its list at about line 191, `AdminPanel`, `Badge`, `Metric`, `TableShell`), `apps/web/src/app/dashboard/fleet-workspace.tsx` (how a workspace component is split out of `page.tsx`), `apps/web/src/lib/api.ts` (`apiFetch`, `apiDownload`, `AdminContext`).
- `apps/api/src/app.ts` lines 45–51 (the `cors(...)` call).

## 2. Scope (approved)
### 2.1 API client (`apps/web/src/lib/api.ts`, append one "Attesta" section)
1. `export class AttestaApiError extends Error { code: string; status: number; requestId: string | null }`.
2. `async function attestaFetch<T>(endpoint, options = {})`: like `apiFetch` (same token and `API_URL`), but on a non-2xx response parse `application/problem+json` `{code, title, status, request_id}` and throw `AttestaApiError(code ?? 'ATTESTA_API_INTERNAL', status, request_id ?? response.headers.get('X-Request-ID'))`; message = `title` or the code. Never put the response body text into the message otherwise.
3. Types copied from the handoffs: `AttestaStatement` (list item: `statement_digest, seq, recorded_at, statement_kind, predicate_type, repository_id, subject_sha, anchor_status: 'anchored'|'pending'|'missing'`, plus `previous?: string[]`), `AttestaVerifyReport` (`report_version, ok, chain_intact, checked, breaks: {seq, kind, detail_code}[], signatures, anchors: {status: 'checked'|'not_checked', anchored?, pending?, missing?, invalid?, not_checkable?}`, `warnings?`), `AttestaPackJob` (`id, status: 'queued'|'running'|'ready'|'failed', scope, mode, counts?, pack_digest?, bytes?, error_code?, retryable?, created_at, finished_at?, content_path?`).
4. Functions: `getAttestaSubject(repositoryId, sha)` → `GET /api/attesta/subjects/{repositoryId}/{sha}` (`{statements}`); `verifyAttestaChain(range?: {fromSeq?, toSeq?})` → `GET /api/attesta/verify` with only the given params; `requestEvidencePack(body: {repository_id?, from, to, mode}, idempotencyKey)` → `POST /api/attesta/evidence-packs` with header `Idempotency-Key`; `getEvidencePack(id)`; `downloadEvidencePack(contentPath)` → `apiDownload(contentPath)` (a Blob).

### 2.2 Attestation card (`apps/web/src/app/dashboard/attestation-card.tsx`, new)
`export function AttestationCard({ repositoryId, sha }: { repositoryId: string | null; sha: string | null })`. Loads `getAttestaSubject` when both are set (re-load when they change; no polling). States and exact wording:

| Situation | Badge (tone) | Line under it |
|---|---|---|
| `repositoryId` or `sha` missing | none; render nothing | — |
| loading | "Checking attestation…" (slate) | — |
| 404 `ATTESTA_API_NOT_FOUND` | "Not attested yet" (slate) | "Attesta signs a commit after TrackAI observes it. This usually takes a few minutes." |
| 401/403 | none | "Attestation details need the administrator or auditor role." |
| any other error | "Attestation unavailable" (amber) | "Could not load attestation (code `<code>`)." |
| statements returned | one row per statement, oldest first | see below |

Per statement row: kind label (`commit_observed` → "Commit observed", `pr_merged` → "Merged", `deployed` → "Deployed to production", `period_report` → "Period report"), `recorded_at` formatted like the page's `date()`, the first 12 hex of the digest in mono, and a badge from `anchor_status`: `anchored` → "Signed · anchored" (green); `pending` → "Signed · anchoring pending" (amber); `missing` → "Signed · anchor overdue" (amber). Footer text, always shown under the rows: "Status from TrackAI's records. Run Verify in Administration → Attestation to check signatures and anchors." **Never** show "verified", "proven" or a red state in this card: `anchor_status` is a database fact, not a cryptographic check (api.md).

Wire it into `DetailDrawer` (minimal change to `page.tsx`): add a prop `attestaSubject: { repositoryId: string | null; sha: string | null } | null`. For a commit: `repositoryId = commits.find(c => c.id === data.id)?.repository?.id ?? null`, `sha = data.sha`. For a pull request: from the `pullRequests` list row of that id, `repositoryId = row.repositoryId`, `sha = row.mergeCommitSha` (null while open, so the card shows nothing; add the line "Attested when merged." for an open PR). Render a `<section className="mt-7">` titled "Attestation" with the card, after the metrics grid. Sessions get no card.

### 2.3 Administration → Attestation (`apps/web/src/app/dashboard/attesta-workspace.tsx`, new)
Add `'attestation'` to `AdminSection` and `{ id: 'attestation', label: 'Attestation', description: 'Verify the signed ledger and export evidence' }` to the list (after `audit`), rendering `<AttestaWorkspace repositories={...} />`. Shown to administrators and auditors (both roles have `attesta.read` and `attesta.export`); no other role sees it (the API refuses anyway).

**Verify panel.** Two optional number inputs "From record" / "To record" and a button "Verify chain". On click call `verifyAttestaChain`; disable the button while running. Result, exact wording:
- `ok: true` → green box "Chain verified: `<checked>` records. Signatures and anchors checked." (if `anchors.status === 'not_checked'`, say "Signatures checked; anchors not checked on this server." and use amber instead).
- `ok: false` and every break's `detail_code` is `ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED` or `ATTESTA_VERIFY_NOT_CHECKABLE` → amber box "Not fully checkable: `<checked>` records read; some checks could not run." plus the list.
- otherwise → red box "Verification found problems in `<n>` records." plus the list.
- List (at most 50 rows, then "and `<n>` more"): `seq`, a plain-language label, the code in mono. Labels: `ATTESTA_VERIFY_SEQ_GAP` "A record is missing", `ATTESTA_VERIFY_PREV_HASH_MISMATCH` "Link to the previous record is broken", `ATTESTA_VERIFY_RECORD_HASH_MISMATCH` "Record content changed", `ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH` "Statement content changed", `ATTESTA_VERIFY_SIGNATURE_INVALID` "Signature does not verify", `ATTESTA_VERIFY_KEY_UNKNOWN` "Signed with an unknown key", `ATTESTA_VERIFY_KEY_NOT_VALID_AT` "Key was not valid at that time", `ATTESTA_VERIFY_MERKLE_PROOF_INVALID` "Anchor proof does not match", `ATTESTA_VERIFY_ANCHOR_INVALID` "Anchor does not verify", `ATTESTA_VERIFY_ANCHOR_MISSING` "Not anchored in time", `ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED` "Signatures not checked", `ATTESTA_VERIFY_NOT_CHECKABLE` "Not checkable"; any other code → "Other problem".
- Errors: 429 → "A verification is already running for your organization. Try again in a few seconds."; 400 → "That range is too large or invalid. Choose at most 10 000 records with From/To."; others → "Verification unavailable (code `<code>`, request `<id>`)."

**Evidence packs.** A form: Repository (select: "All repositories" plus each repository by name), From and To (`datetime-local`, sent as UTC ISO strings with `Z`), Mode (radio: "Full (default): proves nothing was left out; shows other repositories' record metadata (IDs, commit hashes), never their content" / "Repository only: for outsiders; hides other repositories; completeness cannot be proven"; "Repository only" is disabled until a repository is chosen). Button "Export evidence pack": generate `idempotencyKey = crypto.randomUUID()`, call `requestEvidencePack`, then poll `getEvidencePack(id)` every 3 seconds until `ready` or `failed` (stop polling when the component unmounts). Jobs started in this browser tab are listed (newest first; this list is in memory only, say so in a small note: "Packs requested in this tab. The API has no pack list yet."). Each job: status badge (`queued`/`running` slate, `ready` green, `failed` red), scope summary, counts (`statements`, `anchored`, `pending`), and:
- `ready` → button "Download" (`downloadEvidencePack(content_path)`, saved as `trackai-evidence-pack-<id>.json`), the `pack_digest` in mono, and when `counts.pending > 0` the amber line "`<n>` statements were not yet anchored; the pack says so."
- `failed` → "Export failed (code `<error_code>`)." and, when `retryable` is true, a "Try again" button (new idempotency key, same inputs).
- A 409 `ATTESTA_API_CONFLICT` cannot happen with fresh keys; show its title if it does.

### 2.4 CORS (`apps/api/src/app.ts`, the `cors(...)` call only)
`allowedHeaders` gains `'Idempotency-Key'` and `'X-Request-ID'`; add `exposedHeaders: ['X-Request-ID', 'Content-Disposition', 'Retry-After']`. Nothing else in `app.ts` changes. New test `apps/api/src/app-cors.test.ts` (register it in `apps/api/package.json`'s `test` script): an `OPTIONS` preflight to `/api/attesta/evidence-packs` from an allowed origin with `Access-Control-Request-Headers: idempotency-key,x-request-id,authorization,content-type` returns those headers in `Access-Control-Allow-Headers`; a `GET /health` response carries `Access-Control-Expose-Headers` including `X-Request-ID`. Use the allowed-origin helper the file already uses (read it; do not invent one).

### 2.5 Port from
Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` UI-1 (verdict card wording: "attested / anchored / pending / broken"; auditor sees no write controls beyond the export the role allows). No code to port: TrackAI's console uses its own Tailwind components (`Badge`, `Metric`, `TableShell`); reuse them.

### 2.6 Pre-approved files
`apps/web/src/lib/api.ts` (the appended Attesta section only), `apps/web/src/app/dashboard/attestation-card.tsx` (new), `apps/web/src/app/dashboard/attesta-workspace.tsx` (new), `apps/web/src/app/dashboard/page.tsx` (only: the `DetailDrawer` prop and section, passing the subject, the `AdminSection` entry and its render line), `apps/api/src/app.ts` (the `cors(...)` options only), `apps/api/src/app-cors.test.ts` (new), `apps/api/package.json` (test script registration only), `docs/handoffs/Task15k-attesta-console_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (its registry row only), `docs/plan/TASK15.md` (A15.11 status only).

### 2.7 Never touch
`docs/contracts/`, every migration, everything under `apps/api/src/features/` (the API is done), `apps/api/src/core/`, other dashboard components (`fleet-workspace.tsx`, `evidence-workspace.tsx`), dependencies (`package.json` dependencies, `package-lock.json`). If something seems to need one of these, stop and say so.

## 3. Working rules
- Commits `Task15k-attesta-console: …`: API client; card and drawer wiring; workspace (verify, packs); CORS and test; handoff.
- Gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w apps/web`, `npm run check` clean.
- The web app has no unit tests (AGENTS.md §10); keep logic that decides wording in small pure functions at the top of each new file (`cardState(...)`, `verifyVerdict(report)`, `breakLabel(code)`) so a reviewer can read them in one place.
- No raw content anywhere: the console shows digests (12 hex), short shas, counts, codes and times only.
- **Founder walkthrough `IT-T15k-01`** (blocking this merge; give these exact steps in your final reply): start the API and web as `docs/TASK5_LOCAL_ACCEPTANCE_RUNBOOK.md` says, with anchoring env unset; as an administrator open a commit with a statement (card shows "Signed · anchoring pending" or "anchor overdue"), a commit without one ("Not attested yet"), Administration → Attestation → Verify chain (amber "anchors not checked" or "Not fully checkable" is expected without production keys), export a Full pack and download it; as an auditor repeat Verify and Export; confirm the browser console shows no CORS error.
- **Review:** re-read your full diff as a reviewer before the handoff (AGENTS.md §12.3): check every string against the tables above, and that no state says "verified" unless `ok` is true.

## 4. Close-out
- Handoff (`docs/templates/HANDOFF_TEMPLATE.md`), under 60 lines: what each screen shows, the CORS change, IT-T15k-01 steps, Effort.
- Registry row `IT-T15k-01` (⬜ founder run), inserted in ID order; `TASK15.md` A15.11 row 🟡. Leave the status board's Task15 row to the lead (AGENTS.md §9 item 23). Final bash block: preflight before merge (§9 item 22).
- Clean tree; do not push. Final reply in the AGENTS.md §12.4 shape, with the review request (for the Task15 lead Claude chat) in a `text` block.

## Lessons so far
- **Task15i2 (Claude):** the CORS allow-list lacked `Idempotency-Key` and `X-Request-ID`; browser calls fail on preflight, not in unit tests. That is why §2.4 exists.
- **Task9e (Muse, fleet console):** keep a new workspace in its own file and touch `page.tsx` only to mount it.
- **Task15b/15e (Muse):** honest states: a check that could not run is never shown as a pass.
