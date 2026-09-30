# Task6 Security Wave 6 Conformance Boundary

Status: **Draft for product approval**

This document limits the first Task6 Security customer claim to the route that
has already passed a real end-to-end host test. It does not broaden Task13
coverage or imply that a shared parser is a supported platform.

## Exact supported claim

| Dimension | Supported value |
|---|---|
| Agent | OpenCode |
| Route | `AC-CLI-03` |
| Surface | Local terminal/TUI |
| Capture | OpenCode provider plugin, pre-action request |
| Operating system | macOS |
| Effect | Monitor only; never blocks |
| Meaning | A reviewed command pattern was requested; success is not proven |

The existing physical-host tests prove a monitor match, explicit off, offline
activation, activation expiry and fresh-daemon restart on this exact route.
Task4 machine/repository authorization and Task5 privacy remain unchanged.

## Honest unavailable boundary

The customer surface must label these as unavailable or not yet verified:

- OpenCode IDE-hosted, desktop, remote, cloud and background routes;
- Linux, native Windows and WSL Task6 Security monitoring;
- Codex, Claude Code, Copilot, Cursor, Gemini and Antigravity routes; and
- post-action outcome or prevention claims.

Linux may share implementation code, but it is not customer-supported until a
real Linux route test passes. Native Windows currently chooses the safe
`unavailable` parser path. WSL cannot be claimed from a Linux compile target
without a separate trustworthy host signal and live test.

## Proposed customer display

The **Security findings** page should show:

> Verified route: OpenCode terminal/TUI on macOS. Other agents, surfaces and
> operating systems are not yet verified for Task6 Security monitoring.

This is a coverage statement only. It does not add a Policy engine, signing,
dynamic rules, raw evidence or blocking. D6.1 remains open.

## Exit checks

1. The supported route remains fixed to `AC-CLI-03`, `opencode`, `terminal`,
   `cli`, `provider-plugin`, `macos`, `pre_action` and `observe_only`.
2. Unsupported platforms cannot be promoted by a generic schema fixture.
3. The customer UI uses “not yet verified,” never “protected” or “blocked.”
4. The existing macOS monitor/off/offline/expiry/restart evidence is linked in
   the canonical tracker.
