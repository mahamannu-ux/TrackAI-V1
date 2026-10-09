# Task9-wave1-prompts Handoff — Task9a and Task9b implementation briefs

> Status: 🟡 prompts complete; independent review and founder push remain. Symbols per AGENTS.md §11.

Branch `docs/Task9-wave1-prompts` (base: `main` at `ff1ea77c660007418e138348ba88c53eae16c0cf`).

This documentation-only session turns the merged Task9 plan into executable Wave-1 prompts: a minimal TrackAI fleet control plane for Codex and secret-free GitAI packaging for Muse. It reduces the operational targets without changing the approved seven-session sequence or broadening support claims.

## At a glance

| | Item | Status |
|---|---|---|
| Scope | Self-contained Task9a Codex prompt | ✅ |
| Scope | Self-contained Task9b Muse prompt | ✅ |
| Scope | Tracker/status board prompt paths and lean targets | ✅ |
| Quality | Exact TrackAI/GitAI source paths and current base SHAs inspected; Markdown diff check | ✅ |
| Integration | No product change or integration run | ✅ none needed |
| Review | Independent cross-agent review | ⬜ founder sends review request |

## Implemented interfaces

No product interface was implemented. The prompts freeze these minimum implementation boundaries:

```text
Task9a: two fleet tables; machine configuration/report routes; admin list,
        configuration, assignment and preview/apply offboard routes; reuse Task4.
Task9b: package-only secret removal; packaging contract test; x64 MSI smoke;
        no GitAI runtime, installer-script or secret-store work.
```

## Ported from

None. Task9a reuses TrackAI Task4 primitives; Task9b reuses existing GitAI WiX/PKG/release machinery. SushiCorp has no endpoint-fleet component.

## Founder-approved decisions

1. Keep the approved seven sessions and sequence.
2. Prefer simple, accurate and extensible implementation; treat original estimates as ceilings.
3. Start Task9a with Codex and Task9b with Muse in parallel.
4. Task9 extends the existing Task4 administration foundation; Task9e later adds a focused fleet workspace rather than replacing Task4 controls.

## Deviations from spec

- Task9a target is reduced from a 0.38× ceiling to about 0.24× by using two tables, existing `machine.manage`, Task4 revocation and audit rather than a generic campaign/provider engine.
- Task9b target is reduced from a 0.25× ceiling to about 0.12× by limiting it to packaging, CI smoke and documentation; runtime bootstrap and OS secret stores remain Task9c.
- The remaining sessions retain their ceiling estimates until Wave-1 actuals provide evidence for a responsible re-estimate.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** obtain cross-agent `ready to push`, then push/merge this docs PR | Task9a/Task9b should start from prompts on `main` | Blocks Wave-1 start |
| 🟡 | Task9b hosted Windows evidence runs only after its GitAI PR is pushed | Local/static checks cannot become IT-T9-04 | Windows CI remains pending |
| 🟡 | No Jamf, Intune or native rental test is part of Wave 1 | Those support claims remain pending as planned |

## Test coverage

- `git diff --check` on the complete documentation change.
- Source inspection against TrackAI `ff1ea77` and GitAI `d26da8e` confirmed named files, existing Task4 routes/auth, package secret path and current release smoke.
- No product test was run because this branch changes only Markdown prompts/planning rows.

## Integration test impact

> **FOUNDER:** none for this documentation PR. Task9a will implement IT-T9-01; Task9b prepares IT-T9-04 but cannot mark hosted Windows CI passed before its own PR runs.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T9-01 | Tenant-bound fleet database/control-plane behavior | Blocking for Task9a | ⬜ assigned by prompt |
| IT-T9-04 | Hosted Windows x64 MSI build/install/uninstall without credential delivery | Minimum Windows packaging evidence | ⬜ assigned by prompt; hosted run later |

## Integration notes

- Task9a and Task9b may run in parallel because they use separate repositories and now share no implementation files.
- Task9c and Task9e wait for Task9a's reviewed/merged route contract.
- Task9b deliberately leaves `src/mdm/`, runtime config, install scripts and daemon startup untouched, reducing Task13 collision risk.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if shown |
|---|---|---|---|---|
| about 0.03× | about 0.03× | one prompt-writing turn | not recorded | not shown |
