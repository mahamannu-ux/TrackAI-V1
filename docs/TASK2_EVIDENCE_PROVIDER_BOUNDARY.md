# Task2 development evidence provider boundary

## OpenCode

T2.24 reads OpenCode `session`, `message` and `part` records from the configured
local SQLite database. User text, assistant text/reasoning and tool state are
available. Commit correlation is exact through the Git Note conversation ID;
individual turns are bounded by commit timestamps and labelled `time-window`
unless stronger trace evidence exists.

## GitHub Copilot

Git AI kind-6 events can contain prompt, response, tool and trace metadata, but
token-bearing spans are inconsistent across conversation/model changes. A later
adapter must correlate request/trace IDs, deduplicate replayed usage and return
`Unavailable` when Copilot exposes no token evidence.

## Antigravity

The current integration produces model-labelled session/checkpoint evidence for
Gemini, Claude and GPT-family models. E13 exposed no kind-5 token evidence.

## Production boundary

T2.24 persists no raw provider content in Supabase. Production storage,
encryption, authorization, redaction, retention, deletion, semantic search and
the polished Evidence Explorer belong to Task4 and Task5.
