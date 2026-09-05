---
name: handle-errors
description: Use when adding or changing error handling, validation, or anything that turns an internal failure into user-facing output — how this project fails and what its public surface may expose.
---

# Handle errors

## When to use

Use when writing code that can fail — a new command action, a provider call, a file write — or when deciding what a caught error should say to the user. Not for fixing a specific reported bug (that's `refactor`'s "report before you fix" step); this is the standing contract for how failure is represented.

## Before you start

- @.meridian/rules.md — Safety section on secrets/vault/CODEOWNERS.
- `src/core/errors.ts` — the only error type this project has: `CliError`, `EXIT` codes, `renderError`.
- `src/providers/router.ts`'s `classifyStatus`/`post`/`rawPost` — where most `CliError`s are actually constructed.
- `src/index.ts` — the top-level boundary that renders whatever escapes.

## Steps

1. Raise expected, user-facing failures as `new CliError(message, { hint, exitCode, cause })` (`src/core/errors.ts`) — never a bare `throw` or `console.error`. This is the project's only shared error type; there is no result wrapper or exception hierarchy beyond it.
2. Decide where the `CliError` surfaces. A command action (e.g. `generateCommand`, `syncCommand`) that hits an expected, recoverable problem (bad flag, missing manifest) calls `log.fail(...)` and returns a non-zero exit code directly — it does not throw. A `CliError` is thrown when the failure should carry a `hint` and be rendered uniformly at the process boundary (`src/index.ts`'s `uncaughtException`/`unhandledRejection` handlers, or `src/launcher.ts`'s `runCommandLine`), e.g. auth failures, timeouts and rate limits from `classifyStatus`.
3. Give every `CliError` a `hint`: the concrete next command or check (`meridian auth <provider>`, `ollama serve`, `meridian keys repair`). A message without an actionable hint is incomplete — see every existing `CliError` construction in `router.ts` and `vault.ts` for the pattern.
4. Validate at this project's actual boundaries, not internally: CLI flag parsing in `src/commands/generate.ts` (`--rigor`, `--tools`, `--concurrency`), config read from disk (`coerceConfig` in `src/core/validate.ts`), and — because this project treats AI output as untrusted input — `isAllowedPath` (`src/generate/artifacts.ts`) and `validateArtifacts`/`claimedScripts`/`claimedPaths` (`src/generate/validate.ts`) for anything an AI provider returns.
5. Never let a secret, key, raw stack trace, or upstream response body escape into a message. `renderError` only prints a stack/cause chain under `--verbose`; a `CliError` message stays a classified, human sentence (see `classifyStatus`'s 401/403/5xx handling, which never echoes the raw response body).
6. Treat `src/cli.ts`'s exported `buildCli`/`CliOptions`/`VERSION`, the command tree (names, flags), and every `--json` output shape as this project's public API (per `package.json`'s `exports`/`main`/`types`/`bin`). Adding a command, flag, or JSON field is additive. Renaming or removing one, or changing an exit code's meaning, is breaking — update every caller (`tests/commands.test.ts`, `tests/e2e/*`, and README.md's commands table) in the same change.

## Verification

- `npx vitest run tests/errors.test.ts` — the error-rendering contract.
- `npx vitest run <the test file for whatever you changed>` — confirm the new failure path is exercised, not just the happy path.
- `npm run lint` — `no-floating-promises`/`no-misused-promises` catch a swallowed rejection.

## Done when

- [ ] Every new failure path raises `CliError` or returns a command exit code — no bare `throw`/`console.error`.
- [ ] Every `CliError` has a `hint` naming a real command.
- [ ] No secret, stack trace (outside `--verbose`), or raw response body appears in a message.
- [ ] Any public-surface change updated its callers (tests + README.md) in the same change.

## Never

- Never swallow an error silently — an empty catch block hides exactly the failure `doctor`/`renderError` exist to surface.
- Never put a secret or token in a `CliError` message, log line, or argv.
- Never bypass `isAllowedPath` or `validateArtifacts` for AI-returned content.
- Never rename or remove a command/flag/JSON field without updating its test and README.md callers.
