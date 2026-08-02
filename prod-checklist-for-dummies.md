# TrackAI Production Checklist for Non-Specialists

This guide is for a product owner or customer administrator who does not want
to think in database, cryptography or infrastructure jargon.

Technical production tracker: [`TASK14.md`](TASK14.md)

Current Task4 security tracker: [`TASK4.md`](TASK4.md)

## First: the four identities are different

This is the most important idea in the whole guide.

| Identity | Plain-language meaning | What it proves |
|---|---|---|
| Customer tenant | The customer's private TrackAI workspace | Which company owns the data and settings |
| Human SSO identity | A person who signed in through Okta, Entra or Google | Who the person is |
| Machine identity | One installed copy of Git AI/TrackAI on a device | Which approved installation sent telemetry |
| GitHub App installation | TrackAI's approved connection to a GitHub organization | Which repositories TrackAI may read from GitHub |

One identity must not impersonate another. For example, knowing that Alice uses
Laptop 12 does not let Laptop 12 sign into the dashboard as Alice. Alice's SSO
login and Laptop 12's machine credential are checked separately.

## What works today, and what is still future work?

| Area | Today | Before a real production release |
|---|---|---|
| Tenant isolation | Company A/B tests prove separate tenant, repository and credential boundaries | Repeat in staging/cloud and under load after each relevant release |
| Human login | Test Okta/OIDC users can sign in; explicit subject membership grants admin/auditor authority | Customer-friendly IdP wizard, group-to-role mapping, regular-user acceptance and break-glass recovery (Task8) |
| Machine enrollment | Admin creates a machine, issues a one-time credential and grants repository/branch access | Guided self-service enrollment plus signed installers (Task8/Task9) |
| Credential storage | We verified an owner-only local keyring file on one Mac | Native macOS Keychain, Windows Credential Manager and Linux secret-store adapters (Task14 contract, Task9 packaging) |
| Fleet deployment | Manual/local installation works | MDM deployment, inventory, updates, posture and offboarding (Task9) |
| Server secrets | Protected local `.env` and Task4 envelope encryption work | GCP Secret Manager/KMS for SaaS and portable vault/KMS adapters (Task14) |
| Cloud operation | Local and remote database verification works | TLS, DNS, HA, backup/restore, scaling, canary, rollback and incident drills (Task14) |

## 1. What happens on a customer's developer machine?

### The target self-service installation

1. The customer administrator configures the TrackAI tenant, IdP and GitHub
   organization.
2. The administrator enrolls the repositories the company wants TrackAI to
   accept.
3. The developer signs in to a TrackAI setup page with the company IdP.
4. The installer is downloaded from an authenticated page. Its operating
   system and signature are verified before it runs.
5. The installer creates a random installation ID. This identifies the
   installation, not the employee.
6. The user approves or requests the machine enrollment. An administrator can
   see the request, device description and requesting SSO user.
7. TrackAI creates a one-time machine credential. The normal production flow
   should transfer it directly to the installer; a person should not routinely
   copy it through chat, email or a ticket.
8. The installer puts that credential into the operating system's protected
   secret store. TrackAI stores only a one-way verification hash on the server.
9. The administrator assigns the approved repositories and branches to the
   machine.
10. The client downloads a non-secret, signed configuration/policy bundle. It
    contains tenant/repository/rule references, but not the plaintext machine
    credential.
11. The installer runs a health check and sends a harmless test event.
12. The dashboard confirms the exact tenant, machine, repository, branch and
    credential key ID used. It never displays the secret.

### What happens later?

- The client queues events locally when the network is unavailable.
- The server independently checks every upload. A valid machine credential is
  not enough if that machine lacks access to the repository or branch.
- During rotation, old and new credentials may overlap briefly. The client is
  moved to the new credential, then the old one is revoked.
- Revoking one credential leaves the machine available for a replacement.
- Revoking the whole machine rejects every credential and repository grant for
  that installation.
