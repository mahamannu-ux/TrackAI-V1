# GitAI public-upstream inventory — 2026-10-09

This is a read-only inventory for G5 in `GITAI_FUTURE_TODO.md`. It does not authorize a merge, rebase or bulk cherry-pick.

The companion [commit ledger](GITAI_UPSTREAM_COMMITS_2026-10-09.tsv) lists all 302 commits individually, in upstream chronological order, with full SHA, author date and subject. This document supplies the task relevance and adoption priority that the raw ledger cannot.

## Snapshot and reproducibility

| Item | Value |
|---|---|
| TrackAI fork examined | `mahamannu-ux/git-ai` `main` at `d26da8ea1b4b734dc2c1bc99759d87c75a187ee3` |
| Last imported public snapshot | `a751efd64d129272947239f819822bfee14bef97` — v1.6.19, 2026-07-30 |
| Local merge that imported it | `2d240fb939313f0cfbe43b71b779a1ac683dfb5d` — 2026-09-19 |
| Public upstream examined | `git-ai-project/git-ai` `main` at `0670e7ef27590af0e8ff5409267f3f4b09b8fcb4` — version bump to 1.7.6, 2026-09-09 |
| Compared range | `a751efd64d129272947239f819822bfee14bef97..0670e7ef27590af0e8ff5409267f3f4b09b8fcb4` |
| Divergence at inspection | 302 upstream-only commits; 71 fork-only commits |
| Public releases represented | 1.6.20–1.6.24 and 1.7.0–1.7.5; upstream `main` also contains the 1.7.6 version bump |

Reproduce the complete ordered list without modifying either repository:

```bash
git -C ~/AIProjects/git-ai fetch upstream main
git -C ~/AIProjects/git-ai log --reverse --date=short \
  --format='%H%x09%ad%x09%s' \
  a751efd64d129272947239f819822bfee14bef97..upstream/main
```

Commit counts below are overlapping path/subject views of that exact 302-commit range. They intentionally do not add up to 302.

## Inventory and disposition

| Area | Commits | TrackAI relevance | Priority and disposition |
|---|---:|---|---|
| New top-level MDM login-start kit | 18 | Task9 packaging/startup; later Task13 coverage | **P0:** port final macOS/Windows behavior and focused tests in Task9b. Linux remains deferred. |
| Existing `src/mdm/` registry | 0 | Existing editor/hook installation support | No upstream change to adopt. Do not confuse it with the new top-level `mdm/` directory. |
| Packaging and install paths | 18 | Tasks 9 and 14 | **P0/P2:** take proven package correctness fixes selectively. Review `install-hooks --env`, WSL and unattended-prompt work separately; do not inherit policy or credential transport by accident. |
| Daemon/runtime | 95 | Completed Tasks 4 and 6; future Tasks 9 and 13 | **P1:** highest-risk conflict area. Triage crash, retry, data-loss and shutdown fixes individually and port with focused tests. |
| Agent/editor integrations | 26 | Task13 and completed Task6 routes | **P1:** compare before Task13 freezes its coverage matrix. No support claim from upstream code alone. |
| Attribution/rewrite/note behavior | 59 | Completed Tasks 1 and 2; Task15 integrity | **P1:** regression review against TrackAI attribution semantics; never import changed metrics meaning implicitly. |
| Metrics/usage/telemetry | 40 | Completed Task2 and TrackAI dashboards | **P1:** review correctness fixes, but preserve TrackAI schema/privacy contracts. Known merge hotspots include `src/metrics/db.rs` and telemetry workers. |
| Configuration/auth/credential paths | 5 | Tasks 9 and 14 | **P2:** inspect when the owning task reaches the affected interface. TrackAI's OS-secret-store and machine-credential decisions remain authoritative. |
| Upgrade/release paths | 10 | Tasks 9 and 14 | **P2:** review for rollback, provenance and reproducibility work; do not equate a published asset with TrackAI validation. |
| CI, dependencies and documentation | 71 | General maintenance | **P3:** defer unless required by an adopted fix or a security/toolchain issue. |

## Task9 finding: upstream MDM is additive, not the old registry

The fork's existing `src/mdm/` code is an installer registry for hooks/editors. Public upstream added a different top-level `mdm/` kit for idempotent per-user login start:

- macOS LaunchAgent: `RunAtLoad`, no keep-alive supervision;
- Windows per-user Scheduled Task: ignore concurrent starts and no execution time limit;
- Linux systemd user unit: intentionally deferred by TrackAI;
- `--env`, `--bin`, `--no-start` and `--uninstall` installer behavior;
- static/integration drivers plus per-PR and nightly hosted workflows;
- release-asset publication of the scripts.

The series began at `fb48f9530` and was hardened by `42fc263c8`, `edbd6d80f`, `566db8d48`, `ad2f9eb46`, `76b30d6a0` and `7e0dd3455`. Its test/CI/release evidence spans `805bdda44`, `c8cee8e37`, `cce3b6c55`, `376a99281`, `962141fd7`, `0cd8ede13`, `5fc7ff2c2`, `f9d3820a0`, `97074e657`, `7901a3593` and `a28afd9c6`.

Task9b should therefore port the current macOS/Windows end state and tests with those SHAs recorded as provenance. A blind cherry-pick is inappropriate because:

1. the series includes Linux, which TrackAI has deferred;
2. later commits depend on upstream daemon option `bg start --retry-secs` (`28ee79faa`), which touches a fork hotspot and needs a minimal local port/test;
3. public upstream still exposes MSI `API_KEY`/`API_BASE` properties, while TrackAI explicitly requires packages to transport no machine secret;
4. adjacent upstream `install-hooks --env`, WSL and unattended-prompt changes have separate behavior and policy implications.

The safe rule is: try clean applicability only to understand conflicts; cherry-pick a commit only when it is self-contained and correct unchanged. Otherwise port the final behavior plus focused tests and cite the source SHAs in the commit body and handoff.

## Quick review queue beyond Task9

- **Tasks 4 and 6 (finished):** audit daemon retry, lock, checkpoint, shutdown and subprocess fixes first. These can affect reliability without changing product scope.
- **Tasks 1 and 2 (finished):** run attribution and metrics regression comparisons before adopting semantic changes. Local schema and privacy constraints win on conflict.
- **Task5 (finished):** review evidence/OpenCode-related changes only against the existing Evidence Explorer and explicit manual-sync boundary (G7).
- **Task13:** compare the 26 agent/editor commits and the login-start test matrix before promising broader runtime coverage.
- **Task14:** revisit package provenance, update/release and credential-path fixes during its supply-chain work.
- **Task15:** use upstream attribution changes as test cases, not as the trust or signing design.

## Adoption record template

For every selected upstream change, record: upstream SHA(s), TrackAI owner/task, unchanged cherry-pick versus adapted port, excluded upstream behavior, conflicts resolved, focused tests, hosted/native evidence still pending, and the resulting fork commit/PR.
