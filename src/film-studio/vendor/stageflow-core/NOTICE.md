# Vendored StageFlow core

Source: https://github.com/taruma/stageflow
Upstream commit: `d21fa46a240da040101a7c81e2a5c74e52f7adea` (2026-11-10)
License: MIT, Copyright (c) 2026 Taruma Sakti — see `LICENSE` in this folder.

Vendored verbatim from `src/core/`, except `scoreCatalog.ts`, which is not
included because it imports the Vite-only `?raw` score catalog. `scoreYamlUtils.ts`
is included as-is; its browser download helper is never called from the server code.
`yaml` (^2.7.0) is the only new runtime dependency; it is the same parser the
upstream app uses.

The test fixtures in `test/fixtures/stageflow/` are the upstream `src/scores/*.yaml`
files, also MIT and attributed to the same original.
