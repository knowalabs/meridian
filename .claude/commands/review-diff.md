---
description: Review the current diff against DevPilot's architecture and conventions
---

Review `git diff` (or `git diff $ARGUMENTS` if a base ref/path is given) against this repo's actual conventions — do not give generic feedback.

Check specifically for:

- **Module boundaries**: commands in `src/commands/*.ts` stay thin (parse/validate/call into `core`/`generate`/`providers`/`scan`/return exit code) — no business logic in a Commander `.action()`.
- **No `process.exit()`** anywhere in `src/commands/*` or launcher-reachable code — must use the `done(code)` / `process.exitCode` pattern from `src/cli.ts`.
- **Import order in `src/index.ts`** — `./core/colorflag.js` must stay the first import.
- **`.js` extensions** on all relative imports (NodeNext resolution).
- **`CliError` with a `hint`** for user-facing failures, never a raw `Error` — compare against the pattern in `src/providers/router.ts`'s `post()`.
- **`isAllowedPath` validation** for any new or modified AI-suggested file write in `src/generate/*.ts` — never bypassed.
- **Fail-closed AI generation** — `generateKind` in `src/generate/pipeline.ts` must not write a static fallback after a failed AI call mid-run.
- **New `ArtifactKind` entries** supply both `prompt()` and `fallback()`, and are covered by `tests/generate.test.ts`'s `static fallbacks` test.
- **Test seams**: network/subprocess changes use `setFetchForTests`/`setRunForTests` + `vi.useFakeTimers()`, not real timers or a mocking library.
- **No secrets in argv** — vault backends prefer stdin (`security -i`, `secret-tool`).
- Formatting/lint/type conventions per `eslint.config.js` and `tsconfig.json`.

Report findings as file:line with the concrete rule violated, ordered most-severe first.
