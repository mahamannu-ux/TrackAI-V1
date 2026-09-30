# Task6 to Task13/Task14 Production Coverage Handoff

Status: **Open production blocker — D6.2**

This handoff prevents the narrow Task6 development result from being mistaken
for production-wide agent or platform support.

## Verified today

Only this route is live-verified for Task6 Security monitoring:

| Agent | Route | Surface | Capture | OS | Effect |
|---|---|---|---|---|---|
| OpenCode | `AC-CLI-03` | Terminal/TUI | Provider plugin, pre-action | macOS | Monitor only |

No other route or operating system inherits this evidence.

## Required before production

- Linux, native Windows and WSL clients;
- intended Codex, Claude Code, Copilot, Cursor, Gemini, Antigravity and other
  agent routes;
- intended IDE, desktop, remote, cloud and background surfaces; and
- customer-visible unavailable states for every route outside the certified
  release matrix.

The release matrix may deliberately exclude a route only through an explicit
product decision recorded in Task13 and Task14. Silence, shared code and schema
fixtures are not verification.

## Ownership

| Owner | Required work |
|---|---|
| Task13 | Build each route adapter; preserve exact agent/surface/capture identity; run the reusable route-conformance suite on each OS; publish the supported matrix and limitations |
| Task9 | Package, install, update, revoke and roll back verified clients on managed macOS, Linux and Windows/WSL endpoints |
| Task14 | Freeze the release matrix; rerun security/privacy/isolation regression; certify artifacts, deployment, rollback and customer acceptance; refuse production certification while D6.2 is open |
| Task6 | Preserve the fixed rule, finding, activation and monitor-only contracts; review any new route that needs a security-contract change |

## Evidence required to close D6.2

For every production route/platform row:

1. exact Task13 route ID, agent, surface, mode, capture channel and OS;
2. real-host monitor match, non-match and unavailable cases;
3. explicit off, offline, expiry, restart and non-blocking behavior;
4. Task4 machine/repository/tenant isolation and revoked-credential denial;
5. Task5 raw-content exclusion in client, transport, logs, database and UI;
6. signed/package provenance and install/upgrade/rollback evidence; and
7. customer wording that does not claim prevention or unsupported coverage.

D6.1 remains separate: production activation must also come from the Policy
subsystem as a signed, machine-bound value.
