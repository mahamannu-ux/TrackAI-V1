# TrackAI reuse map (SushiCorp → TrackAI)

*Written 2026-10-07 by TrackAI-Orchestrator against agent-kit 0.1.0 `reuse/COMPONENT_CATALOG.md` and SushiCorp `master` @ `0bd67a5`. Reuse is worth it only when it lowers effort or raises quality (AGENTS.md §5a). Every port records `Ported from SushiCorp <module> @ 0bd67a5 (catalog <ID>)` and its deviations.*

## 1. Classification of all 18 catalog components

Classes: **built** = TrackAI already has it (compare); **as-is** = port the design unchanged; **changes** = port with changes; **no** = not needed.

```text
ID    Component                              Class    Where in TrackAI        Why / what to take
EV-1  Hash-chained evidence log             changes  Task15 Attesta          Nothing chained today. Take hash rule, genesis, gap-free seq via chain_head FOR UPDATE,
                                                                             guard triggers (SECURITY DEFINER under RLS), stored canonical bytes, 14-kind verify
                                                                             report, JCS + RFC 6962 vectors, 10k tamper matrix. Change: record = attribution/audit
                                                                             statement, sealing in a Node pg transaction.
EV-2  Anchoring: Rekor, RFC 3161, verifier  changes  Task15 Attesta          The heart of Attesta. Take batch design, inclusion_proof v1, export format (renamed),
                                                                             fake Rekor/TSA as specs, lying-log cases, independent offline verifier. Rewrite adapters
                                                                             in TS (sigstore-js or HTTP; pkijs/asn1js). Close SushiCorp's open gaps while porting:
                                                                             TSA revocation, genTime bound, bounded caches, Rekor v2 (tiles) adapter.
TR-1  Trust and three-state revocation      changes  Task15 Attesta          Only the REVOKED/CLEAN/UNKNOWN rule (UNKNOWN is never CLEAN) for TSA and signer
                                                                             certificates. The media verdict matrix is not needed.
SG-1  Signer adapters, KMS, inventory       changes  Task15 (+D6.1, P6.8,    Contract rev 1.1 (public chain separate from sign; Unavailable vs Rejected), verify-
                                                     T14.2, T14.7)          before-use, public-only inventory, rotation. TS: @aws-sdk/client-kms, @google-cloud/kms,
                                                                             @noble/curves for deterministic ECDSA. Certificates optional (plain keys may do).
SG-2  C2PA manifests                         no       —                       Media provenance; code uses git digests.
TN-1  Tenant isolation below the API        built    core/db/tenant.ts       withTenant ≈ guarded session. Take: composite (tenant_id, id) FKs for Task1/Task2 tables
                                                                             and the cross-tenant test cases. Review 0000's email-domain browser policies.
AU-1  Read-only auditor                      built    tenant_auditor role     Take the route-table sweep test (every mutating route denied) and optionally a SELECT-only
                                                                             DB role. Attesta verify/export must be auditor-reachable reads.
ID-1  API keys                               built    trk_v1 credentials      TrackAI's is richer (overlap rotation, machine binding). Keep.
ID-2  OIDC SSO, memberships, invitations     built    Supabase JWT + member.  SushiCorp's ID2 was ported from TrackAI and hardened. Back-port into TrackAI (Task8):
                                                                             exact issuer/audience checks, membership-based tenant selection instead of email
                                                                             domain, expiring auditor invitations.
PO-1  Signed OPA bundles, replayable        changes  Task6.b Policy (later)  ~30% of P6.8: deterministic build, digest pinning, stored-input replay, "simulate writes
      decisions                                                              nothing", every-rule-tested, pure-library signature check. Not the format (Cedar/CEL/JSON),
                                                                             not distribution (endpoints), not the single-key trust model.
CF-1  Settings catalog and layering          changes  later (Task6.b/Task10)  Typed keys with bounds, scopes, effective-dated history, provenance. Attesta starts with a
                                                                             small typed config; adopt CF-1 when settings multiply.
RP-1  Signed compliance reports              changes  Task15 (+Task12)       Statement-signing pattern (sign JCS of a small statement with digests, then anchor it);
                                                                             first use: sign Task4 evidence-export manifests. Drop jurisdiction sections.
AP-1  API conventions                        changes  new Attesta routes     RFC 7807 problems, keyset paging, X-Request-ID; adopt for new routes; repo-wide in Task11.
SD-1  SDKs and contract suite                no (now) Task11                 TrackAI has no SDK yet; the shared cases.json pattern later suits GitAI↔TrackAI checks.
WH-1  HMAC webhooks with replay claims       built    features/scm (inbound)  Inbound GitHub verification + delivery ledger exist. Port only for outbound webhooks
                                                                             (Task11 T11.6).
UI-1  Console design system, baselines       changes  Task10 (+Attesta UI)   UX rules, WCAG tokens, auditor-sees-no-write-controls sweep, Playwright baselines;
                                                                             an "attested / anchored / pending / broken" verdict card for Attesta.
BN-1  Perceptual soft-binding                no       —                       Media hashing.
TL-1  Throwaway Postgres, demo seed          built    scripts/it-db.sh        Adopted in the kit PR; the guarded demo-seed pattern can follow.
```

