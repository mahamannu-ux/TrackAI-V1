# Prompt organization

Numbered Tasks with a lead or multiple implementation sessions use one directory:

```text
docs/prompts/Task<N>/
  NEXT_CHAT_Task<N>-lead_PROMPT.md
  NEXT_CHAT_Task<N><subtask>-<slug>_PROMPT.md
```

Keep the lead prompt and every future subtask prompt for that Task together. Generic, cross-Task and completed one-off prompts may remain directly under `docs/prompts/`. Add a Task directory when its lead prompt is created; do not create empty placeholder directories.
