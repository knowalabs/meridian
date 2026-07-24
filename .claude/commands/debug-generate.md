---
description: Debug a devpilot generate run (pipeline, digest, or artifact output)
---

Debug the `devpilot generate` pipeline for this issue: $ARGUMENTS

Trace the actual flow before guessing: `src/commands/generate.ts` → `runGenerate` (`src/generate/pipeline.ts`) → `analyzeProject` (`src/scan/analyzer.ts`, read-only) → `buildDigest` (`src/generate/digest.ts`) → `pickProvider`/`route` (`src/providers/router.ts`) → per-kind `prompt`/`fallback` (`src/generate/artifacts.ts`) → `parseFileBlocks` → `isAllowedPath` → `writeFileAtomic` (`src/core/fsx.ts`) → `rules/generators.ts` propagation.

Useful checks:

- Run `npm run dev -- generate --dry-run` (via `tsx src/index.ts`) to preview without writing, or add `--verbose` for stack traces.
- If a kind's files are missing after a run, check `GenerateResult.failed` — AI failures are fail-closed (`generateKind` writes nothing on error, not a static fallback), so a missing kind usually means the AI call errored, not that the code is broken.
- If files aren't overwritten, check `--force` — by default existing files are `skipped-exists`.
- If an AI response produced no files, suspect the `<<<FILE path>>> …
