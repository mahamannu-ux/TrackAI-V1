# Task14 — Production Readiness and Deployment Certification

**Canonical Task14 tracker**

Status: **🔴 ☐ Planned**

Last updated: **2026-08-02**

Portfolio roadmap: [`ROUGH_ROADMAP.md`](ROUGH_ROADMAP.md)

Task4 security and operations authority: [`TASK4.md`](TASK4.md)

Agent/platform coverage authority: [`AGENT_COVERAGE.md`](AGENT_COVERAGE.md)

Plain-language companion: [`prod-checklist-for-dummies.md`](prod-checklist-for-dummies.md)

## Purpose

Task14 turns already-verified TrackAI capabilities into releases that can be
operated safely in three environments:

1. TrackAI's GCP-hosted SaaS;
2. a customer-controlled cloud/VPC deployment; and
3. a customer self-hosted deployment.

It is a production engineering and certification task. It does not redefine
product behavior or repeat unfinished feature work from earlier tasks.

## Ownership boundary

| Program | Owns | Task14 consumes |
|---|---|---|
| Task4 | Encryption, tenant isolation, machine/GitHub credentials, queue reliability, retention, export, monitoring, audit and Task4 release gates | Stable security and operations contracts plus their verification evidence |
| Task6 | Organization policy and signed endpoint policy bundles | Stable policy distribution and enforcement contracts |
| Task8 | Customer identity/onboarding, roles, self-service installation and first-data journey | Repeatable onboarding acceptance flow |
| Task9 | OS packages, MDM deployment, device posture, inventory, updates and offboarding | Installable artifacts and fleet conformance results |
| Task13 | Agent/host/platform implementation and route evidence | Exact supported agent, surface and OS matrix |
| Task14 | Cloud/runtime architecture, secret adapters, release engineering, resilience and deployment certification | A production release with reproducible operational evidence |

Task14 may rerun an earlier gate as a release prerequisite, but ownership of
that contract remains with its original task.

## Production invariants

- No secret value, private key, customer prompt, raw database or credential is
  committed, printed in CI or copied into a deployment document.
- GCP is the reference SaaS architecture, but core contracts remain portable.
- Applications request secrets through adapters; business code does not depend
  directly on one cloud vendor's secret product.
- Human SSO identity, machine identity and service identity remain distinct.
- Every deployment is tenant-safe, encrypted in transit and at rest, observable
  and recoverable from a tested backup.
- Migrations, restores, key rotation, retention and rollback use dry-run-first
  workflows and explicit operator approval.
- A release claim names its exact deployment mode, client OS and supported
  agent/surface matrix. Untested combinations remain unsupported or partial.

## Workstream tracker

| ID | Workstream | Status | Required outcome | Main evidence |
|---|---|---:|---|---|
| **T14.1** | Reference deployment architecture | 🔴 ☐ | Versioned GCP SaaS design plus portable VPC/self-hosted component contract, trust boundaries and data flows. | Architecture review; threat model; deployment-mode comparison. |
| **T14.2** | Server secret and key-management adapters | 🔴 ☐ | Provider interface supporting GCP Secret Manager and Cloud KMS/HSM, Kubernetes/External Secrets or Vault, AWS Secrets Manager/KMS, Azure Key Vault and BYOK/HSM extensions. | Adapter conformance tests; rotation and unavailable-provider drills. |
| **T14.3** | Endpoint secret-store contract | 🔴 ☐ | Common client interface for macOS Keychain, Windows Credential Manager/DPAPI and Linux Secret Service/libsecret, with a narrowly defined owner/root-only fallback for headless systems. | Platform tests proving no plaintext logs/files and safe rotation/revocation. |
| **T14.4** | TLS, service identity and network boundaries | 🔴 ☐ | Managed DNS/certificates, TLS-only public endpoints, authenticated internal services, restricted egress, private database access and customer-private connectivity options. | TLS/network scans; service-identity and denied-path tests. |
| **T14.5** | PostgreSQL, migrations and disaster recovery | 🔴 ☐ | Production pooling/sizing, migration locks, point-in-time recovery, encrypted backups, restore runbooks and measured recovery objectives. | Load baseline; backup validation; clean and partial-failure restore drills. |
| **T14.6** | Availability, rate and capacity engineering | 🔴 ☐ | Multi-instance safety, health/readiness checks, rate limits, queue/backpressure behavior, autoscaling guidance and noisy-neighbor isolation. | Failure injection; load/soak tests; tenant-isolation checks under pressure. |
| **T14.7** | Supply-chain and artifact integrity | 🔴 ☐ | Reproducible CI, dependency and image scanning, SBOMs, signed server/client artifacts, provenance and controlled promotion. | Signature verification; vulnerability policy; release provenance. |
| **T14.8** | Staging, canary and rollback | 🔴 ☐ | Environment separation, configuration promotion, canary criteria, backward-compatible migrations and tested application/config/database rollback. | Rehearsed staged release and rollback with retained audit evidence. |
| **T14.9** | SLOs and incident operations | 🔴 ☐ | Service indicators, alert thresholds, on-call/runbooks, tenant-safe diagnostics, incident communications and post-incident evidence. | Alert drills; game days; runbook timing and redaction review. |
| **T14.10** | Deployment certification | 🔴 ☐ | Release matrix for GCP SaaS, customer VPC and self-hosted modes, including supported OS/agent routes and explicit limitations. | Signed release checklist and customer-repeatable acceptance package. |

