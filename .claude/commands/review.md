---
description: Review the current diff for correctness and convention issues, read-only.
argument-hint: [path to scope the review to, optional]
allowed-tools: Read, Grep, Glob, Bash
---

## Context

- `git diff` (`--staged` if the change is staged) for the diff under review — the whole diff when `$ARGUMENTS` is empty, or scoped to `$ARGUMENTS` when given.
- `.meridian/rules.md`, `docs/conventions.md` and `docs/architecture.md`, for the standard the diff is held to.

## Task

1. Run `git status` and `git diff` (add `--staged` if needed) to see everything in scope.
2. For each changed file, read enough surrounding code to judge it against the module it sits in — its error handling, naming, and test-seam pattern per `.meridian/rules.md`'s Code Style section.
3. Check the risks this project specifically flags: a bare `throw`/`console.error` instead of `CliError` (`src/core/errors.ts`), a write path that could bypass `isAllowedPath` (`src/generate/artifacts.ts`), a secret touching argv/logs/plaintext instead of `openVault()` (`src/core/vault.ts`), or any change to a CODEOWNERS-flagged file without a sign-off note.
4. Check whether a changed `src/**/*.ts` file has a matching change in `tests/*.test.ts` (or `tests/e2e/**` for CLI wiring).

## Report

- Findings as `file:line — issue`, most severe first. State "no findings" explicitly if the diff is clean.

## Constraints

- Read-only: make no edits, run no fixes, and do not stage or commit anything.