- Reassigning a laptop closes the old user/custodian assignment and creates a
  new audited assignment. It does not reuse the old employee's SSO session.

### What we must test before asking a customer

| Test | Expected result |
|---|---|
| Fresh install on a clean user profile | No manual editing of hidden files; first health check succeeds |
| Wrong or expired enrollment approval | Install fails clearly without leaving a working secret behind |
| Offline install/upload restart | Queue survives process and whole-machine restart, then delivers once |
| Credential rotation | Old/new overlap works; old key fails after revocation; no secret appears in logs |
| Repository/branch denial | Client may know only its allowed scope, but the server rejects every forbidden event |
| Uninstall and re-enroll | Old machine identity stays revoked; new installation receives a new identity |
| Two machines for one user | Both are visible and independently revocable |
| Reassigned/shared machine | Assignment history is retained; access follows explicit policy, not guessed ownership |

## 2. Where do Onboarding, MDM, Policy and Production Readiness stop?

| Task | Simple responsibility | Not its responsibility |
|---|---|---|
| Task8 — Customer Onboarding | Help the customer connect IdP/SCM, assign roles, enroll a first machine and verify first data | Mass deployment or cloud reliability engineering |
| Task9 — MDM/Fleet | Install and manage software across many company devices; report device/user/posture facts; update and offboard | Deciding dashboard roles or operating TrackAI's SaaS backend |
| Task6 — Policy | Define and distribute what may be captured, uploaded, redacted, retained, accessed or exported | Installing packages or operating databases |
| Task14 — Production Readiness | Make the server, secret stores, release process, backup/restore and deployment modes production-safe | Redefining Task4 security semantics or customer policy meaning |

Task14 defines how platform secret adapters must behave. Task9 packages and
deploys those adapters. Task8 explains the setup to the customer. Task6 later
decides the customer's detailed capture/upload rules.

## 3. How does an Okta/Entra person map to a machine?

The safe model is an **audited assignment**, not a permanent hidden link.

```text
Okta/Entra subject ── assigned as user/custodian ──> TrackAI machine ID
       |                                              |
       | signs into dashboard                         | signs uploads
       v                                              v
Human authorization                            Machine authorization
```

An assignment record should say:

- which tenant owns it;
- which verified IdP subject is the user or custodian;
- which TrackAI machine ID is assigned;
- when the assignment started and ended;
- whether it was requested by the user, approved by an admin or attested by
  MDM; and
- who changed it and why.

This supports a developer with two laptops, a reassigned laptop, a shared build
machine and temporary devices. The assignment helps administration and audit,
but it does not grant dashboard or repository access on its own.

### What TrackAI can test without a real customer

- Use synthetic Company A and Company B IdPs with admin, auditor and regular
  users.
- Assign one user to one machine, one user to two machines and two sequential
  users to one reassigned machine.
- Attempt every cross-tenant person/machine combination and require failure.
- Feed synthetic MDM evidence that agrees and disagrees with the assignment.
- Verify that disagreement creates a visible warning, not a silent reassignment.
- Revoke a human session and confirm the machine does not automatically become
  that human; revoke the machine and confirm the human can still sign in.

## 4. What must the customer configure in Okta, Entra or Google?

The exact screen names differ, but the job is the same.

### Customer administrator steps

1. Create a TrackAI enterprise application, or approve the TrackAI SaaS
   application from the provider's catalog when available.
2. Enter TrackAI's exact sign-in callback and logout URLs.
3. Give TrackAI the issuer/tenant identifier, client identifier and approved
   authentication method. Secrets go through a protected setup channel.
4. Configure standard claims such as stable subject, email and display name.
   The stable subject—not the email address—is the durable identity key.
5. Create or select groups such as `TrackAI Admins`, `TrackAI Auditors` and
   `TrackAI Users`.
6. Assign people or groups to the TrackAI application.
7. Map approved groups to TrackAI roles. An email domain selects a tenant but
   must never grant administrator access.
