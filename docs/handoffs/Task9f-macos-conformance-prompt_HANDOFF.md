# Task9f macOS conformance prompt handoff

## At a glance

Branch `docs/Task9f-macos-conformance-prompt`, based on TrackAI `main` at `88301f7`. This docs-only session adds the Codex prompt for Task9f. It changes no TrackAI or GitAI product code.

## Implemented interfaces

- `docs/prompts/Task9/NEXT_CHAT_Task9f-macos-conformance_PROMPT.md`
- `docs/plan/TASK9.md` narrowly records Task9d's merge, unblocks Task9f and replaces its conservative estimate with a lower operational target plus the unchanged ceiling.
- Pins GitAI Task9d PR #6 merge `d1838619c5555a47ea0ffb77ecd6d1cc07cf4859` as the Task9f base.
- Splits evidence into local Intel Mac, signed/notarized PKG, Jamf, second-Mac/Apple-Silicon and Task15-dependent rows.
- Pre-approves only a bounded conformance harness, evidence docs/tests and demonstrated repairs in Task9-owned GitAI files.

## Deviations

None. Task9f remains one GitAI/Codex session. Jamf work stays conditional inside that session rather than becoming another implementation session.

## Known limitations

- Jamf Pro, APNs and organization Apple Account provisioning are pending founder work.
- A real signed/notarized PKG depends on existing Apple release credentials/artifacts.
- Successful managed update/rollback remains pending Task15 production verification.

## Test coverage

Documentation inspection only: Markdown paths, referenced SHAs and prompt scope were checked. No runtime code changed.

## Integration test impact

No integration test was executed. The prompt owns founder-assisted IT-T9-02 and conditionally IT-T9-03/07; IT-M9-01 remains blocked on Task15.

## Integration notes

Task9f starts local-first on the founder's 2019 Intel Mac. Jamf may join later in the same session after tenant, APNs and enrollment prerequisites exist. Missing prerequisites remain pending and narrow the support claim.

## Effort

Estimate and actual for this prompt-only session: about `0.02x T6`. The Task9f implementation target is `0.18x T6`, with the existing `0.30x` plan value retained as a ceiling.