## 2. Back-port candidates (TrackAI → SushiCorp or the kit)

- Envelope encryption with AAD bound to tenant, purpose, resource, stage and key version (`core/security/envelope-encryption.ts`).
- Staged credential rotation with overlap and explicit finish/revoke steps (GitHub App credentials, machine credentials).
- Provider delivery ledger with lease, idempotency and ordered projection cursors (`features/scm/provider-delivery-store.ts`).
- Task5's privacy floor (consent, pre-storage redaction, audited raw reveal, deletion propagation to derived indexes).

These go to the founder as kit notes; nothing is changed in SushiCorp from here.

## 3. Attesta (Task15): what it starts from

**Port list (SushiCorp @ `0bd67a5`):**
- Code: `core/evidence/{canonical,records,verify,merkle,anchoring,events}.py`; `db/repositories/{decisions,evidence}.py`; migrations `0001_initial_schema.py` (chain_head, decisions, evidence_records guards) and `0007_signing_inventory.py`; `adapters/anchor/{base,rekor,rfc3161,tsa,dual,rfc6962,keys,registry}.py`; `services/anchoring/{service,export,offline_verify,verifier}.py`; `adapters/signing/{base,kms,kms_aws,kms_google,certificates,inventory,local_dev}.py`; `services/reporting/{signing,models}.py`; `contracts/schemas/decision_record.schema.json`.
- Tests and vectors: `tests/unit/evidence/jcs_vectors/`, RFC 6962 known answers, the 10k tamper matrix, `tests/unit/anchor/rekor_vectors/sigstage_hashedrekord.json` (+8 tamper variants), `fake_rekor.py`, `fake_tsa.py`, IT-D1-03 concurrency recipe, IT-A2b-01/02, IT-M3-01, S4 determinism tests.
- Handoffs: B3, D1, A2, A2b, A1, A1b (+ `MODULE_A1b_DEEP_DIVE.md`), S4-reporting, B4. Biz-Arch §20/§20.1; MVP §6 B3/A2, §7 A2b.

**Invariants that carry over (they become Attesta's acceptance criteria and AGENTS.md §9 gotchas):** gap-free `seq` from `chain_head` under `FOR UPDATE`, never a database sequence; anchoring never changes `record_hash`; anchors in their own append-only table; exact canonical bytes stored; no network call inside the chain lock; revocation UNKNOWN is never CLEAN; an unreachable log is never a pass; pinned log key in production; only the batch root leaves the tenant.

**Decisions for the Attesta primer (not decided here):**
1. *Subject.* Per-commit attribution statements (commit digest + authorship-note digest + lifecycle facts), the audit log, export manifests, or all three in order. Recommendation in the primer: audit log and export manifests first (small, server-only, immediate value), then per-commit attribution.
2. *Envelope.* SushiCorp signs JCS statements (S4) and has no DSSE/in-toto. For code provenance an in-toto Statement in a DSSE envelope (predicate such as `ai-attribution/v1`) keeps compatibility with cosign, Rekor `dsse` entries and SLSA tooling; this is new design.
3. *Where signing happens.* Server-side with the tenant's KMS key (SushiCorp's model, no key custody), machine-side in GitAI, or keyless Sigstore (Fulcio/OIDC). TASK6_POLICY §6.3 already says "do not create a private signing key on every endpoint".
4. *Verifier.* Node single file, or a `git-ai verify` subcommand so auditors need no TrackAI.
5. *Shared trust layer.* Whether Attesta's signer and key hierarchy also serve D6.1 (signed activation lease) and P6.8 (signed policy bundles).

## 4. Task6 policy design vs SushiCorp P1

| | SushiCorp P1 | TrackAI Task6.b (`TASK6_POLICY.md`, deferred) |
|---|---|---|
| Purpose | Platform-authored rules; every decision recorded and replayable by bundle digest | Tenant-authored organization policy (capture, upload, redaction, retention, access, export) plus security rules, compiled per client |
| Format | One deterministic `opa build -t wasm` bundle; Rego only | Signed manifest of content-addressed components: Cedar, CEL-like YAML, closed JSON schemas; audience, `policy_epoch`, validity window, client version range |
| Signing | cosign bundle v0.3, one local key, no tlog | Offline root authorizes online signing keys; overlap and expiry; signed emergency rollback; TUF undecided |
| Distribution | Server-local store; nothing goes to endpoints | Machine-authenticated pull, verify, atomic last-known-good activation, acknowledgements |
| Evaluated | Server only (WASM in the API) | Mainly the endpoint (Rust in GitAI), server re-checks |

They serve different purposes: P1 governs server decisions; Task6.b governs developer machines. P1's discipline ports (§1, PO-1); its format, trust model and distribution do not. The trust layer Task6.b needs (root and online keys, rotation, revocation, signed manifests) overlaps with Attesta's signer far more than with P1, which is the main argument for building that layer once, in Attesta.
