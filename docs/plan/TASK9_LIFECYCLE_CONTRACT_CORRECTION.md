# Task9 lifecycle-contract correction

*Frozen design for the smallest correction discovered when Task9d inspected the merged Task9a and Task9c lifecycle boundary. This document changes no runtime contract by itself.*

## Outcome

Task9d remains stopped. Two small implementation sessions land in order:

1. **Task9a2-release-contract-correction** in TrackAI adds a backward-compatible schema-v2 configuration and immutable release metadata.
2. **Task9c2-release-state-correction** in the GitAI fork consumes schema v2 and exposes a reverified execution authorization from persisted verified state.

Only after both PRs are reviewed and merged is Task9d recreated from GitAI `main`. Task9e PR #18 remains valid and is not reverted or rebuilt.

## Frozen decisions

### 1. Version the correction

- Schema v1 remains readable and assignable. Its current `targetClientVersion` exact-match semantics remain unchanged.
- New corrected configurations are schema v2. Do not silently add fields to the closed v1 envelope.
- The existing admin v1 creation request remains accepted temporarily so merged Task9e does not break. A v2 request is explicitly discriminated by `schemaVersion: 2`.
- Schema v1 can continue to carry verified policy state, but it can never authorize managed software execution because it has no immutable release descriptor.

### 2. Separate compatibility from desired release

The v2 envelope replaces the ambiguous outward `targetClientVersion` with two independent objects:

```json
{
  "schemaVersion": 2,
  "clientCompatibility": {
    "minimumVersion": "1.6.19",
    "maximumVersion": "1.6.20"
  },
  "desiredRelease": {
    "version": "1.6.20",
    "releaseTag": "v1.6.20",
    "manifestUrl": "https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS",
    "manifestSha256": "<64 lowercase hex characters>"
  }
}
```

- Compatibility bounds are inclusive canonical semantic versions and `minimumVersion <= maximumVersion`.
- Compatibility answers whether the currently running client may consume and activate the whole configuration. It does not select the software to install.
- `desiredRelease.version` is the version Task9d must reach. `releaseTag` is the exact GitHub release identity. `channel` remains rollout/audit metadata and must never be used as a download selector by managed execution.

### 3. Immutable N and N-1 identity

The immutable release identity is the tuple:

```text
(desiredRelease.version, desiredRelease.releaseTag,
 desiredRelease.manifestUrl, desiredRelease.manifestSha256)
```

The configuration row is immutable, and the client retains the entire verified active configuration plus one verified previous configuration. Therefore N and N-1 each retain their own exact release identity; rollback reassigns the retained older configuration rather than asking a channel what it points to now.

Changing any tuple member requires a new configuration ID and epoch. Reusing an epoch, ID or tag with changed bytes is rejected by the existing configuration digest and the pinned manifest digest.

### 4. Proven exact-release download path

The fork already publishes and consumes exact-tag assets at:

```text
https://github.com/mahamannu-ux/git-ai/releases/download/<releaseTag>/<asset>
```

This is the path emitted by `.github/workflows/release.yml` and selected by `GIT_AI_RELEASE_TAG` in `install.sh` and `install.ps1`. Managed lifecycle uses that exact-tag path only. It must not use:

```text
/worker/releases
/worker/releases/<channel>/download/...
https://github.com/.../releases/latest/download/...
```

The exact URL alone is not trusted to prevent an asset replacement. The verified configuration pins the SHA-256 of `SHA256SUMS`; that manifest pins every downloaded asset. A replacement at the same URL therefore fails closed.

TrackAI accepts only HTTPS, host `github.com`, repository `mahamannu-ux/git-ai`, an exact `/releases/download/<releaseTag>/SHA256SUMS` path whose tag equals the descriptor, and no credentials, query or fragment. Tags are bounded and contain no slash or traversal form.

### 5. Verified configuration authorizes execution

Parsing, assignment or a matching digest is not execution authorization. GitAI may return release metadata to Task9d only from a `VerifiedConfiguration` after all of these pass at the time authorization is requested:

1. persisted exact configuration JSON exists;
2. its SHA-256 matches the stored configuration digest;
3. closed parsing, time validity, compatibility and repository binding pass again;
4. the parsed envelope exactly matches the stored envelope;
5. the injected verifier returns `verified` for those exact bytes;
6. schema v2 contains a valid desired-release descriptor.

Task9c2 adds this authorization seam but performs no download, installation, update or rollback. Task9d is the only later consumer.

Legacy state without persisted exact JSON may remain usable for its existing policy overlay, but it produces no release execution authorization. Newly verified state persists the exact UTF-8 JSON bytes atomically with the parsed envelope and digest.

### 6. Production remains fail-closed

Task15 still owns signatures, trust, rotation and revocation. Until its production verifier exists, `UnavailableVerifier` remains the production adapter:

- schema-v2 candidates may be fetched and staged but cannot activate;
- persisted state cannot yield execution authorization;
- no binary or installer is downloaded or run;
- the acknowledgement remains `verification_unavailable`;
- active/previous state and local work remain unchanged.

Deterministic fake verifiers may exercise verified and rejected unit-test paths. They are not production evidence.

## TrackAI storage and API correction

Task9a2 may change the shared schema only through a new generated migration after `0014`; it never edits migration `0014`.

- Preserve existing schema-v1 rows.
- Allow schema versions 1 and 2, with a check that all v2 release/compatibility fields are present and valid while legacy-only rows cannot pretend to be v2.
- Keep the existing physical `target_client_version` value as the desired release version for v2 if that makes the migration smaller; the TypeScript and wire names must still separate `clientCompatibility` from `desiredRelease`.
- Add only the minimum compatibility bounds, exact tag/manifest URL and manifest SHA-256 storage. Do not add a release service, asset table, campaign table or mutable channel lookup.
- Creation snapshots Task4 grants and Task6 monitor state exactly as today. Tenant isolation, immutable-row triggers, audit and assignment semantics remain unchanged.
- `GET /worker/fleet/configuration` returns the correct closed v1 or v2 envelope for the assigned immutable row.
- Extend IT-T9-01 for v2 storage, A/B isolation, immutability and exact envelope round-trip.

## GitAI parser and state correction

Task9c2 starts only after Task9a2 merges, from GitAI fork `main` at or after `cc155d692`.

- Parse closed v1 and v2 envelopes as an explicit tagged union.
- Preserve v1 exact-client compatibility. For v2, use the inclusive compatibility range and keep desired release independent.
- Validate the exact-tag manifest URL and 64-character lowercase SHA-256 again on the endpoint; never trust server validation alone.
- Persist exact verified JSON for newly activated state, bounded by the existing 256 KiB limit.
- Reverify persisted bytes before returning a typed release authorization. `rejected`, `unavailable`, missing exact bytes, digest mismatch, expiry, compatibility failure or envelope mismatch returns no authorization and does not alter active/previous state.
- Keep exactly active N and previous N-1. Existing exact retained rollback logic remains; no general history is added.
- Do not edit `src/commands/upgrade.rs`, installers, packaging, daemon retry behavior or MDM files in Task9c2.

## Task9e impact assessment gate

Task9e inventory, state badges, selection, assignment and offboarding remain correct and must not be redone. After Task9a2 freezes the final v2 admin input/response union, assess only:

- whether the create-configuration form needs compatibility bounds, release tag, exact manifest URL and manifest SHA-256;
- whether `apps/web/src/lib/api.ts` needs a v1/v2 discriminated union;
- whether desired-release detail needs one compact read-only line.

If needed, this is a narrow TrackAI-only follow-up. It must not reopen inventory, health, assignment, rollback wording or offboarding.

## Sequence

```text
Task9a2 TrackAI contract/storage -> review -> merge
Task9c2 GitAI parser/state       -> review -> merge
Task9e form/type assessment      -> narrow follow-up only if required
recreate Task9d from GitAI main  -> update/rollback and endpoint cleanup
```

Task9d's current clean worktree at `cc155d692` is evidence of the stop point only. Leave it unchanged; after Task9c2 merges, remove/recreate or rebase it from the new GitAI `main` before implementation.