8. Complete the first-admin bootstrap through an operator-approved or
   provider-verified flow. Configure a break-glass recovery process.
9. Test one administrator, one auditor and one regular user.
10. Later, optionally connect SCIM so user creation, disablement and group
    changes are synchronized instead of waiting for the next login.

### Expected role behavior

| User | Expected dashboard experience |
|---|---|
| Tenant admin | Can manage machines, credentials, repositories, branches, historical-import approvals and applicable integrations |
| Tenant auditor | Can inspect permitted security/audit information but cannot mutate resources |
| Regular customer user | Can use only the product views explicitly granted by policy; no administration controls |
| Assigned but disabled IdP user | Cannot start a new session; existing session expires/revokes according to the identity policy |
| Correct domain but no app/role assignment | Does not gain access merely because the email domain matches |

### Internal pre-customer acceptance

- Automate token tests for wrong issuer, audience, signature, expiry and tenant.
- Test renamed email with the same stable subject.
- Test group addition/removal and delayed IdP synchronization.
- Test first-admin bootstrap, lost-admin recovery and break-glass audit.
- Run the complete admin/auditor/regular-user UI matrix for both synthetic
  tenants and in both crossing directions.
- Verify that machine assignment and machine credentials remain separate from
  all human role changes.

## 5. What changes on macOS, Windows and Linux?

The server rules stay the same. Installation, paths, background services and
secret storage change.

| Platform | Secret store | Background process | Important tests |
|---|---|---|---|
| macOS | Keychain | LaunchAgent/service appropriate to install mode | User switching, Keychain lock, sleep/restart, signed/notarized package |
| Windows | Credential Manager protected by DPAPI | Windows Service or per-user scheduled/background process | Native paths, ACLs, user context, service restart, CRLF/case behavior, signed MSI/MSIX |
| Linux desktop | Secret Service/libsecret | systemd user or system service | Locked/missing keyring, permissions, distro/package differences, service restart |
| WSL | Treat Linux and Windows contexts explicitly; never assume their stores are interchangeable | WSL process lifecycle differs from Windows service lifecycle | Path translation, shutdown/restart, Git location and which side owns the credential |
| Headless Linux/build host | Root/service-owned vault or explicit owner-only fallback | systemd/container/orchestrator | No desktop keyring, noninteractive rotation, least privilege and ephemeral-disk behavior |

Before release, the same install → edit → queue → commit → upload → rotate →
revoke fixture must run on every claimed platform. A code path that merely
compiles on Windows or Linux is not enough to advertise support.

## 6. What does the Wave4 admin journey look like for a customer?

### Expected journey

1. Sign in through the company IdP.
2. Confirm the correct tenant and explicit administrator role.
3. Connect or verify the GitHub App installation.
4. Enroll a repository from now.
5. Register or approve a developer machine.
6. Issue its one-time credential and install it securely.
7. Grant that machine repository and branch access.
8. Install the non-secret client policy/configuration.
9. Run the first-data health check.
10. Optionally authorize a bounded historical import. This only permits old
    evidence for a limited window; it does not manufacture or automatically
    replay data.
11. Inspect audit entries and practise credential, grant and machine revocation.

### Where customers will need help

| Likely confusion | Product/runbook response |
|---|---|
| Key ID versus one-time credential | Label the key ID as a safe reference and show the secret only once with a direct installer handoff |
| Credential revoke versus machine revoke | Show an impact preview: one key only versus every key/grant for the installation |
| Grant revoke versus repository-policy revoke | Show exactly one machine/repository grant versus all grants/import approvals for the repository |
| `All branches` versus selected branches | Preview examples and show which branches become allowed/denied |
| Historical import | Call it temporary permission for old evidence; show time range, expiry and evidence family |
| Admin/auditor/regular user | Display current role and why an action is unavailable |
| Client is not uploading | Provide one health screen for daemon, credential, policy, repository, branch, queue and server response |

