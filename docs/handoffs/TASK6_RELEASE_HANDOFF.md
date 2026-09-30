# Task6 Security Release Handoff

Status: **Ready for separate TrackAI and GitAI review; production blockers remain open**

This handoff records the exact review boundary. It does not approve production
release, the deferred Policy engine, signed activation or blocking.

## Review branches

| Repository | Remote `main` base | Tested implementation/evidence checkpoint | Review size including this handoff |
|---|---|---|---|
| TrackAI | `957ba318482a244840e785e6b1e79fcd3d196f8c` | `aa325a56fab34921bbdf5c6389fe6f16c34cd9fd` | 52 changed files; 109 branch commits |
| GitAI | `0097645d3179d4baa3b6bff043149b08dbf79155` | `a319e237c42cb467f0b961574c00d07257b53c36` | 20 changed files; 56 branch commits |

Use GitAI's `github/main` as its review base. Its local `origin` points to a
different local repository; comparing against that ref incorrectly includes
older Task2, Task4 and Task5 work.

## What is green

- Task6 rules and contracts, local monitor evaluator and raw-content exclusion;
- fail-closed activation, exact repository/tenant binding and durable delivery;
- authenticated metadata-only TrackAI storage, audited reads and role-safe UI;
- OpenCode terminal/TUI on macOS, route `AC-CLI-03`, monitor only;
- 150 TrackAI API tests, API/web type checks and the web production build;
- 39 GitAI security tests, all 19 OpenCode integration tests, build, formatting
  and documentation checks; and
- the five Task6 end-to-end cases: monitor, off, offline, expiry and restart.

## What stays open

| Item | Meaning | Release effect |
|---|---|---|
| D6.1 | Production activation must be Policy-owned, signed and machine-bound. | Deferred from this task; required before production activation. |
| D6.2 | Linux, Windows, WSL and intended other agents/surfaces need real-route testing. | Production blocker owned through Task13, Task9 and Task14. |
| E6-10 | One inherited daemon timing test is intermittent; Rust 1.97 reports 11 style findings outside Task6 while the repository pins 1.93. | GitAI owner/controlled CI must clear the final release gate. |

The full serial daemon run passed 74 of 75 tests. The missed inherited symlink
watermark test then passed alone. No Task6 security assertion failed, so Task6
does not patch or repeatedly rerun that unrelated test.

## Review and merge order

1. Open separate PRs for TrackAI and GitAI against the exact remote bases above.
2. Review GitAI against `github/main`, not its local `origin/main`.
3. Merge only after normal repository CI reports its controlled result.
4. Preserve D6.1 and D6.2 as open follow-ups; do not describe the result as
   production-wide support.

No customer environment, credential, database, log or local acceptance data is
part of either repository diff.
