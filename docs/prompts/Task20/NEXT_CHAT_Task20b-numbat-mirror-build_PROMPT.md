# Handoff prompt: Task20b-numbat-mirror-build (reproducible Numbat build, notices, size and latency), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`, and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. **Create the Numbat mirror fork and the audited tag** (once; skip if already done):
>    ```bash
>    cd ~/AIProjects/numbat
>    gh repo fork perplexityai/numbat --clone=false
>    git remote add trackai https://github.com/mahamannu-ux/numbat.git
>    git tag -a v0.2.0-trackai.1 20a5a52 -m "TrackAI audited pin (Task20)"
>    git push trackai v0.2.0-trackai.1
>    ```
> 3. Install Go **1.26.9** (Numbat's `go.mod` requires it): `brew install go@1.26` or the official package from go.dev. `go version` must print `go1.26.9`.
> 4. `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20b-numbat-mirror-build && cd ~/AIProjects/TrackAI-wt/Task20b-numbat-mirror-build-gitai && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 5. At the end Muse gives you one numbered bash block of measurements to run on this Mac. Paste back only the summary lines it asks for.
> 6. Paste its review request to **Codex** (GitAI owner). Push only after "ready to push".

---

You are **Muse**, building **Task20b-numbat-mirror-build** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

TrackAI ships **Numbat** (`perplexityai/numbat`, Apache-2.0) unchanged inside the **TrackAI Endpoint**, the package installed on developer machines. The audited commit is `20a5a52bab41c9bf6ee857efd43c7b198b055de5`, tagged `v0.2.0-trackai.1` in the TrackAI mirror `mahamannu-ux/numbat`.

This session adds the scripts that build that commit **reproducibly**, run Numbat's own tests, measure binary sizes and hook latency, extract Numbat's coverage table, and carry the licence notices. It does **not** change the package (PKG/MSI), the daemon, hooks, CI workflows, or any Rust code; Task20h does those.

- **Repository:** GitAI fork. **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task20b-numbat-mirror-build-gitai`, branch `task/Task20b-numbat-mirror-build-gitai`.
- **Handoff:** returned in your final reply (GitAI sessions do not add TrackAI process files to the GitAI repository). The Task20 lead copies it into TrackAI.
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. Read TrackAI's `AGENTS.md` in full (`git -C ~/AIProjects/TrackAI-v1 show main:AGENTS.md`), especially §1, §2 "Names", §5a "Third-party sources", §9 items 1, 2, 6 and 14, §12.1 and the §12.4 reply shape. Then read this repository's own `AGENTS.md` and `Taskfile.yml`.
2. Check location and identity: `pwd && git branch --show-current && git log --oneline -1`. You must be in the worktree above, based on GitAI `main` at `d1838619c` or later; otherwise stop. Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only.
3. Baseline: `task build` once (do not run the full test suite; nothing here touches Rust).
4. Estimate: one line against T6. The plan says **about 0.12×**.

## 1. Read before writing
- TrackAI, read-only, through `git -C ~/AIProjects/TrackAI-v1 show main:<path>`:
  - `docs/plan/TASK20.md` §1 item 1 (the pin rule), item 9 (licence) and §6 (budgets table);
  - `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md`, section "Task20: binary redistribution";
  - `docs/contracts/security-v2/README.md`, for the pin and schema constants.
- Numbat, read-only, at `~/AIProjects/numbat`:
  - `.goreleaser.yaml` (upstream's build flags: `CGO_ENABLED=0`, `-trimpath`, `-s -w`, the version `-X` flag);
  - `go.mod` (Go 1.26.9);
  - `internal/version/`;
  - `docs/cli.md:568-606` (`numbat hook EVENT --agent NAME` reads one payload on stdin);
  - `docs/agent-coverage.md` "Matrix" and "Managed hooks";
  - `LICENSE`, `THIRD_PARTY_LICENSES.txt`.
- GitAI: `packaging/README.md`, and `src/mdm/agents/claude_code.rs:13-14` (the Git AI hook command `checkpoint claude --hook-input stdin`).

## 2. Scope (approved by the founder)
### 2.1 Decisions (all made; do not change them)
1. **New folder `packaging/numbat/`**, POSIX shell (`#!/bin/sh`, `set -eu`), `shellcheck`-clean, runnable on macOS 15 and Linux. No network access except `git clone` / `git fetch` of the mirror.
2. **`pin.env`**, sourced by every script:
   - `NUMBAT_MIRROR=https://github.com/mahamannu-ux/numbat.git`
   - `NUMBAT_TAG=v0.2.0-trackai.1`
   - `NUMBAT_COMMIT=20a5a52bab41c9bf6ee857efd43c7b198b055de5`
   - `NUMBAT_VERSION=v0.2.0-trackai.1`
   - `NUMBAT_GO_VERSION=go1.26.9`
3. **`build.sh <goos> <goarch> <out-dir>`** does these in order:
   - clone the mirror at `NUMBAT_TAG` into a fresh temporary directory, and **refuse** unless `git rev-parse HEAD` equals `NUMBAT_COMMIT`;
   - refuse unless `go version` reports `NUMBAT_GO_VERSION`;
   - build `./cmd/numbat` with `CGO_ENABLED=0`, `GOFLAGS=-mod=readonly`, `-trimpath`, `-buildvcs=false` and `-ldflags "-s -w -buildid= -X github.com/perplexityai/numbat/internal/version.Version=$NUMBAT_VERSION"`;
   - write `<out-dir>/numbat_<version>_<goos>_<goarch>/` containing `numbat` (or `numbat.exe`), the checkout's `LICENSE` and `THIRD_PARTY_LICENSES.txt` copied unchanged, and a `PROVENANCE.txt` (mirror, tag, commit, Go version, flags, build time in UTC);
   - write `<out-dir>/SHA256SUMS` (one line per binary).

   Targets: `darwin/amd64` and `darwin/arm64` are required. `linux/amd64`, `linux/arm64` and `windows/amd64` must build but carry no support claim.
4. **`reproduce.sh <goos> <goarch>`** builds twice into two fresh directories and exits 0 only if both binaries have the same SHA-256 (this is IT-T20b-01). It prints the digest and the byte size.
5. **`test-pin.sh`** clones the pin as in `build.sh` and runs `go test ./...` there. It prints one summary line: `numbat-tests: ok <n packages>` or `numbat-tests: failed`.
6. **`measure.sh <numbat-binary> [<git-ai-binary>]`**:
   - **Sizes:**
     - bytes of `numbat`;
     - bytes of `git-ai` (default `~/.git-ai/bin/git-ai` if present);
     - whether `git-ai` is stripped (`nm "$bin" | wc -l` on macOS; 0 or "no symbols" means stripped).
   - **Latency:** 200 timed runs each, after 10 warm-up runs, of:
     - (a) `numbat hook PreToolUse --agent claude --output-file "$TMP/records.ndjson"` with the benign payload `fixtures/claude-pretooluse-benign.json` on stdin;
     - (b) the same with `fixtures/claude-pretooluse-match.json`, a `Bash` tool call `cat .env`, which Numbat's `secrets.agent_read_env` matches;
     - (c) `git-ai checkpoint claude --hook-input stdin` with the benign payload.
   - Time each run with `perl -MTime::HiRes` (present on macOS). Print the median, p95 and max in milliseconds per case.
   - **Isolation (AGENTS.md §9 item 6):**
     - every run uses `HOME="$TMP/home"`, a throwaway directory, plus a throwaway `git init` repository as the working directory;
     - case (c) runs only when `GIT_AI_MEASURE=1` is set;
     - if `git-ai` reports that it needs a running daemon or a configuration it cannot find in the throwaway home, print `git-ai-hook: unavailable (<reason>)` and **never** start, stop or contact the developer's own daemon.
   - The script never prints payload contents, record contents or paths outside `$TMP`.
7. **`extract-coverage.sh <numbat-checkout> <out-file>`** copies the "Matrix", "Permission and decision telemetry" and "Managed hooks" sections of `docs/agent-coverage.md` verbatim. It prepends a header naming the source, commit and Apache-2.0. Commit one output for the pin as `packaging/numbat/coverage/v0.2.0-trackai.1.md`.
8. **`SYNC.md`**, the monthly-sync runbook, as numbered steps:
   1. fetch upstream into the mirror;
   2. choose the upstream release or commit, and prefer the first upstream release that contains the current pin (TASK20.md §1 item 1);
   3. tag it `v<upstream>-trackai.<n>`;
   4. update `pin.env`;
   5. run `test-pin.sh` and `reproduce.sh` for both macOS architectures;
   6. run TrackAI's contract tests with Numbat checked out beside the TrackAI worktree (`npm test` in TrackAI; the pinned-source assertions in `v2-contract.test.ts` must not be skipped);
   7. run `extract-coverage.sh`;
   8. check the licence: does a `NOTICE` exist now, and has `THIRD_PARTY_LICENSES.txt` changed?
   9. diff the 51 rule files against the previous pin;
   10. hand the record to the Task20 lead.
9. **`README.md`** in `packaging/numbat/` says what each script does and states:
   - "Powered by Numbat (Apache-2.0)";
   - TrackAI ships Numbat unchanged;
   - the binaries are not code-signed here (Task20h and Task14 sign them).
10. **Fixtures**: the two hook payloads above, synthetic, with no real path, user or secret. Use the Claude Code `PreToolUse` shape that Numbat's own `cmd/numbat/hook_test.go` uses. Name the test you copied the shape from in a comment line of the README.

### 2.2 Port from
- None from SushiCorp (it has no endpoint detector). Third-party: Numbat's `.goreleaser.yaml` build flags are the behaviour contract; record "source: perplexityai/numbat@20a5a52 .goreleaser.yaml" in `README.md`. No Numbat source code is copied; the copied `LICENSE` and `THIRD_PARTY_LICENSES.txt` stay byte-for-byte.

### 2.3 Pre-approved files
- `packaging/numbat/**` (scripts, `pin.env`, `fixtures/`, `coverage/`, `README.md`, `SYNC.md`)
- `.gitignore` (one line ignoring `packaging/numbat/out/`)

### 2.4 Never touch
- Rust sources, `Cargo.*`, `packaging/macos/`, `packaging/windows/`, `mdm/`, `.github/workflows/`, `Taskfile.yml`, the Numbat checkout and mirror (beyond reading), TrackAI. If the work needs any of these, stop and describe it.

## 3. Working rules
- Commits `Task20b: …` at each stage:
  1. `pin.env` and `build.sh`;
  2. `reproduce.sh` and `test-pin.sh`;
  3. `measure.sh` and the fixtures;
  4. coverage and `SYNC.md`;
  5. `README.md`.
- **Run in your sandbox**, if Go 1.26.9 is available:
  - `shellcheck packaging/numbat/*.sh`;
  - `build.sh darwin arm64` (or `linux amd64` where you are);
  - `reproduce.sh` once;
  - `measure.sh` with the case (c) guard off.

  If Go or the network is missing, say so (a sandbox failure, AGENTS.md §9 item 15) and leave the run to the founder.
- **Independent review:** re-read the full diff as a reviewer before the final reply.

## 4. Close-out
- **Final reply** in the AGENTS.md §12.4 shape:
  1. **Effort** against 0.12×.
  2. **The handoff text** (under 70 lines, from TrackAI's `docs/templates/HANDOFF_TEMPLATE.md`), naming:
     - the file list;
     - the measured numbers;
     - a **budget proposal**: Numbat binary ≤ 25 MB per macOS architecture; Numbat hook p95 ≤ 100 ms; both hooks together p95 ≤ 150 ms. If the measurements break these, propose new numbers and say why.
  3. **One numbered bash block for the founder:**
     - `# 1.` cd into the worktree;
     - `# 2.` `sh packaging/numbat/test-pin.sh` (expect `numbat-tests: ok`);
     - `# 3.` `sh packaging/numbat/reproduce.sh darwin amd64` and `darwin arm64` (expect identical digests);
     - `# 4.` `sh packaging/numbat/build.sh darwin amd64 packaging/numbat/out && GIT_AI_MEASURE=1 sh packaging/numbat/measure.sh packaging/numbat/out/numbat_v0.2.0-trackai.1_darwin_amd64/numbat` (paste back only the summary lines);
     - under `# after the cross-agent review`: `git push -u origin task/Task20b-numbat-mirror-build-gitai`, `gh pr create --base main --head task/Task20b-numbat-mirror-build-gitai --title "[Task20b] Numbat mirror build" --body "<handoff text>" --repo mahamannu-ux/git-ai`, and `gh pr merge … --merge --repo mahamannu-ux/git-ai` after a clean trial merge of `origin/main`.
  4. **The review request for Codex** in a `text` block.
- Clean tree. Do not push, open a PR or merge.

## Lessons so far
- **Task9b (Muse, GitAI):** stayed inside its pre-approved files and returned the handoff in the reply. Repeat that.
- **Task20a (Codex):** provenance claims were checked against the pinned source; cite `numbat@20a5a52:path:line` for every Numbat fact you rely on.
