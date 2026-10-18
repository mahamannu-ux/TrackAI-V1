# Numbat rule catalogue: notice

The YAML files in this folder are copied unchanged from **Numbat**
(https://github.com/perplexityai/numbat), commit `20a5a52bab41c9bf6ee857efd43c7b198b055de5`
(TrackAI mirror tag `v0.2.0-trackai.1`), `rules/<group>/<file>.yaml`.

Numbat is licensed under the Apache License, Version 2.0. A copy of the licence is at
https://www.apache.org/licenses/LICENSE-2.0 and ships with the TrackAI Endpoint package
(`docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md`).

Rule files that TrackAI compiles into a tenant's rule bundle are **modified by TrackAI**:
the compiler (`../../compiler.ts`) adds a first comment line naming the source file and
changes only the top-level `enabled`, `severity` and `version` values. The files here
are the unmodified originals; `manifest.json` records each file's SHA-256.
