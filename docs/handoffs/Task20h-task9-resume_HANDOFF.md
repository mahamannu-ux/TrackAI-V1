# Task20h-a: Task9 package rerun decision

This docs-only branch records the Task20h-a release change and founder Intel Mac debug-package result in `docs/plan/TASK9.md` decision 11 and 12 and the IT-T9-02 status-board row. The universal PKG is replaced by separate `x64` and `arm64` PKGs; MDM rollout instructions must select the Mac's architecture.

The founder's Task20h-a run exercised a debug Intel install, managed hooks, a signed development rule bundle, monitor/off behavior and manual cleanup. It did **not** rerun Task9's signed package, offline queue, update, rollback, credential rotation, revocation or Jamf checks. IT-T9-02/03/07 remain pending until the Task20h-a package merges and Task9f resumes.

Root cleanup from the main console could not unlock the guest Keychain credential and returned nonzero after removing hooks, Numbat and security state. A guest-console retry removed the credential and bootstrap. Task9f must check unattended offboarding with a locked guest Keychain.

Integration test impact: documentation only; no runtime change. `git diff --check origin/main` passed after merging refreshed `origin/main`.
