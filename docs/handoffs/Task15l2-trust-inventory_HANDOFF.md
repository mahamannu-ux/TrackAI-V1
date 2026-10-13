# Task15l2-trust-inventory Handoff — Attesta trust inventory, part 2 of A15.12

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15l2-trust-inventory`, base `main` at `664b241`. It adds the key inventory (migration 0019), proof-of-possession registration, the production resolvers, key-set publishing, root import and the online `attesta:keys` CLI. It adds no routes (15i2 wires `publishedKeysFor`), no GitAI change, no UI and no real KMS run (A15.13).

## At a glance
| | Item | Status |
|---|---|---|
| Migration 0019 | `attesta_platform_keys`, `attesta_tenant_keys` (composite tenant key, one active key per tenant), append-only `attesta_key_events` and `attesta_trust_documents`; guards in the 0017/0018 style | ✅ applied on a throwaway database through `scripts/it-db.sh`; `drizzle-kit check` clean |
| Service (`trust-inventory.ts`) | `registerKey` (proof of possession), activate / retire / revoke, `exportRootDraft`, `importRoot`, `publishKeyset`, `TrustStore` (pg + memory) | ✅ |
| Resolvers (`trust-resolver.ts`) | `inventorySignerResolver`, `platformSigner`, `publishedKeysFor`, `adaptersFromEnv`, `trustConfigFromEnv`; `anchor-env` production branch | ✅ |
| CLI | `npm run attesta:keys -w apps/api -- register\|activate\|retire\|revoke\|publish\|export-root-draft\|import-root\|list` | ✅ |
| Tests | 34 new unit tests (756 in total after merging main, all passing); IT-T15l-01…04 pass in the sandbox (42 guard attacks) | ✅ founder run 2026-10-13 |
| Review | Subagent: 2 must-fix + 7 should-fix (all but 2 should-fix fixed, `ff3c71d`). Codex round 1 "fix first": 3 fixes, all done (resolver needs the published key set, publish re-checks under lock, anchor verify keys from the root). Codex round 2 "fix first": anchor keys bound to their signing windows, fixed. Codex round 3: ready to push | ✅ |

## Implemented interfaces
```ts
registerKey(ctx, { tenantId | null, purpose, adapterName, credentialRef, validDays? })  // proof of possession, keyid unique everywhere
planTenantKeyCommand / applyTenantKeyCommand(ctx, 'activate'|'retire'|'revoke', { tenantId, keyid, replace?, reason?, compromisedSince? }, expect)
exportRootDraft(ctx, { add?, retire?, revoke?, reason?, compromisedSince?, rootSpkis?, threshold? })  // unsigned body + current root
importRoot(ctx, envelope, expect)             // checked with verifyTrusted from the pin; platform rows synced to it
publishKeyset(ctx, tenantId)                  // forward-only before signing; signed by the root-listed tenant_keyset key
inventorySignerResolver(store, adapters, config): SignerResolver  // the builder's resolver (A15.8); only keys the latest signed key set lists
platformSigner(store, adapters, purpose, config): { adapter, credentialId, keyid }
publishedKeysFor(store, tenantId): { keys, rootDocuments, keysetDocuments }   // for 15i2: verifyChain keys + packs
platformKeyWindows(store, purpose, config): AnchorKeyWindow[]  // every key of a purpose in the latest verified root + its signing window
pgTrustStore(db); adaptersFromEnv(env); trustConfigFromEnv(env); platformAnchorSignerFromEnv(env); platformAnchorKeysFromEnv(env)
```
CLI dry run (the default): `npm run attesta:keys -w apps/api -- activate --tenant <uuid> --keyid sha256:… --replace` prints `retire … active -> retired`, `activate … registered -> active` and `apply with: --confirm=ACTIVATE --expect=2 --actor <your name>`. New environment variables: `ATTESTA_TRUST_ROOT_KEYIDS` (always required to import a root or sign with a platform key), `ATTESTA_KMS_CREDENTIALS_FILE` (references only), `ATTESTA_DEV_CREDENTIALS_FILE` (development only).

## Guards (each refused in IT-T15l-03 as the API role and as an RLS-bound role)
| Guard | Test |
|---|---|
| A keyid is registered once across both key tables, every tenant and every purpose (`ATK01`, `SECURITY DEFINER`, so it also sees keys the RLS role cannot) | "keyid reused by another tenant / for the platform", "rls-role B reuses A's keyid it cannot see" |
| A new key starts as `registered` | "key inserted active" |
| Status only moves forward. `not_after` never grows. `spki_der`, `keyid`, `purpose`, `not_before`, the credential and the tenant never change. `revoked_at` and `compromised_since` never move later | "status back to active", "spki_der mutated", "not_after grows", "compromised_since later" |
| Every key UPDATE has its `attesta_key_events` row in the same transaction (deferred, checked at commit); a platform key also needs the `import_root` event | "activate / revoke without an event" (fails at commit) |
| A platform key's row equals what the latest stored root document lists for it | "platform key not as the latest root lists" |
| Documents: next version only, `previous` = the stored digest of the version before, columns read from the signed payload; append-only | "document version skips / previous wrong / columns not the payload / updated / deleted" |
| No DELETE or TRUNCATE on any of the four tables; events are append-only | "key deleted", "truncated", "event updated / deleted" |

## Deviations
- **Resolvers take a `TrustStore`** (`pgTrustStore(db)` in production), not `db` directly. This lets the unit tests run the same code on the memory store. Tenant queries bind `tenant_id` explicitly, as `ledger.ts` does, rather than going through `withTenant` (raw SQL inside transactions).
- **`credential_ref` stores the adapter credential ID** (`aws-kms:…`), which names the KMS key through `ATTESTA_KMS_CREDENTIALS_FILE`. It never appears in output.
- **The import-root sync uses per-key `activate` / `retire` / `revoke` events plus one `import_root` event**, and the guard requires both.
- **Subagent fixes:** `export-root-draft` adds only `--add <keyid>` keys; the anchor key is re-resolved on every call; the pin is required in development too; `retire` / `--replace` / `revoke superseded` wait until the key's records are anchored (`compromised` never waits); compare-and-set updates; publish refuses to extend a key set no `tenant_keyset` key signed; the platform tenant ID is refused as `--tenant`.
- **Codex fixes:** (1) the resolver signs only with a key the latest verified key set lists active with the same SPKI and validity. Between `activate` and `publish` it throws `SigningUnavailable` (row stays pending with backoff) rather than returning `null`, which would fail rows terminally on every routine activation. (2) Publish locks the tenant's keys (`FOR UPDATE`) and re-checks the exact planned key state before storing. (3) Anchor verify material lists every anchor key of the latest verified root, rebuilt per call (`platformAnchorKeysFromEnv` / `platformKeyWindows`). Round 2 (founder-approved edit of `anchor-dual.ts`, additive): `StoredAnchorKeys.anchorKeyWindows`; when present, a Rekor anchor counts only if its `integratedTime` lies in [not_before, not_after] and before `revoked_at` (retired, superseded) or `compromised_since` (trust.md step 8). `verify-chain.ts` is unchanged (it passes the keys through).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ✅ | `verify-chain.test.ts` anchor fixture was a Task15f2 time bomb (fixed anchor time, FakeTsa certificates dated from `Date.now()`), failing on `main` since 2026-10-13 | Fixed here (founder decision 2026-10-13): the fixture issues the fake TSA certificates as of its anchor time; `npm test` green |
| 🟡 | Statements signed but not yet chained when a key is retired are not counted by the anchoring check; a key set left unpublished for 31 days stops the builder (fail closed) | Run the builder and anchor passes before rotating; Task14 schedules the weekly publish |
| 🟡 | Anyone with database write access can add a tenant key with events (no proof is re-checked) or a shape-valid document. Platform keys and documents are re-verified from the pin on every use; a forged root row is a permanent denial of service (append-only) | Recovery: the database owner disables the 0019 triggers, removes the row and re-enables them (audited outside the app). Keep database write access to the API role. |
| 🟡 | `--expect` counts changes; it does not pin which keyids. Compare-and-set and the applied output printing the exact keys narrow this. Revocation times come from the CLI host's clock | Run apply right after the dry run. Clock skew can only make publish refuse (fail closed). |

## Integration test impact
IT-T15l-01…04 (`apps/api/src/features/attesta/t15l2-trust-live-verify.ts`): `scripts/it-db.sh npm run verify:task15l2-trust-live -w apps/api`. They need PostgreSQL 16 with pgvector (Docker or local binaries) and take about 30 s. They are **blocking** for this merge and for 15i2. ✅ founder run 2026-10-13 (agent-verified the same day).

## Integration notes
- **15i2:** `const p = await publishedKeysFor(pgTrustStore(db), tenantId)`, then pass `p.keys` to `verifyChain`. Packs carry `p.rootDocuments` and `p.keysetDocuments` (both from version 1). Anchor checks pass `anchorKeyWindows: await platformKeyWindows(store, 'anchor', config)` per run (never a bare SPKI list in production). `attesta-build-cli.ts` (not pre-approved here) still builds with `devSignerResolver`, which refuses production: its production branch becomes `inventorySignerResolver(pgTrustStore(db), await adaptersFromEnv(), trustConfigFromEnv())` (15i2 or Task14).
- **A15.13 founder-live steps:**
  1. Create one KMS key per platform purpose and list them in `ATTESTA_KMS_CREDENTIALS_FILE` (`tenantId` = `00000000-0000-0000-0000-000000000000`).
  2. Run `register --purpose <p>` for each.
  3. Run `export-root-draft --root-pub <offline root pub> --add <keyid>… --out draft.json`.
  4. On the offline machine: `attesta:trust-root sign --draft draft.json --key root.pem --out root.json`.
  5. Run `import-root --file root.json` with `ATTESTA_TRUST_ROOT_KEYIDS` set.
  6. Register and activate each tenant key, then run the first `publish --all-tenants`. Task14 schedules a weekly `publish --all-tenants`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens |
|---|---|---|---|---|
| 0.2× (prompt); 0.25× with the review round | about 0.3× | ~100 turns + subagent and 2 Codex rounds | ~3 h | ~0.6M |
