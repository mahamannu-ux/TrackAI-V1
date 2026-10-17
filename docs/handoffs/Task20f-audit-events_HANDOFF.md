# Task20f-audit-events — handoff (stage 1 of Task20f)

*Claude, 2026-10-17. Branch `docs/Task20f-audit-events` from `main` @ `67af037`. The Task16 owner reviews; Task20f's main branch builds on it.*

## At a glance
An additive change to the audit contract, so Task20f can write its events. Catalog version 2 → 3. No emitted entry changes; no migration.

| Action | Change | Why |
|---|---|---|
| `fleet.lease.issued` | owner D6.1 → **Task20**; details now `lease_id`, `expires_at`, `mode`, `bundle_digest`, `epoch` (drops `policy_version?`) | Task20f issues signed per-machine leases (T20.8) |
| `fleet.lease.refused` | owner → **Task20**; actor `machine` only; details `lease_id`, `bundle_digest`, `refusal` as the closed enum of `security-acknowledgement-v1` refusal codes | an Endpoint refusal sent to `POST /worker/security/v2/acknowledgements` |
| `policy.bundle.published` | owner Task6.b → **Task20**; actors `tenant_admin`, `system_operator` (publish CLI); details add `epoch`, `rule_settings_version`, `enabled_rule_count`; `bundle_digest` becomes `sha256_hex` | the signed rule bundle; its digest is the bare hex the wire uses |
| `policy.bundle.acknowledged` | owner → **Task20**; details add `epoch`, `lease_id`, `bundle_digest` | an applied acknowledgement |
| `security.monitor.changed` | owner Task6 → **Task20**; actors add `system_operator`; `mode` / `previous_mode` widened to `monitor_and_pilot_block`; adds `version` | gap G8: the monitor switch gets its writer |
| `security.settings.changed` | **new** (Task20, high) | rule or data settings published: versions, bundle version, epoch, `changed_rule_count`, `enabled_data_settings`, `day_one_scan`, `agents`, `reason` |
| `policy.bundle.activated` | unchanged, stays reserved (Task6.b) | monitor mode needs no separate activation |

## Deviations
1. **The entries stay `reserved` in this PR.** An emitted entry must cite its emitting `file:line` (`audit-contract.test.ts` checks it), and that code lands in Task20f's main branch. The README allows the owning Task to reshape a reserved entry until its first row exists. Task20f's main branch flips the six entries to `emitted` and adds their test fixtures.
2. **`catalog.ts` and `audit-contract.test.ts` change with `catalog.md`.** `catalog.md` is generated from `catalog.ts`, and a unit test fails when they differ, so the contract file cannot change alone.
3. **The data settings are a list (`enabled_data_settings: string[]`), not five booleans.** The raw-content key scan refuses a key named `command_previews` (it contains "command"), and that exception list cannot grow.

## Test coverage
`npx tsx --test apps/api/src/core/audit/*.test.ts`: 12 pass. `npm run audit:catalog -w apps/api` regenerates `catalog.md` with no diff.

## Integration test impact
None. No route, table or emitter changes.

## Effort
Part of Task20f (about 0.02× T6 of its estimate).