## Secret-provider architecture

The application should ask for a named secret or a cryptographic operation,
not for a vendor-specific SDK object.

```text
TrackAI application
        |
        v
Secret / key-provider contract
        |
        +-- GCP Secret Manager + Cloud KMS/HSM (reference SaaS)
        +-- Kubernetes Secret / External Secrets / HashiCorp Vault
        +-- AWS Secrets Manager + KMS
        +-- Azure Key Vault
        +-- Customer BYOK/HSM adapter
```

The existing Task4 master-key versioning and envelope format remain
authoritative. An adapter changes where protected key material is obtained or
where cryptographic operations run; it does not change ciphertext meaning,
tenant binding or rotation history.

## Endpoint secret-store boundary

Task14 defines the adapter contract and security tests. Task9 integrates those
adapters into signed installers and MDM profiles.

| Platform | Preferred store | Required failure behavior |
|---|---|---|
| macOS | Keychain | Fail closed if the item cannot be read for the expected user/service context. |
| Windows | Credential Manager protected by DPAPI | Fail closed across the wrong Windows account or machine context. |
| Linux desktop | Secret Service/libsecret | Fail closed when the session store is unavailable; do not silently create a world-readable file. |
| Headless Linux | Root/service-owned secret provider or strictly owner-only fallback | Require an explicit deployment choice, documented rotation and permission verification. |

## Deployment certification matrix

| Gate | GCP SaaS | Customer VPC | Self-hosted |
|---|---:|---:|---:|
| Infrastructure created from versioned configuration | Required | Required | Required reference templates |
| Secrets/KMS adapter rotation and outage test | Required | Required | Required for selected provider |
| TLS, service identity and database isolation | Required | Required | Customer-repeatable validation |
| Migration dry run, backup and restore | Required | Required | Customer-repeatable validation |
| Load, rate-limit, backpressure and failover | Required | Required | Published sizing/conformance suite |
| Signed artifacts, SBOM and provenance | Required | Required | Required |
| Canary, rollback and incident drill | Required | Required | Documented and exercised on reference stack |
| Task8 onboarding and Task9/13 client matrix | Required for supported scope | Required for supported scope | Required for supported scope |
| Company A/Company B isolation | Required after every relevant wave | Required | Required conformance test |

## Release exit criteria

Task14 is complete for a named release only when:

- the exact deployment and client support matrix is versioned;
- every required gate above has recent evidence;
- disaster recovery meets approved recovery-time and recovery-point targets;
- key rotation and revoked-key rejection work without plaintext exposure;
- a canary can be promoted or rolled back safely;
- operational dashboards and alerts distinguish customer impact from internal
  noise without exposing tenant data;
- a fresh operator can deploy and restore using only the approved runbooks; and
- a customer can repeat the applicable onboarding and trust checks.

## Manual cooperation

Task14 will require controlled access to cloud projects, DNS, certificate and
KMS configuration; customer-like IdP/SCM installations; macOS, Windows and
Linux hosts; and at least one representative VPC/self-hosted environment.
Credentials and private material are entered only through approved secret
channels and are never pasted into trackers or test output.
