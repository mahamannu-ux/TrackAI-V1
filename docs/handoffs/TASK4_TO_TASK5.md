# Task4 → Task5 Handoff

**Status:** Task4 is merged and its post-pause recovery gate passed. Task5 may
start in a separate task, branch and worktree.

This file—not either Codex conversation—is the concise cross-task source of
truth. Do not copy Task4's chronological evidence log into Task5.

## Immutable starting points

| Repository | GitHub `main` SHA | State |
|---|---|---|
| TrackAI | `91e5724269789f4aa1b357d0665f88bd01af8852` | Task4 server, web, migrations and documentation merged |
| Git AI | `2d240fb939313f0cfbe43b71b779a1ac683dfb5d` | Task4 client plus upstream Git AI `1.6.19` merged |

Create Task5 from current GitHub `main`; do not continue inside either Task4
worktree. Suggested branch: `feature/task5-evidence-explorer`.

## Verified foundation Task5 may consume

- Tenant-bound authentication, RLS and Company A/B isolation.
- Envelope encryption and managed machine/GitHub credential lifecycle.
- Durable tenant/repository/branch/key-bound client queue with retry and
  quarantine.
- Repository enrollment, branch grants, watermarks and controlled backfill.
- Immutable observed evidence, audited corrections and lifecycle projections.
- Tenant-safe monitoring, canonical export/restore and authenticated download.
- Supabase recovery check on 2026-09-19: 42 production tables, 10 migrations,
  both tenant logins, both managed GitHub reads and current client health passed.

Canonical authorities:

- Task2 owns metric and lifecycle meaning.
- [`TASK4.md`](../../TASK4.md) owns Task4 implementation evidence.
- [`ROUGH_ROADMAP.md`](../../ROUGH_ROADMAP.md) owns Task5 scope.
- [`TASK14.md`](../../TASK14.md) owns production deployment certification.

## Task5 first boundary

Start with **T5.1 Evidence Taxonomy and Identity**, then settle **T5.2 Privacy,
Authorization and Consent** before persisting or displaying raw content.

The first implementation wave should be metadata-only:

1. define stable evidence entities and edges;
2. distinguish observed, inferred, corrected and unavailable data;
3. preserve tenant and field-level authorization;
4. expose explicit gaps rather than inventing causality; and
5. use synthetic content in tests.

## Safety rules

- Do not enable raw prompts, responses or tool payloads by default.
- Do not print or commit credentials, private keys, database contents or real
  customer content.
- Do not redefine Task2 metrics or Task4 security contracts silently.
- Semantic search must wait for explicit opt-in, tenant isolation, deletion and
  access-control decisions.
- Insights must explain systems and workflows, not become unsupported employee
  surveillance or productivity scoring.
- Use dry-run-first migrations/backfills and one bounded user step at a time.

## Work that Task5 must not absorb

| Work | Owner |
|---|---|
| General policy/Cedar engine and signed endpoint bundles | Task6 |
| Scaled administration/design-system overhaul | Task10 |
| Public SDK/API productization | Task11 |
| Agent and host route expansion | Task13 |
| Cloud/VPC/self-hosted production certification and large-export storage | Task14 |

## Opening checklist for the Task5 agent

1. Verify both GitHub SHAs above before creating the worktree.
2. Read the Task5 section of `ROUGH_ROADMAP.md`, then this handoff.
3. Inspect existing evidence schemas/APIs before proposing new tables.
4. Produce a small T5.1/T5.2 plan with explicit privacy decisions and test
   gates; obtain user approval before schema or raw-content changes.
5. Keep responses concise and explain unfamiliar concepts in simple language.