### Frictionless acceptance tests

- Give a fresh administrator only the customer guide; measure completion time
  and every point where operator help is requested.
- Repeat with one machine, two machines and 100+ synthetic repository/machine
  records so the UI is not validated only at demo size.
- Run every destructive action with impact preview, audit reason, result and
  recovery explanation.
- Test browser refresh, expired login, API restart, client restart, offline
  queue and partial failure.
- Confirm that no screen, download, log or support bundle exposes secrets or
  cross-tenant resource names.

## 7. What changes when localhost moves to the cloud?

| Local development | Production equivalent |
|---|---|
| `localhost` URLs and ports | Real DNS names and HTTPS-only endpoints |
| Local `.env` master keys | GCP Secret Manager and Cloud KMS/HSM for SaaS; approved adapter for VPC/self-hosted |
| Developer-started API/web processes | Managed, restartable services with health/readiness checks and multiple instances |
| Direct database URL | Private managed PostgreSQL, connection pooling, least-privilege identities and controlled migrations |
| Manual backup file | Scheduled encrypted backups, point-in-time recovery and regularly timed restore drills |
| Terminal logs | Central redacted logs, metrics, traces, tenant-safe diagnostics and alerts |
| One developer machine | Certified macOS/Windows/Linux packages and the exact supported agent/surface matrix |
| Manual deployment | Versioned infrastructure, staging, canary promotion, signed artifacts and tested rollback |

### Cloud release checklist

- [ ] Production DNS and certificates are valid; plain HTTP is rejected.
- [ ] Browser, API, worker and database trust boundaries are documented and
      tested.
- [ ] Service accounts have only the permissions they need.
- [ ] Master keys, GitHub keys, webhook secrets and database credentials come
      from the chosen secret provider and can be rotated.
- [ ] Database migration dry run, backup and rollback plan pass before apply.
- [ ] A clean restore and a partial-failure restore both work.
- [ ] Rate limits, large queues, slow dependencies and tenant isolation pass
      load/soak testing.
- [ ] Staging and production are separate; a canary can be promoted or stopped.
- [ ] Alerts detect real customer impact without logging customer content.
- [ ] Company A/B isolation passes after deployment and after key rotation.
- [ ] Customer-VPC and self-hosted templates clearly state what TrackAI operates
      and what the customer must operate.

## Overall pre-release test matrix

| Dimension | Minimum internal coverage | Customer acceptance still required |
|---|---|---|
| Physical devices | One Mac plus a second independently enrolled device | Customer hardware/security controls |
| Operating systems | macOS, native Windows, Linux and WSL for every claimed route | Customer's supported OS versions and endpoint controls |
| Human roles | Admin, auditor, regular user, disabled user and break-glass path | Customer's real group/role names and approval process |
| Installation | Self-service and unattended/MDM | Customer MDM product and profiles |
| Machine lifecycle | Enroll, assign, reassign, rotate, revoke one key, revoke machine, uninstall/re-enroll | Customer offboarding and lost-device process |
| Repository policy | Allowed/denied repository and exact/prefix/all branch scopes | Customer repository/branch policy choices |
| Tenant isolation | Company A/B positive and crossing tests after every relevant wave | Customer security review |
| Deployment | Local, staging, GCP SaaS reference, VPC reference and self-hosted reference | Customer network, vault/KMS and operational ownership |
| Reliability | Offline, crash, whole-machine restart, dependency timeout, restore, canary and rollback | Customer RTO/RPO and maintenance-window approval |

## A simple definition of “ready”

TrackAI is not production-ready merely because the application builds or one
Mac successfully uploads data. It is ready for a named release when we can say:

> These exact users, machines, operating systems, agents and deployment modes
> were installed, secured, denied when they should be denied, recovered from
> failure and independently repeated using documented steps.

Anything outside that exact matrix remains partial or `Unavailable`; it is not
silently assumed to work.
