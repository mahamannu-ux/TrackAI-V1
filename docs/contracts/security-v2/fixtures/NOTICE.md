# Fixture notice

The finding and enforcement fixtures contain adapted material from
[Numbat](https://github.com/perplexityai/numbat), commit `20a5a52`, licensed
under the Apache License 2.0.

- `valid-finding.json` is a privacy-reduced TrackAI projection of the real
  `cmd/numbat/testdata/secrets_fixture.ndjson` event `e1` and the
  `secrets.agent_read_env` match asserted by `cmd/numbat/main_test.go`.
- `valid-enforcement.json` uses Numbat's real hook enforcement record shape
  from `cmd/numbat/hook_enforce_test.go` and projects the deny for the same
  `cat .env` action represented by event `e1`. Numbat's CLI fixture stream
  contains input events, not persisted enforcement records.

Paths, host names, user names, tenant identity, machine identity, session
identity and lease identity are omitted or replaced with explicit placeholders.
No secret, raw tool input, raw tool result, message content or evidence payload
is retained.

The remaining fixtures are original TrackAI contract examples. Numbat field
names and enum meanings are still governed by the source attribution in the
parent contract README.
