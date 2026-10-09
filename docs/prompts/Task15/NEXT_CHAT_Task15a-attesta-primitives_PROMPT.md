# Handoff prompt: Task15a-attesta-primitives (canonical JSON, Merkle trees, DSSE envelopes), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Approve the one new dependency below (`canonicalize`) by merging the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15a-attesta-primitives && cd ~/AIProjects/TrackAI-wt/Task15a-attesta-primitives && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line. Reply "continue" if it stops.
> 3. When it finishes, paste its review request to the Task15 lead Claude chat (or Codex if Claude is busy). Push only after "ready to push".

---

You are **Muse**, building **Task15a-attesta-primitives** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product. Attesta (Task15, `docs/plan/TASK15.md`) will sign and chain provenance statements. This session builds three pure, dependency-light libraries every later Attesta session uses. **Every decision is made below; do not redesign.** No database, no routes, no UI.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15a-attesta-primitives`, branch `task/Task15a-attesta-primitives`.
- **Handoff:** `docs/handoffs/Task15a-attesta-primitives_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §5a, §6, §9 items 16–21, §11, §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`: you must be in the worktree above on `task/Task15a-attesta-primitives`; otherwise stop. `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (150 pass expected).
4. Estimate one line against T6; the plan says **about 0.08×**.

## 1. Read (source of the port, read-only)
`git -C ~/dev/sushicorp show 0bd67a5:<path>` for: `core/evidence/canonical.py`, `core/evidence/merkle.py`, `tests/unit/evidence/test_evidence_canonical.py`, `tests/unit/evidence/test_evidence_merkle.py`, and the 12 files in `tests/unit/evidence/jcs_vectors/` (`input_*.json` / `output_*.json` for arrays, french, structures, unicode, values, weird). Catalog: `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` EV-1 and EV-2.

## 2. Scope (approved)
### 2.1 Decisions
1. **Directory:** `apps/api/src/features/attesta/` (new). Files: `canonical.ts`, `merkle.ts`, `dsse.ts`, their tests `canonical.test.ts`, `merkle.test.ts`, `dsse.test.ts`, and `vectors/jcs/` (the 12 SushiCorp vector files copied byte for byte).
2. **Dependency (founder-approved):** `canonicalize` (RFC 8785 reference implementation) added to `apps/api/package.json` `dependencies` with an exact version (`npm install canonicalize@<latest> --save-exact -w apps/api`). No other dependency. Do not hand-roll JCS.
3. **`canonical.ts`:**
   - `export class CanonicalizationError extends Error {}`
   - `export function canonicalize(value: unknown): string`: first walk the value and throw `CanonicalizationError` for `NaN`, `±Infinity`, integers outside `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER` (check `Number.isInteger(v) && !Number.isSafeInteger(v)`), `bigint`, `undefined` inside arrays or as a value, functions, symbols, `Date`, `Map`, `Set`, class instances (only plain objects with `Object.getPrototypeOf(o) === Object.prototype || null`), and strings containing lone surrogates; then return the `canonicalize` package's output.
   - `export const HASH_PREFIX = 'sha256:'`, `export const GENESIS_PREV_HASH = 'sha256:' + '0'.repeat(64)`.
   - `export function sha256Prefixed(data: Buffer | string): string` → `'sha256:' + lowercase hex`.
   - `export function computeRecordHash(canonical: string, prevHash: string): string` → `sha256Prefixed(Buffer.concat([utf8(canonical), utf8(prevHash)]))`; throw `CanonicalizationError` unless `prevHash` matches `/^sha256:[0-9a-f]{64}$/`.
   - `export function hashBytes(prefixed: string): Buffer` → the 32 raw bytes after the prefix (same validation).
   - Header comment: `Ported from SushiCorp B3 core/evidence/canonical.py @ 0bd67a5 (catalog EV-1)` plus one line per deviation.
4. **`merkle.ts`** (RFC 6962 / 9162, same shape as SushiCorp `merkle.py`):
   - `leafHash(data)` = SHA-256(0x00 ‖ data); `nodeHash(l, r)` = SHA-256(0x01 ‖ l ‖ r); `merkleRoot(leaves: Buffer[]): Buffer` (throw on empty); `inclusionPath(leaves, index): Buffer[]`; `rootFromPath(leaf, index, treeSize, path): Buffer` (throw on index ≥ treeSize, wrong path length); `verifyInclusion(leaf, index, treeSize, path, expectedRoot): boolean` using `crypto.timingSafeEqual`.
   - `export interface InclusionProofJson { leaf_index: number; tree_size: number; path: string[] /* lowercase hex */ }` with `proofToJson` / `proofFromJson` (validate types, hex length 64, ranges).
