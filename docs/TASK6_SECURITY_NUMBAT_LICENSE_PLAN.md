# Task6 Security Numbat license plan

Status: **Draft for legal/security approval; no upstream code copied**

Last updated: **2026-09-29**

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

Legal/security approval must confirm the proposed notice location and modified-
file wording before any Numbat-derived runtime material enters S6.3. The final
release review must compare the shipped files with this source record.

This is an engineering compliance plan, not legal advice.
