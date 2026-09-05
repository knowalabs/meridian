# Debugging a failing or hanging `meridian` command

## When to use
A `meridian` invocation throws, exits with an unexpected code, hangs, or a stored key/config becomes unreadable — reproduce it and find the root cause before proposing a fix.

## Context
- `src/index.ts` is the process entrypoint: it checks Node ≥ 18, installs `uncaughtException`/`unhandledRejection`/`SIGINT` handlers that all funnel into `renderError` (`src/core/errors.ts`), and dispatches to `buildCli().parseAsync()` (`src/cli.ts`) or the interactive launcher (`src/launcher.ts`) for a bare invocation in a TTY.
- Expected failures are raised as `new CliError(message, { hint, exitCode, cause })` (`src/core/errors.ts`); anything else that escapes to the top level is rendered by `renderError` as a bug with a "re-run with --verbose" hint — that distinction tells you whether you're chasing a known failure mode or an actual defect.
- `EXIT` codes (`src/core/errors.ts`): `OK=0`, `ERROR=1`, `USAGE=2`, `UNAVAILABLE=69`, `SIGINT=130`.
- `src/providers/router.ts`'s `post`/`rawPost` distinguish a timeout (never retried — mapped straight to a `CliError` with a "check your connection or try --provider" hint) from a retryable transient failure (`RETRYABLE_STATUS`: 408/425/429/500/502/503/504, up to `MAX_ATTEMPTS=3` with backoff via `classifyStatus`). A stuck AI call is almost always one of these two paths, not a hang in Meridian's own code.
- `src/core/vault.ts`'s `openVault()` picks a backend per platform (`KeychainVault` on macOS, `SecretToolVault` on Linux, `FileVault`+`DpapiProtector` on Windows, `FileVault` fallback elsewhere); a corrupted vault throws a `CliError` pointing at `meridian keys repair`, which calls `repairVault()` to back up and reinitialize `vault.enc`/`.master`/`index.json`.
- `src/core/config.ts`'s `loadConfig` runs a malformed `~/.meridian/config.json` through `coerceConfig` and falls back to defaults, backing up the bad file — a config-related failure is more likely in code that reads `loadConfig()` output without expecting a default than in `loadConfig` itself.
- Reproduce deterministically with the project's own test seams instead of hitting a real network or CLI binary: `setFetchForTests` (HTTP providers), `setRunForTests` (CLI-backed providers and `exec.ts`), `setGitForTests`, `setToolDetectionForTests`, `setRetryDelayForTests` — all `null`-restorable, all in `src/providers/router.ts`/`src/scan/git.ts`/`src/plugins/tools.ts`.

## Task
1. Reproduce the failure with `--verbose` first — it prints the stack and the full `cause` chain via `renderError`, which usually tells you immediately whether you're in `router.ts`, `vault.ts`, `config.ts`, or elsewhere.
2. Identify which module owns the failing code per Meridian's module boundaries (see `.meridian/rules.md`'s Architecture section) before editing anything — do not patch a symptom in a caller when the defect is in the owning module.
3. If it involves a provider call, check whether the response status is in `RETRYABLE_STATUS` or a timeout — this tells you whether "it just needs to retry more" is even a valid fix.
4. Write a minimal reproduction as a test using the matching seam (`setFetchForTests`/`setRunForTests`/etc.) rather than describing the bug in prose only.
5. Propose the smallest correct fix; if it touches `src/core/vault.ts` or `src/generate/artifacts.ts`, say explicitly that it needs the CODEOWNERS sign-off before merging.
6. Do not bundle the fix with unrelated cleanup. If you notice an unrelated defect, report it (`file:line`, what breaks, smallest fix) instead of touching it.
7. Verify with `npx vitest run <path-to-test-file>` for the touched test, then the full chain (`npm run lint` → `npx prettier --check .` → `npm run build` → `npm run test:coverage` → `npm run test:e2e`) before calling it fixed.

## Output
Root cause (module + function), the failing behavior explained in terms of the actual code path, the minimal fix, and the new/updated test that fails before the fix and passes after.

```
PASTE THE COMMAND YOU RAN, THE FULL OUTPUT/STACK TRACE (WITH --verbose), AND WHAT YOU EXPECTED INSTEAD
```
