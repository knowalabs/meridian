# Writing Vitest tests in Meridian's style

## When to use
Adding or updating a test for a `src/**/*.ts` change — deciding whether it belongs in the unit suite or the e2e suite, and matching the project's existing fixture and mocking conventions.

## Context
- Unit tests live in `tests/*.test.ts` and run via `vitest.config.ts`, which includes `tests/**/*.test.ts` and excludes `tests/e2e/**`. Run one file while iterating with `npx vitest run <path-to-test-file>`, the whole suite with `npm run test:watch` or `npm test`.
- `npm run test:coverage` (v8 provider) enforces 70% lines / 60% branches on `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` — the interactive TUI and process entrypoint, which are exercised by e2e tests and humans instead.
- e2e tests live in `tests/e2e/*.test.ts`, run via `npm run test:e2e` against `vitest.e2e.config.ts` (30s `testTimeout` per test — each one spawns the *built* CLI as a subprocess through `tests/e2e/helpers.ts`'s `runCli`/`makeSandbox`/`CLI_PATH`). Its `pretest:e2e` hook runs `npm run build` first — never assume `dist/` is current for any other command.
- Any change to `src/generate/*` or `src/providers/router.ts` needs a unit test using the matching test seam, never a real network call or a real CLI binary: `setFetchForTests` for HTTP providers (see `tests/router-network.test.ts`), `setRunForTests` for CLI-backed providers like `claude-code`/`codex-cli`/`gemini-cli` (see the "claude-code CLI provider" suite in the same file), `setGitForTests` (`tests/git.test.ts`), `setToolDetectionForTests` (`tests/sync.test.ts`), `setRetryDelayForTests` to shrink backoff instead of sitting through real seconds of sleep (`tests/sync.test.ts`, `tests/router-network.test.ts`).
- Any change to CLI wiring (`src/cli.ts`, `src/launcher.ts`) or end-to-end file-writing behavior needs a `tests/e2e` addition, since coverage does not measure those two files.
- Fixture style: build throwaway projects with `fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-<x>-'))` and clean up with `fs.rmSync(root, { recursive: true, force: true })` in `afterEach` — see `makeProject()` in `tests/generate.test.ts` and `tests/sync.test.ts`.
- ESLint relaxes the `unsafe-*` family (`no-unsafe-assignment`/`-member-access`/`-argument`/`-return`) and `require-await` in `tests/**/*.ts` only, because tests assert on parsed JSON output constantly — source stays fully strict.

## Task
1. Decide unit vs. e2e first: does the behavior depend on the CLI actually being spawned as a subprocess, or on real end-to-end file writes with no mocking possible? If not, it's a unit test.
2. For a unit test touching a provider or generation path, wire the matching `setXForTests` seam and restore it with `null` in `afterEach` — never leave a seam engaged across tests.
3. Follow the sandbox fixture pattern exactly: `mkdtempSync` in `beforeEach`, cleanup in `afterEach`, real files written with `fs.writeFileSync`/`fs.mkdirSync` against that sandbox root — never against the real repo.
4. For an e2e addition, extend an existing `describe` block in `tests/e2e/workflows.test.ts` or `tests/e2e/smoke.test.ts` if the command area already has one, using `makeSandbox()`/`runCli()` from `tests/e2e/helpers.ts`.
5. Assert on the actual contract: exit code, `--json` output shape, and files written/preserved on disk — not on implementation details of how the code got there.
6. Run `npx vitest run <path-to-test-file>` while iterating; run `npm run test:coverage` and (if e2e was touched) `npm run test:e2e` before calling it done.
7. If the change pushes `src/**/*.ts` coverage below 70% lines / 60% branches outside `src/launcher.ts`/`src/index.ts`, add coverage rather than lowering the threshold.

## Output
The new/updated test file content, which suite it belongs to and why, and the exact command used to verify it (plus its result).

```
NAME THE SOURCE FILE/FUNCTION UNDER TEST AND THE BEHAVIOR TO COVER
```
