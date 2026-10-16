# Fixture notice

The finding and enforcement fixtures contain adapted material from
[Numbat](https://github.com/perplexityai/numbat), commit `20a5a52`, licensed
under the Apache License 2.0.

- `valid-finding.json` is a privacy-reduced projection of the real
  `cmd/numbat/testdata/secrets_fixture.ndjson` event `e1` and its
  `secrets.agent_read_env` 1.3 match. Its source ID is reproduced from the
  pinned `internal/finding/finding.go` length-prefixed ID algorithm.
- `valid-enforcement.json` is the monitor-mode enforcement record Numbat emits
  beside that finding for the same `cat .env` hook action. Its source ID is
  reproduced from pinned `cmd/numbat/hook.go:hookDecisionID` using fixture run
  `run-placeholder` and action event `e1`. Numbat's
  `TestHookWritesFindingToFileSinkNotStdout` proves that the real file sink
  persists the finding followed by this `no_override`/`monitor` record.
- `valid-rule-bundle.json` embeds the exact valid operator rule used by pinned
  Numbat's `TestRulesCheckRunsCompanionTestsAgainstBuiltinOverride`; that test
  executes `numbat rules check` successfully.

Paths, host names, user names, tenant identity, machine identity, session
identity and lease identity are omitted or replaced with explicit placeholders.
No secret, raw tool input, raw tool result, message content or evidence payload
is retained.

The remaining fixtures are original TrackAI contract examples. Numbat field
names and enum meanings are still governed by the source attribution in the
parent contract README.
