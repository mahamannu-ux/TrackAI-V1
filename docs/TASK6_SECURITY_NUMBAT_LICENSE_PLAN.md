# Task6 Security Numbat license plan

Status: **Approved for the first monitor-only subset; no upstream code copied.** Extended 2026-10-16 for Task20, which **redistributes the Numbat binary** (section "Task20: binary redistribution" below; needs the founder's or legal's approval before the first customer build).

Last updated: **2026-09-29**

Approval recorded: **2026-09-29**

This plan applies only if Task6 later copies or adapts Numbat rule definitions,
tests or implementation material. It does not authorize S6.3 runtime work.

## Source record

| Item | Recorded value |
|---|---|
| Project | Numbat |
| Source | `https://github.com/perplexityai/numbat` |
| Pinned commit | `f0778c09dc48281aa93a3887d05096c0a1f3f9f7` |
| License found at the pin | Apache License 2.0 in `LICENSE` |
| Upstream `NOTICE` file | None found |
| Upstream dependency notice | `THIRD_PARTY_LICENSES.txt`; relevant only if TrackAI ships those dependencies |
| Current Task6 use | Inventory and design review only; no Numbat runtime code or YAML copied |

## Proposed handling

| If Task6 does this | Required handling before merge or release |
|---|---|
| Copies or adapts a Numbat rule, test or implementation file | Keep a copy of Apache-2.0 with distributed material, retain relevant notices, and place a clear “modified by TrackAI” notice in each adapted file. |
| Rewrites a rule independently from the approved behavior contract | Keep the source/pin in the Task6 provenance record and have legal confirm whether distribution notices are still required. |
| Uses a Numbat production dependency | Review and carry the relevant entry from Numbat's `THIRD_PARTY_LICENSES.txt`; do not copy unrelated dependency notices. |
| Changes the upstream pin or adds a rule | Repeat the license, notice, provenance and modification review. |

## Recommended repository files

TrackAI currently has no root license or third-party notice file. Before any
adapted Numbat material is merged, add:

1. `third_party/numbat/LICENSE` containing the exact pinned Apache-2.0 text;
2. `THIRD_PARTY_NOTICES.md` naming Numbat, its source, pin, license and the
   TrackAI files that copy or adapt it; and
3. a short modification header in every copied or adapted source file.

Do not copy Numbat's full dependency notice unless TrackAI actually distributes
those dependencies. Do not use Numbat names or marks as a TrackAI endorsement.

## Approval gate

The proposed notice location and modified-file wording were approved on
2026-09-29. Any later source, license, notice-location or wording change requires
another legal/security review. The final release review must compare the shipped
files with this source record.

This is an engineering compliance plan, not legal advice.

## Task20: binary redistribution (added 2026-10-16 by the Task20 lead)

Task20 ships Numbat itself inside the TrackAI Endpoint package (`docs/plan/TASK20.md` §1 item 9). That is distribution of the Apache-2.0 work and of the Go dependencies compiled into it, so the earlier "only if copied" plan is not enough.

| Item | Recorded value |
|---|---|
| Source | `https://github.com/perplexityai/numbat`, built from the TrackAI mirror fork with no product changes |
| Pinned commit | `20a5a52bab41c9bf6ee857efd43c7b198b055de5` (`v0.2.0-14-g20a5a52`), mirror tag `v0.2.0-trackai.1`; moves to the first upstream release containing it before the first customer build |
| Licence at the pin | Apache License 2.0 (`LICENSE`) |
| Upstream `NOTICE` | none at the pin (re-check at every monthly sync) |
| Dependency notices | `THIRD_PARTY_LICENSES.txt` at the pin, shipped **in full** because the binary contains those dependencies |
| Rule files | the 51 rule YAML files at the pin, stored by TrackAI's server as data and compiled into override files (Task20f): adapted material |

| What Task20 does | Required handling |
|---|---|
| Ships the Numbat binary in the Endpoint package | Put Numbat's `LICENSE` and `THIRD_PARTY_LICENSES.txt` next to the binary in the package (GitAI `packaging/numbat/`, Task20b) and list Numbat, the pin and the licence in the package's notices |
| Stores and changes Numbat's rule YAML (severity, `enabled`, `enforce`, version suffix) | Keep the Apache-2.0 text with the catalogue data, keep each file's origin (path at the pin), and mark compiled override files "modified by TrackAI" in a comment line |
| Derives contract fixtures from Numbat's schema or test fixtures (Task20a) | Same as above: notice file in the fixtures folder |
| Names Numbat in the product | "Powered by Numbat (Apache-2.0)" only; no Numbat or Perplexity marks as a TrackAI endorsement; TrackAI is never branded as Numbat |
| Changes the pin (monthly sync) | Repeat this record: licence, NOTICE, dependency list, rule-file diff |

This is an engineering compliance plan, not legal advice; the founder or counsel confirms it before the first customer build.
