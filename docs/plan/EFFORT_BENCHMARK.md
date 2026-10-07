# TrackAI effort benchmark

How TrackAI estimates sessions (agent-kit `effort/EFFORT_BENCHMARKS.md`). Every prompt states the plan's estimate; every session gives its own estimate in its first message and its actual in the handoff's Effort section.

## The benchmark: T6 = Task6.a Security = 1.0×

**Why this Task:** it is the most recent finished Task, ran entirely in Codex's wave style (six waves, ten evidence gates), spans both repositories as most future Tasks will, and has a complete evidence trail. Task2 carried project-setup noise, and Task4 and Task5 merged together, so neither measures cleanly.

**What 1.0× contains** (measured from git, not from transcripts; Codex shows no token counts):

```text
Repo     Commits  Days (calendar)        Code changed                     Tests
TrackAI  109      2026-09-26 .. 10-01    17 TS files, ~2.5K lines         ~700 test lines, 150 API tests total
GitAI    58       same window            20 files (Rust evaluator, hooks)  39 security tests, 19 OpenCode IT
Plus: Numbat inventory (51 rules triaged, 3 adopted), contracts and fixtures, license plan,
      five real-machine end-to-end cases, a role-based browser walkthrough, release handoff.
```

## Calibration against SushiCorp

SushiCorp's benchmark **S3** (one medium Claude session: about 2,000 lines of service code, 120 unit tests, 6 integration tests, about 3.5 h, about $31) is the kit's reference.

- **T6 ≈ 4× S3:** the TrackAI side ≈ 1.3× S3 (similar code size, more tests), GitAI ≈ 1× S3, live verification and evidence ≈ 1.5× S3.
- So **1 S3 ≈ 0.25× T6.** A good session is 0.1–0.4× T6; split anything larger (AGENTS.md §12.8).
- Kit data says Codex and Muse ran about 1.3–1.6× over Claude-written estimates on non-trivial SushiCorp sessions. Apply that factor until TrackAI has its own data.
- Rule of thumb from the kit: add about 0.05× T6 (≈0.2× S3) per shared surface a session touches (a migration, a contract, `schema.ts`, `index.ts`).

## Recording an actual
In the handoff's Effort table: estimate, actual, agent turns (or prompts), wall-clock, tokens or cost if the tool shows them. "By turns" or "by commits" is acceptable when the transcript cannot be measured; say which. Copy the actual into the remaining-plan table in `docs/plan/STATUS_BOARD.md`. When an actual exceeds 1.25× its estimate, the handoff names the causes (the 1.25× rule).

## TrackAI data

```text
Agent   Session              Estimate  Actual   Main cause of the gap
Claude  docs/adopt-agent-kit  0.06x    0.05x    (by turns)
```
