---
description: Trace a devpilot generate/sync failure to its root cause
argument-hint: <symptom or failing command>
allowed-tools: Read, Grep, Glob, Bash
---

## Context

- The pipeline: `src/commands/generate.ts` → `runGenerate` (`src/generate/pipeline.ts`) → `analyzeProject` (`src/scan/analyzer.ts`, read-only) → `buildDigest` (`src/generate/digest.ts`) → `pickProvider`/`route` (`src/providers/router.ts`) → per-kind `prompt`/`fallback` (`src/generate/artifacts.ts`) → `parseFileBlocks` → `isAllowedPath` → `writeFileAtomic` (`src/core/fsx.ts`) → `rules/generators.ts` propagation → `writeManifest` (`src/generate/manifest.ts`)
- `GenerateResult.failed`/`.aborted` (`src/generate/pipeline.ts`) — AI failures are fail-closed: a failed kind writes nothing, it does not silently fall back to a static template

## Task

If `$ARGUMENTS` is empty, reproduce with `npm run dev -- generate --dry-run --verbose` (runs `tsx src/index.ts`) as the baseline; otherwise reproduce the exact symptom or command named in `$ARGUMENTS`, adding `--verbose` for a stack trace and `--json` if the caller consumes structured output.

1. Reproduce the failure with `--verbose`; read the `CliError` message and `hint` — they name which module threw and why.
2. If a kind's files are missing after a run, check `GenerateResult.failed`/`.aborted` before assuming a bug — a missing kind after an AI error is expected, fail-closed behavior, not corruption.
3. If files weren't overwritten, check whether `--force` was passed — existing files are `skipped-exists` by default.
4. If the AI response produced no files, suspect the `<<<FILE path>>> …
