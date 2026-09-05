---
description: Clean up only the files the current session changed, behavior-preserving.
---

## Context

- This conversation, for which files the current session actually created or edited.
- `git status` and `git diff --name-only`, to get the authoritative list of changed files — scope is their intersection with what the session touched, never the whole repo.
- `.meridian/rules.md` and `docs/conventions.md`, for the standard to audit against.

## Task

1. List the files this session changed by cross-referencing the conversation with `git diff --name-only` (and `git status` for new files); anything outside that intersection is out of scope.
2. In only those files, look for: leftover debug output (a stray `console.log`/extra `log.info` not present before this session), dead code, logic duplicated from a helper this project already has (e.g. reimplementing `CliError`, `writeFileAtomic`, `isAllowedPath`, or `openVault()` instead of calling it), a hardcoded value that belongs in `~/.meridian/config.json` or the vault, stale generated output the manifest should own instead, and a `src/**/*.ts` change with no matching addition in `tests/*.test.ts`.
3. Make behavior-preserving edits only — same inputs, same outputs, same exit codes and error messages.
4. Re-run the tests covering the touched files (`npx vitest run <path>`) to confirm nothing changed behavior.

## Report

- Each smell found, its `file:line`, and the fix applied — or state the scope was already clean.
- Anything noticed but left alone because fixing it would stop being behavior-preserving.

## Constraints

- Touch no file outside this session's own changes — this is not a repo-wide sweep.
- Never edit documentation here unless this session's change made it factually wrong; if so, name the doc file and the edit explicitly in the report.
- Never commit; stop once the edits are made.
