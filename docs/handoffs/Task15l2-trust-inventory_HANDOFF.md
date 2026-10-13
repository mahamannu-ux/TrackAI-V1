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
| Tests | 30 new unit tests (721 in total); IT-T15l-01…04 pass in the sandbox (42 guard attacks) | 🟡 founder run ⬜ |
| Review | Review subagent: 2 must-fix and 7 should-fix findings. 2 must-fix and 5 should-fix are fixed (commit `ff3c71d`); 2 should-fix are documented below. Codex review ⬜ | 🟡 |

## Implemented interfaces
```ts
registerKey(ctx, { tenantId | null, purpose, adapterName, credentialRef, validDays? })  // proof of possession, keyid unique everywhere
planTenantKeyCommand / applyTenantKeyCommand(ctx, 'activate'|'retire'|'revoke', { tenantId, keyid, replace?, reason?, compromisedSince? }, expect)
exportRootDraft(ctx, { add?, retire?, revoke?, reason?, compromisedSince?, rootSpkis?, threshold? })  // unsigned body + current root
importRoot(ctx, envelope, expect)             // checked with verifyTrusted from the pin; platform rows synced to it
publishKeyset(ctx, tenantId)                  // forward-only before signing; signed by the root-listed tenant_keyset key
inventorySignerResolver(store, adapters): SignerResolver     // the builder's resolver (A15.8)
platformSigner(store, adapters, purpose, config): { adapter, credentialId, keyid }
publishedKeysFor(store, tenantId): { keys, rootDocuments, keysetDocuments }   // for 15i2: verifyChain keys + packs
pgTrustStore(db); adaptersFromEnv(env); trustConfigFromEnv(env); platformAnchorSignerFromEnv(env)
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
- **Review fixes beyond the prompt:**
  - `export-root-draft` adds only keys named with `--add <keyid>`. Otherwise any database writer's row would reach the offline signature.
  - The anchor key is resolved again on every call, so a root import takes effect in a running worker at once.
  - A pin is required in development too.
  - `retire`, `activate --replace` and `revoke superseded` of the active key wait until every record that key signed is anchored. Otherwise those records could never verify. `compromised` is not delayed.
  - Updates are compare-and-set.
  - Publish refuses to extend a stored key set that no `tenant_keyset` key ever signed.
  - The reserved platform tenant ID is refused as `--tenant`.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | **`verify-chain.test.ts` "an anchor older than the record…" now fails on `main`.** It is a Task15f2 time bomb: it anchors at the fixed time 2026-10-12T09:00Z, and FakeTsa's certificate is valid only from now − 1 day. It started failing 2026-10-13 ~09:00Z. This branch does not touch it, and it was not pre-approved here. | `npm test` and CI are red until fixed. **FOUNDER:** have the 15i or 15i2 session (or Codex) change that test to an anchor time relative to `Date.now()`. |
| 🟡 | Statements signed but not yet chained when a key is retired are not counted by the anchoring check | Run the builder and anchor passes before rotating (procedure below) |
| 🟡 | Anyone with database write access can add a tenant key with events (no proof is re-checked) or a shape-valid document. Platform keys and documents are re-verified from the pin on every use; a forged root row is a permanent denial of service (append-only) | Recovery: the database owner disables the 0019 triggers, removes the row and re-enables them (audited outside the app). Keep database write access to the API role. |
| 🟡 | `--expect` counts changes; it does not pin which keyids. Compare-and-set and the applied output printing the exact keys narrow this. Revocation times come from the CLI host's clock | Run apply right after the dry run. Clock skew can only make publish refuse (fail closed). |

## Integration test impact
IT-T15l-01…04 (`apps/api/src/features/attesta/t15l2-trust-live-verify.ts`): `scripts/it-db.sh npm run verify:task15l2-trust-live -w apps/api`. They need PostgreSQL 16 with pgvector (Docker or local binaries) and take about 30 s. They are **blocking** for this merge and for 15i2. They passed in the agent sandbox (🟡); the founder run is ⬜.

## Integration notes
- **15i2:** `const p = await publishedKeysFor(pgTrustStore(db), tenantId)`, then pass `p.keys` to `verifyChain`. Packs carry `p.rootDocuments` and `p.keysetDocuments` (both from version 1). `attesta-build-cli.ts` (not pre-approved here) still builds with `devSignerResolver`, which refuses production: its production branch becomes `inventorySignerResolver(pgTrustStore(db), await adaptersFromEnv())` (15i2 or Task14).
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
| 0.2× (prompt); 0.25× with the review round | about 0.25× | ~75 turns + 1 review round | ~2 h | ~0.45M |
