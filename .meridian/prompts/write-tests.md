# Write Tests in Meridian's Vitest Style

## When to use

Adding or extending tests for a change to `src/**/*.ts`, or closing a coverage gap flagged by `npm run test:coverage`.

## Context

- Framework: Vitest. Unit/integration tests live in `tests/*.test.ts`, one file per module area (`analyzer`, `commands`, `config`, `doctor`, `errors`, `fsx`, `generate`, `ignore`, `launcher`, `mcp`, `platform`, `plugins`, `prompt`, `router`, `router-network`, `rules`, `sync`, `update-ask`, `vault`, `vault-backends`, `workspaces`) — add new cases to the matching file rather than creating a new one for a small addition.
- E2E tests live in `tests/e2e/` (e.g. `tests/e2e/workflows.test.ts`, `tests/e2e/helpers.ts`), run via `npm run test:e2e` against the _built_ CLI (`pretest:e2e` runs `npm run build` first) — separate config `vitest.e2e.config.ts`, 30s `testTimeout` since each test spawns a subprocess.
- Filesystem/vault sandboxing: set `process.env.MERIDIAN_HOME` to a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-<area>-'))` and `process.env.MERIDIAN_VAULT = 'file'` in `beforeEach`; clean up with `fs.rmSync(dir, { recursive: true, force: true })` in `afterEach`. Never touch the real OS keychain or the developer's real `~/.meridian`.
- Network/subprocess mocking uses the router's test seams, not a mocking library: `setFetchForTests(impl | null)` and `setRunForTests(impl | null)` from `src/providers/router.ts`. Timer-dependent retry/backoff tests use `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(ms)` (see `tests/router-network.test.ts`'s `429` retry and `Retry-After` tests) — never a real `setTimeout` delay or a real network call.
- Any change to `src/generate/artifacts.ts`'s `isAllowedPath`/`parseFileBlocks` must extend the existing `describe('isAllowedPath')` / `describe('parseFileBlocks')` blocks in `tests/generate.test.ts`, not a new ad hoc script. The `describe('static fallbacks')` block asserts every `ArtifactKind.fallback()` output stays inside its own `allowedPaths` — a new artifact kind must pass this automatically.
- Coverage thresholds (`vitest.config.ts`): 70% lines, 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` (human/e2e-exercised by design — do not chase coverage there).
- `--json` output commands (`doctor`, `keys list`, `mcp list/search`, `ask`, `generate`) are asserted by parsing the last `console.log` call — see `lastJson()`/`report()` helpers in `tests/commands.test.ts`/`tests/doctor.test.ts`.
- Commands: `npm test` (`vitest run`), `npm run test:watch` (`vitest`), `npm run test:coverage` (`vitest run --coverage`), `npm run test:e2e`.

## Task

1. Identify the `tests/<area>.test.ts` file that already covers this module; only create a new file if no existing area fits.
2. Set up the sandbox in `beforeEach`/`afterEach` exactly as described above — temp `MERIDIAN_HOME`, `MERIDIAN_VAULT=file`, cleanup — before writing any assertion.
3. For network- or subprocess-dependent code, use `setFetchForTests`/`setRunForTests`; for retry/backoff/timeout behavior, pair it with `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`. Do not add a real network call or a real timer delay.
4. Cover the success path, the documented failure paths (auth failure, rate limit, malformed response, path traversal, etc. — whichever apply), and at least one edge case visible in the surrounding code (e.g. `noUncheckedIndexedAccess`-relevant empty-array or missing-key cases).
5. If the change touches `isAllowedPath` or `parseFileBlocks`, add cases to the existing `describe` blocks in `tests/generate.test.ts` instead of writing a new test file.
6. Run `npm run test:coverage` and confirm the change does not drop line coverage below 70% or branch coverage below 60% for `src/**/*.ts` (excluding `src/launcher.ts`/`src/index.ts`).
7. If the change is exercised end-to-end (touches `generate`, `cli.ts`, or full command flows), add or extend a case in `tests/e2e/workflows.test.ts` and note that `npm run test:e2e` must be run.

## Output

The test file content (new `it`/`describe` blocks or a new file), followed by the exact commands to run to verify it passes and meets coverage.

```
<paste the source change (diff or file) the tests must cover>
```