5. **`dsse.ts`** (DSSE v1, https://github.com/secure-systems-lab/dsse):
   - `export function pae(payloadType: string, payload: Buffer): Buffer` = `"DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, lengths as ASCII decimal of byte lengths.
   - `export interface DsseEnvelope { payload: string /* base64 */; payloadType: string; signatures: { keyid: string; sig: string /* base64 */ }[] }`
   - `export type SignFn = (pae: Buffer) => Promise<{ keyid: string; sig: Buffer }>`; `export async function signEnvelope(payloadType, payload, sign: SignFn): Promise<DsseEnvelope>`.
   - `export function verifyEnvelope(env: DsseEnvelope, keys: Record<string /* keyid */, crypto.KeyObject>): { ok: boolean; verifiedKeyids: string[]; errors: string[] }`: ECDSA P-256 / SHA-256, signatures DER-encoded; never throws on malformed input (returns errors); ok only if at least one signature verifies and no signature uses an unknown keyid.
   - `export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json'`.
6. **Tests** (node:test, in-process, no network):
   - canonical: every SushiCorp vector pair (input parsed with `JSON.parse`, output compared byte for byte); the RFC 8785 Appendix B number cases from `test_evidence_canonical.py` (decode the IEEE-754 hex to a double with `Buffer.readDoubleBE`); each refusal in decision 3; key order by UTF-16 code units (`{"€":1,"\r":2,"1":3,"😀":4}` style case as in the source); fixed point (canonicalize(parse(canonicalize(x))) === canonicalize(x)) over a handful of nested samples; `computeRecordHash('{"a":1}', GENESIS_PREV_HASH)` equals `sha256:c130ff982818a1918a815cc089bdd2cbf7a00146c2fd354c5fe1db5b15574397` (SushiCorp's `test_record_hash_known_answer`); a malformed `prevHash` such as `sha256:XYZ` throws.
   - merkle: the RFC 6962 known roots for sizes 1–8 (`CT_LEAVES` / `CT_ROOTS` in `test_evidence_merkle.py`, copy exactly); domain separation; empty refused; every leaf of trees sized 1–33 proves inclusion; a proof for one leaf fails for another and for a wrong tree size; an interior node cannot pass as a leaf; JSON round trip and rejection of bad JSON.
   - dsse: PAE known answer `pae('http://example.com/HelloWorld', Buffer.from('hello world'))` equals `DSSEv1 29 http://example.com/HelloWorld 11 hello world`; sign/verify round trip with a P-256 key generated in the test; tampered payload, tampered payloadType, unknown keyid, empty signatures, malformed base64 all return `ok: false` without throwing.
7. **Register tests:** append exactly ` src/features/attesta/*.test.ts` (one space, then the glob) to the end of the `test` script in `apps/api/package.json`. Another Attesta session makes the identical edit; do not change the line otherwise.

### 2.2 Port from
SushiCorp `core/evidence/canonical.py`, `core/evidence/merkle.py` and their tests @ `0bd67a5` (catalog EV-1, EV-2). DSSE is new (SushiCorp has none). Record provenance and deviations in the file headers and the handoff (`~/dev/agent-kit/reuse/PORTING_GUIDE.md`).

### 2.3 Pre-approved files
`apps/api/src/features/attesta/**` (the files above), `apps/api/package.json` (the dependency and the test-script edit only), `package-lock.json`, `docs/handoffs/Task15a-attesta-primitives_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (add your row), `docs/plan/TASK15.md` (A15.1 status only).

### 2.4 Never touch
Everything else, including `core/`, other features, migrations, `docs/contracts/`, `apps/web/`. If something seems to need another file, stop and describe it.

## 3. Working rules
- Commits `Task15a-attesta-primitives: …`, explicit `git add <path>`: vectors and tests first, then each library.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean. Integration tests: none.
- Re-read your full diff as a reviewer before the handoff (AGENTS.md §12.3).

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 70 lines, with "Ported from", the test counts, and Effort.
- Status board row; `TASK15.md` A15.1 status 🟡 (unit-tested; merged later makes it ✅).
- Clean tree; do not push.
- Final reply in the AGENTS.md §12.4 shape, with the review request in a `text` block naming branch and commit.
