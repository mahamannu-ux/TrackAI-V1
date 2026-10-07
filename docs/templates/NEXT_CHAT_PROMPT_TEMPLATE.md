# Session prompt template

Copy to `docs/prompts/NEXT_CHAT_<name>_PROMPT.md`. Everything in `<angle brackets>` is filled per session; delete these two lines.

---

# Handoff prompt: <name> (<what it builds, in a few words>), <agent>

> **Founder setup (<agent>: skip to "You are…"):**
> 1. Merge <the PRs this session builds on> and this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull`.
> 2. <Per agent, one of:>
>    - **Claude:** open a new chat in the project, link it to this machine, and paste everything below the line.
>    - **Codex:** start a new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`), and paste everything below the line.
>    - **OpenCode (Muse) or another CLI agent:** `cd ~/AIProjects/TrackAI-v1 && make worktree M=<name> && cd ~/AIProjects/TrackAI-wt/<name> && npm ci && opencode` (GitAI: `make gitai-worktree M=<name>` and `cd ~/AIProjects/TrackAI-wt/<name>-gitai`); pick Muse Spark; keep permission prompts on; paste everything below the line. Reply "continue" if it stops.
> 3. <Anything the founder must provide: an account, a sample file, a running service. Never ask for a secret in the chat.>
> 4. <Checkpoints, if any: "it sends you screenshots after X; answer in plain words".>
> 5. When it finishes, paste its review request to <the reviewer: TrackAI-Orchestrator for non-Claude agents; Codex or Muse for Claude>. Push only after "ready to push".

---

You are **<agent>**, building **<name>** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. <Two or three sentences: what came before, what this session adds, and what it does not touch.>

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/<name>`, branch `task/<name>`.
- **Handoff:** `docs/handoffs/<name>_HANDOFF.md`.

## 0. Before anything else
1. **Read `AGENTS.md` in full**, in particular <the sections that bind this session: §12.1, the §12.4 reply shape, §8 Effort, explicit staging>.
2. **Check location and identity:** `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`; if not, stop and tell the founder. Codex: if the branch is detached or `codex/...`, run `git switch -c task/<name>` now. Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only. <What must exist, e.g. "the checkout contains <file>; otherwise stop".>
3. **Toolchain** as in AGENTS.md §6 (one environment per worktree); run `npm test` once as a baseline.
4. **Estimate:** one line against T6. The plan says **about <x>×**. <Name the shared surfaces that will push it up.>

## 1. Read before writing code
- <Handoffs this builds on: name the sections ("Implemented interfaces", "Integration notes").>
- <The Task tracker section and the approved scope in `docs/plan/primers/<TaskN>_PRIMER.md`.>
- <Code: list the exact files, including read-only ones.>
- <Catalog entries, if a catalogued concern is involved (§2 "Port from").>

## 2. Scope (approved by the founder)
### 2.1 Approved decisions
1. <Each decision stated as built: routes, fields, behaviour, limits. Muse and other CLI agents need every decision here, upfront; Claude and Codex may get a design checkpoint instead.>

### 2.2 Port from (always present; "none, because …" when nothing in the catalog or SushiCorp applies)
- **Catalog entry:** `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` § <entry>.
- **Source:** `<repo>` at `<commit>`: <paths of code, tests, migration, handoff>.
- **Keep:** <contract, test vectors, invariants that must survive the translation>. **Translate:** <what changes with the stack>.
- Record provenance and deviations as `~/dev/agent-kit/reuse/PORTING_GUIDE.md` says.

### 2.3 Pre-approved files
- <every file and directory the scope implies, including shared ones: migrations, dependency manifests, the repository methods a route needs>

### 2.4 Never touch
- the frozen paths (AGENTS.md §1), <other units' directories>, <generated files except through their generator>. If the work needs one, **stop and describe it**; do not work around it.

## 3. Working rules
- **Commits** prefixed `<ID>: …`, at each stage: <interfaces, then each part, then the handoff>. `npm run lint`, `npm run typecheck` and `npm run check` clean on what you touch.
- **Tests:** <what the unit tests must prove, through the real API in-process: success, paging, filters, error codes, tenant isolation, the read-only role>.
- **Integration:** <the IT IDs>; run each once in your sandbox, small, through `scripts/it-db.sh <command>`; the founder runs the full set.
- **Review:** one independent review before the handoff (AGENTS.md §12.3), then the cross-agent review.

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under <N> lines**, with <what it must name> and **Effort**.
- `docs/plan/STATUS_BOARD.md`: the status board row, the integration test registry rows, the remaining-plan actual.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape: the effort line; one bash block (<tests, integration runs>, then under `# after the cross-agent review` the push and `gh pr create --base main --head task/<name> … --repo mahamannu-ux/TrackAI-V1`); then the review request in a `text` block.

## Lessons so far
- **<earlier session> (<agent>):** <one line each: what to repeat, what to avoid>. Take them from the lessons table in `docs/agents/MANAGER_PROMPT.md` and `~/dev/agent-kit/agents/LESSONS.md`.
