# Task8 — Pilot Readiness: Identity and Onboarding

*Status: 🔴 not started; scheduled after Task10 and before Task18 (founder decision 2026-10-12). Updated scope from the founder's review; the lead writes the primer with sizes and the sub-task graph when the Task starts.*

**In one paragraph.** Everything a pilot customer needs to go from "Acme signed" to "Acme's CISO sees real numbers" without TrackAI staff doing it by hand: connecting the company login, deciding who is admin, auditor or developer, enrolling machines and repositories, explaining why data is missing, and a ready sample tenant and acceptance runbooks for the evaluation. It absorbs the pilot-critical parts of the old Task12 and Task16's auditor invitations.

| ID | Piece in plain words | Example |
|---|---|---|
| T8.1 | Connect the company's login system (Okta, Entra, Google) | Acme's IT admin pastes their Okta details into a setup screen |
| T8.2 | Test that connection before switching it on; check token issuer, audience and claims | "Test login" catches a wrong callback URL before 200 developers are locked out; closes backlog B7 |
| T8.3 | Who is admin, auditor or developer, plus an emergency admin login | Okta group `trackai-admins` becomes TrackAI admins; one sealed account works if Okta is down |
| T8.4 | Users appear on first login (SCIM, automatic removal of leavers, **deferred**) | A new hire signs in and sees the developer view |
| T8.5 | Connect GitHub and pick repositories | Install the GitHub App, choose 40 of 900 repos |
| T8.6 | Record who owns which laptop, audited; responsibility only, grants no access (Task9 T9.9 reconciles with MDM) | "MacBook-7F3 belongs to Priya" |
| T8.7 | Developers enroll their own machine | One command, sign in, done; no admin copies keys |
| T8.8 | Each role's journey tested | Developers never see admin pages; auditors change nothing |
| T8.9 | First-data diagnostics and guided verification lab (ex-T12.2) | "Login OK, GitHub OK, 3 of 12 machines reporting, first commit 4 minutes ago" |
| T8.10 | Sample tenant with realistic synthetic data (ex-T12.3) | A demo or evaluation without installing anything |
| T8.11 | Acceptance runbooks for the customer's evaluation (ex-T12.4) | A checklist the pilot's security team runs to confirm the claims |
| T8.12 | Auditor invitations that expire and can be revoked; tenant chosen by membership, never by email domain (ex-Task16 A16.9, SushiCorp ID-2 back-port) | An external auditor gets 30-day read-only access |

**Depends on:** Task4 identity and admin; Task9 enrollment; Task16's audit contract (A16.3). **Port from:** SushiCorp ID-2 (OIDC SSO, memberships, auditor invitations), AU-1. **Deferred:** SCIM. **Open with the founder at primer time:** keep Supabase Auth for enterprise SSO or verify OIDC directly; the pilot hosting model (Task14 T14.1).
