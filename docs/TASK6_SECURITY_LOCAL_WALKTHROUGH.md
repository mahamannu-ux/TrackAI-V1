# Task6 Security Local Walkthrough

This is the bounded product-owner check for Wave 5. It reuses one disposable
Task5 acceptance environment for all three roles. Use synthetic data only.

## Roles

| Role | Email | Synthetic password | Expected result |
|---|---|---|---|
| Administrator | `admin@task5.acceptance.invalid` | `task5-acceptance-only` | Can read findings and the audit history |
| Auditor | `auditor@task5.acceptance.invalid` | `task6-auditor-only` | Can read findings and audit history, but has no change controls |
| Developer | `developer@task5.acceptance.invalid` | `task5-viewer-only` | Cannot enter Administration or read the findings API |

## Prepare the shared fixture

Use the disposable Task5 PostgreSQL database. Apply current migrations, then
create the Task5 persistent corpus and the Task6 overlay:

```bash
cd /Users/manishmahajan/Documents/Codex/2026-09-26/begin-task6-security-from-the-current/work/trackai-task6-security

DATABASE_URL='postgresql://postgres@127.0.0.1:55432/trackai' \
npm run db:migrate --workspace=apps/api

DATABASE_URL='postgresql://postgres@127.0.0.1:55432/trackai' \
MASTER_ENCRYPTION_KEY_ACTIVE_VERSION='local-v1' \
MASTER_ENCRYPTION_KEYS_JSON='{"local-v1":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}' \
TASK5_EPHEMERAL_DATABASE='1' TASK5_ACCEPTANCE_PERSIST='1' \
npm run verify:task5-corpus-live --workspace=apps/api

DATABASE_URL='postgresql://postgres@127.0.0.1:55432/trackai' \
TASK6_EPHEMERAL_DATABASE='1' \
npm run seed:task6-acceptance --workspace=apps/api
```

Start the existing Task5 acceptance auth, API, and web processes from this
worktree. The semantic worker is not needed for this focused Task6 check.

## One combined browser check

Open [http://localhost:3000/login](http://localhost:3000/login). Sign out
between roles.

| Role | Do this | Pass condition |
|---|---|---|
| Administrator | Open **Administration → Security findings**, then refresh and open **Security audit** | One safe metadata row appears; **Monitor only** and **TrackAI did not block this action** are clear; the audit contains `security_findings.read` |
| Auditor | Repeat the same two views | Same safe row and audit are readable; machine/repository change controls are absent |
| Developer | Open the normal dashboard and try Administration | Administration and finding details are unavailable |

Fail the walkthrough if raw commands, URLs, paths, outputs, prompts, or secret
values appear anywhere. This check does not approve blocking or the deferred
Policy engine. Production activation still requires the Policy subsystem and a
signed, machine-bound value (D6.1 remains open).
