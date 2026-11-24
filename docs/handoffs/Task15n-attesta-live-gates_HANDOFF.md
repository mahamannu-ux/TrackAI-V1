# Task15n-attesta-live-gates Handoff — real Attesta trust and anchoring

> Status: ✅ founder live gates complete · 🟡 cross-agent review and founder push pending.

Branch `task/Task15n-attesta-live-gates` from `b756148`. Synthetic tenant only in isolated `trackai_task15n` on `127.0.0.1:55436` (`trackai-task15n-pg`); API used port 8081. Never use the Task20 kept database on 55432.

## At a glance
| Gate | Result | Public evidence |
|---|---|---|
| 1, platform trust | ✅ | Seven GCP KMS P-256 v1 keys registered; six platform keys active under offline-signed root v1 `sha256:ecff740caefa2b26de0ffc79e4fda4a4dec3f16b6387964eb06fe8fb76b290c1`; tenant statement key active in published key set v1 `sha256:dc8dd986c9cceca2e936919df0f68e37d99ecaa59265b4bcb85366fd30e00e7c`. Root pin `sha256:1a04c0b4ae4429fb81a2682653cba1b75d54f8628879360d5cd85ec57c7e105d`. |
| 2, real KMS signature | ✅ | `attesta:build` claimed/done 1, failed 0; fetched KMS public SPKI matched statement keyid `sha256:5ca561f9566caef01012eed0b45a3096d2806ab6d92a402283a2464bb0f52a01`; DSSE and chain signature verified. |
| 3, real dual anchors | ✅ | One record anchored in Rekor staging and FreeTSA; chain `ok=true`, checked 1, signatures and anchors checked, no breaks. Rekor UUID `71d46696179fcd5d495d6c669fb3d45a7ce4dd12626f435a956c5109f07543005d12dbc9c5671920`; TSA serial `0x0A63ECA0`. |
| 4, independent offline pack | ✅ | Mac Mini: public source archive from `b756148`, `npm ci` passed; Wi-Fi off and no default route. Full pack ID `0ea5df55-209f-4c20-b0c0-0eb38742b6ec` exited 0 (1 record, 1 statement, 2 anchors); one statement byte altered in a copy exited 1 (`SIGNATURE_INVALID`, `STATEMENT_DIGEST_MISMATCH`). No database, KMS credentials, or root private key on Mini. |
| 5, KMS audit seal | ✅ | Dry run would seal 5 rows; `--confirm` sealed 5, exit 0; seq 1 anchored in both services (Rekor UUID `71d46696179fcd5d520b3ff02d88862cfd577fe779a4e96243126ff3e62127e68643c2effffe45fe`, TSA serial `0x0A812305`). `GET /api/audit/verify` on 8081 returned 200, `ok=true`, 1 seal and 1 chain record checked, no breaks; one later audit event is correctly an unsealed tail. |
| 6, IT-T20f-02 | ✅ | Live KMS `policy_bundle` key `sha256:ba2d7a652d95167b88706df1f1c2ffb79e9d8b28569fa7cf0c7348e6a0fb7cf6` signed a synthetic compiled bundle; `activation_lease` key `sha256:798d56cf1082c59f43443e869afbeb63db848374ca84ce46d355949aa49e8f16` signed a synthetic lease naming its digest. TypeScript `verifyTrusted` verified both and rejected a wrong-purpose check; Rust's 82-vector parity test passed in its six-test trust-vector binary. The Rust test did not consume the two live artifacts directly. |

## Implemented interfaces
No product code, schema, migration or contract changed. Existing `attesta:keys`, `attesta:build`, `attesta:anchor`, `attesta:verify-pack`, `attesta:audit-seal` and `/api/audit/verify` interfaces were exercised with live signing and anchoring.

## Deviations from spec
The removed Task6.a walkthrough was replaced by the founder-requested IT-T20f-02. Gate 4 used a separate Mac Mini instead of the Intel Mac's second account. The first root document signed while Wi-Fi was on was abandoned before import; a newly generated root was signed with Wi-Fi off and only that document was imported. An initial root-import read refusal was fixed by making the signed **public** document readable. Docker Desktop and the Task15n database were restarted in the everyday account after account switching. No product defect was found.

## Test coverage
`npm ci` and `npm test` (1265/1265) passed at `b756148` after the founder merged the upstream Task20 fixture fix. The live gates use a persistent synthetic database and public staging services, not test fakes. The real API JWT/tenant route returned the audit verify report. IT-T15n-01…05 and IT-T20f-02 are founder-passed; no new test script was added. No customer data or credential contents were recorded.

## Integration test impact
IT-T15n-01…05 and IT-T20f-02 are blocking for A15.13 and the first customer build respectively; all were run by the founder and passed. Prerequisites were Docker PostgreSQL on 55436, GCP KMS credentials and public pins, Rekor staging, FreeTSA, and a separate Mac Mini for the offline pack. The Mac Mini clean and altered-copy checks exited 0 and 1. Rust ran the pre-existing vector corpus, with no direct Rust check of the two live artifacts. Commands and public results are recorded above; no new integration test script was introduced.

## Integration and production notes
GCP project `trackai-attesta-dev-459548`, global ring `attesta`: six platform keys (`anchor`, `activation_lease`, `fleet_config`, `policy_bundle`, `release`, `tenant_keyset`) plus one tenant `statement_dev`; software P-256 `EC_SIGN_P256_SHA256` v1. The personal billed project is for this test only; Task14 must provision organization-owned production keys and grant signerVerifier/useToSign plus publicKeyViewer/viewPublicKey on the ring (no service-account key file). The offline root private key stays only in the second Intel macOS account. Pin the public root, Rekor log key and FreeTSA root; staging endpoints were `https://rekor.sigstage.dev` and `https://freetsa.org/tsr`. Rekor active tree ID `8202293616175992157` used shard offset `31682412`, verified against a sampled inclusion proof. These are test services, not a production anchor decision.

Schedule `attesta:build -- --loop`, regular `attesta:anchor` passes and `attesta:audit-seal --confirm`; `attesta:keys publish --all-tenants` weekly and after every tenant-key activation. The published key set expires after 30 days. Task14 should monitor stopped/failed anchor batches, the audit unsealed tail, rotation and expiry. No cleanup has run: only after this test project is retired, the founder may destroy its seven KMS v1 versions with `for key in anchor activation_lease fleet_config policy_bundle release tenant_keyset statement_dev; do gcloud kms keys versions destroy 1 --key="$key" --keyring=attesta --location=global --project=trackai-attesta-dev-459548; done`.

## Known limitations
The Mac Mini check used a source archive from the branch and public pack transfer; it did not obtain credentials or a database. Only the current single-record pack was checked on the Mini; volume and key rotation remain covered by earlier tests. Cross-agent review is pending before founder push.

## Effort
About 0.2× T6 agent work plus founder time against about 0.05× planned; root redo, Docker/account isolation, sharded Rekor preflight and new Mac Mini setup drove the overrun. A future live-gates prompt should separate the environment/root ceremony from the clean-machine and external-anchor run.
