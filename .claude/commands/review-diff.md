---
description: Review the working diff against DevPilot's module boundaries and conventions
argument-hint: [base-ref]
allowed-tools: Read, Grep, Glob, Bash
---

## Context

- `git diff` (staged + unstaged against `HEAD`) when `$ARGUMENTS` is empty, or `git diff $ARGUMENTS` when a base ref/path is given
- `.devpilot/rules.md` and `CLAUDE.md` — canonical rules for this repo
- `src/cli.ts`'s `done(code)` pattern, `src/generate/artifacts.ts`'s `isAllowedPath`, `src/providers/router.ts`'s `CliError` + `hint` pattern

## Task

Check the diff against these repo-specific rules, not generic style advice:

1. **Module boundaries** — `src/commands/*.ts` stay thin: parse/validate, call into `core`/`generate`/`providers`/`scan`, return an exit code. No business logic inside a Commander `.action()` callback.
2. **No `process.exit()`** in `src/commands/*` or anything reachable from `src/launcher.ts` — must use the `done(code)` / `process.exitCode` pattern.
3. **`src/index.ts` import order** — `./core/colorflag.js` stays the first import, before anything that pulls in `picocolors`.
4. **`.js` extensions** on every relative import (NodeNext resolution).
5. **`CliError` with a `hint`** for user-facing failures, never a raw `Error` — compare against `classifyStatus` in `src/providers/router.ts`.
6. **`isAllowedPath`** guards any new or changed AI-suggested file write in `src/generate/*.ts` — never bypassed.
7. **Fail-closed AI generation** — `generateKind` in `src/generate/pipeline.ts` must not write a static fallback after a failed AI call mid-run.
8. Any new `ArtifactKind` supplies both `prompt()` and `fallback()`, covered in `tests/generate.test.ts`'s `static fallbacks` test.
9. **Test seams** — network/subprocess behavior changes use `setFetchForTests`/`setRunForTests` + `vi.useFakeTimers()`, never a mocking library or real delays.
10. **Secrets never in argv** — vault backends prefer stdin (`security -i`, `secret-tool`).

## Report

Findings as `file:line`, each naming the concrete rule violated, most severe first. If nothing violates a repo rule, say so — do not invent generic feedback.

## Constraints

Read-only: do not edit files or run anything beyond inspection (`git diff`, `git log`, `git show`). Never run a destructive git command.
