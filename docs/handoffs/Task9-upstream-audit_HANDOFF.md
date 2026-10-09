# Task9-upstream-audit Handoff — public GitAI inventory and Task9b revision

> Status: ✅ documentation complete · 🟡 prompt execution and hosted evidence remain future work.

Branch `docs/Task9-upstream-audit` (base: `main` at `117a005307032c0039bd399106d6aed545b3f1f7`, PR #14 merge).

This session read the public GitAI history after TrackAI's imported v1.6.19 snapshot, inventoried all 302 upstream-only commits, prioritized them against completed and future Tasks, and revised Task9b to reuse the final macOS/Windows login-start design without bulk-syncing Linux or unsafe MSI credential behavior.

## At a glance

| | Item | Status |
|---|---|---|
| Acceptance | dated, reproducible inventory plus per-commit TSV ledger covers the complete 302-commit range | ✅ |
| Acceptance | G5 records the correct imported snapshot and priority order | ✅ |
| Acceptance | Task9b answers cherry-pick versus selective-port strategy | ✅ |
| Scope | Task9b adds bounded macOS/Windows login-start reuse and preserves Linux deferral | ✅ |
| Quality | Markdown links, whitespace and documented SHAs checked | ✅ |
| Integration | no product code or live environment changed | ✅ none needed |
| Review | full documentation diff re-read locally; cross-agent review | 🟡 founder/orchestrator review pending |

## Implemented interfaces

No product interface was implemented. The revised Task9b prompt freezes these future implementation boundaries:

```text
macOS: per-user LaunchAgent -> git-ai bg start --retry-secs
Windows: per-user Scheduled Task -> git-ai bg start --retry-secs
Packages: no API key/base or machine credential transport
Excluded: Linux, WSL defaults, nightly release-channel MDM test, live MDM claims
```

## Ported from

No product code was ported in this session. The prompt pins public GitAI snapshot `0670e7ef27590af0e8ff5409267f3f4b09b8fcb4` and names the upstream MDM, daemon-retry, release and package-fix commits Task9b must inspect. It also requires license/notice review and an adoption provenance record.

## Founder-approved decisions

1. 2026-10-09: keep a dated read-only inventory under G5 and use it beyond Task9.
2. 2026-10-09: retain selective upstream adoption; no routine downstream sync.
3. 2026-10-09: Task9b may cherry-pick only a self-contained commit that is correct unchanged; otherwise it ports the tested final behavior with provenance.
4. Linux remains deferred. Task9b adapts upstream's hosted MDM matrix to macOS and Windows only.

## Deviations from spec

- Task9b target rises from about 0.12× to about 0.20× T6, still inside the approved 0.25× ceiling, because it now includes the useful public login-start kit and its bounded daemon retry dependency.
- The public upstream implementation is not copied wholesale: upstream Linux, WSL defaults, nightly workflow and MSI secret properties conflict with TrackAI scope or policy.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ | The 302 commits are inventoried and prioritized, not individually adopted or rejected. | G5 remains a task-driven selective-adoption queue. |
| ⬜ | Task9b implementation and hosted macOS/Windows CI have not run. | No new package, MDM or platform support claim exists yet. |

## Test coverage

Documentation-only validation checks the exact Git range, divergence counts, MDM path count and representative commit provenance. No runtime behavior was changed or tested.

## Integration test impact

> None for this documentation session. Task9b's eventual GitAI PR owns its focused and hosted tests.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T9-04 | hosted Windows x64 package mechanics without plaintext credential transport | Blocking for Task9's minimum Windows evidence, not this docs PR | ⬜ future Task9b run |

The inventory and Task9a may proceed without this hosted run. Task9b support claims must wait for its own implementation and CI.

## Integration notes

- Existing `src/mdm/` and the new public top-level `mdm/` solve different problems.
- Review daemon/runtime upstream fixes one at a time because TrackAI has 71 fork-only commits and known daemon/metrics hotspots.
- Record both imported upstream SHA and resulting fork SHA for every later adoption.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---:|---:|---|
| about 0.04× | about 0.04× | one focused audit/revision | under one session | not shown |
