# Handoff prompt: Task9a2-release-contract-correction (schema-v2 immutable release contract), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the Task9 lifecycle-contract-correction documentation PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull` and confirm Task9e PR #18 merge `b43d007` is an ancestor.
> 2. Start a new Codex thread in **Worktree** mode in the TrackAI project and paste everything below the line.
> 3. Do not delete, rebase or edit the stopped GitAI Task9d worktree.
> 4. When it finishes, paste its review request to TrackAI-Orchestrator. Push only after `ready to push`.

---

You are **Codex**, building **Task9a2-release-contract-correction** in TrackAI. Task9a's schema-v1 fleet contract and Task9c's client landed, but Task9d correctly stopped because v1 conflates client compatibility with desired software, names only a mutable channel, and cannot prove that a verified configuration authorizes an exact release. Add the smallest backward-compatible schema-v2 TrackAI contract and storage correction. Do not change GitAI, Task9e UI, Task9d lifecycle code or Task15 verification.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree:** `~/AIProjects/TrackAI-wt/Task9a2-release-contract-correction`, branch `task/Task9a2-release-contract-correction`.
- **Handoff:** `docs/handoffs/Task9a2-release-contract-correction_HANDOFF.md`.
- **Required base:** TrackAI `main` containing PR #18 merge `b43d007` and this prompt's documentation PR.

## 0. Before anything else

1. Read `AGENTS.md` in full, especially frozen migrations, shared-schema approval, integration tests, explicit staging and final reply shape.
2. Verify `pwd`, Git root, branch, HEAD and clean state. Work only in the named worktree; set the worktree-local identity to `mahamannu-ux <mahamannu@gmail.com>`.
3. Read `docs/plan/TASK9_LIFECYCLE_CONTRACT_CORRECTION.md` completely. Its field meanings, v1 compatibility, exact URL rule, digest pin and fail-closed boundary are frozen.
4. Read Task9a's handoff and exact current code in `apps/api/src/features/fleet/{contract.ts,service.ts,fleet.routes.ts,fleet.test.ts,task9-fleet-live-verify.ts}`, `apps/api/src/core/db/schema.ts`, migration `0014` and its immutability/RLS machinery. Read Task9e's client types/form read-only to prove it will not break.
5. Baseline once: `npm run test:fleet -w apps/api`, `npm run typecheck`, `npm run lint`, `npm exec drizzle-kit check -w apps/api`. Estimate one line against T6; target about **0.14×**, ceiling **0.20×**.

## 1. Frozen contract

1. Preserve closed schema v1 unchanged and readable/assignable. Existing Task9e v1 creation requests without `schemaVersion` keep working and create v1 rows.
2. Add an explicitly discriminated v2 creation input with:
   - `schemaVersion: 2`;
   - `clientCompatibility: { minimumVersion, maximumVersion }`, inclusive canonical semantic versions with minimum not greater than maximum;
   - `desiredRelease: { version, releaseTag, manifestUrl, manifestSha256 }`;
   - the existing channel, optional ring, optional future `validUntil` and required audit reason.
3. Schema-v2 worker envelopes use those two objects and do not expose `targetClientVersion`. Channel is metadata, never a download selector.
4. Immutable release identity is the full `(version, releaseTag, manifestUrl, manifestSha256)` tuple. Any change requires a new configuration ID/epoch.
5. `manifestUrl` accepts only HTTPS `github.com/mahamannu-ux/git-ai/releases/download/<releaseTag>/SHA256SUMS`, with the URL tag exactly equal to `releaseTag`, no credentials/query/fragment, encoded separators or traversal. The tag is bounded and slash-free. `manifestSha256` is exactly 64 lowercase hexadecimal characters.
6. `verification` remains exactly `{ required: true, state: 'unavailable' }`. Do not add signatures, keys or unsigned success.
7. V1 and v2 assignment, tenant scoping, machine scoping, immutable audit, snapshot content, offboarding and reports keep their current behavior.

## 2. Storage and compatibility

1. Generate a new migration after `0014`; never edit any merged migration or frozen contract fixture.
2. Preserve existing v1 rows. Allow schema versions 1 and 2 with database checks that prevent partial/mixed v2 metadata.
3. Add only the minimum compatibility bounds, exact release tag/manifest URL and manifest SHA-256 storage. Reusing the existing physical `target_client_version` value as v2 `desiredRelease.version` is approved if it keeps the migration smaller; outward TypeScript and JSON names must remain separated.
4. Keep the immutable-row trigger, RLS/no-browser-policy posture, composite tenant keys and `withTenant()` access. No new table, release service, asset proxy or mutable channel resolver.
5. Return a closed discriminated v1/v2 admin response union so later Task9e assessment can be narrow. Do not modify Task9e in this session.

## 3. Tests and evidence

TDD must prove:

- v1 input/envelope remains byte-shape compatible for merged clients and UI;
- v2 valid round-trip and machine-scoped repository snapshot;
- compatibility bounds, tag, URL and digest reject unknown, malformed, mismatched, mutable-channel/latest, traversal, query/fragment and uppercase/non-64 digest forms;
- v1 cannot masquerade as v2 and partial v2 storage is impossible;
- immutable v2 tuple, tenant A/B separation and older-config reassignment remain enforced;
- worker responses remain `no-store` and Task15 verification remains unavailable.

Extend IT-T9-01 rather than inventing another database verifier. Run it once through `scripts/it-db.sh`; it is blocking for this TrackAI fleet-contract change. Then run one stable final `npm test`, typecheck, lint, Drizzle check and production web build with the existing safe dummy Supabase build variables.

## 4. Port from and scope

**Port from:** none. Reuse Task9a's merged two-table contract, Task9c's field constraints, and the exact-tag path already proven by the GitAI fork's release workflow/installers. Do not copy public-upstream code.

**Pre-approved shared files:** `apps/api/src/core/db/schema.ts`; one new generated migration and its generated meta; `apps/api/src/features/fleet/**`; exact package scripts only if IT-T9-01 registration needs adjustment; `docs/handoffs/Task9a2-release-contract-correction_HANDOFF.md`; this session's Task9/STATUS rows.

**Never touch:** migrations `0000`–`0014`; `docs/contracts/**`; Task9e web files; Task4/Task6 semantics; GitAI; release workflows/assets; Task15 implementation; Task9d worktree.

## 5. Close-out

- Small commits prefixed `Task9a2-release-contract-correction:`; explicit staging; clean tree; no push/PR/merge.
- Handoff under 90 lines naming the exact v1/v2 union, migration, preserved Task9e behavior, IT-T9-01 output, production blocker and whether a narrow Task9e form/type follow-up is required.
- Final reply follows `AGENTS.md` §12.4 with exactly one founder bash block and one review request. The review request must name the branch, commits, base, migration, focused/full gates and Task15/Task9c2 dependencies.

## Lessons to carry forward

- A channel is mutable rollout metadata, not immutable release identity.
- A pinned manifest digest makes replacement at an exact-tag URL fail closed.
- Backward compatibility is explicit v1/v2 branching, never silent reinterpretation.
- Task9e PR #18 remains valid; assess only its configuration form/types after v2 freezes.
