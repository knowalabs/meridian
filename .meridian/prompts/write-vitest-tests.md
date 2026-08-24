# Write Tests for Meridian in This Project's Vitest Style

Write tests for `<module/function under test>` in `@sonalsithara/meridian`, following the exact conventions already established in `tests/*.test.ts` — do not introduce a different testing pattern or library.

**Placement and structure**

- One file per module area, matching the existing set (`tests/analyzer.test.ts`, `tests/commands.test.ts`, `tests/generate.test.ts`, `tests/router.test.ts`, `tests/router-network.test.ts`, `tests/vault.test.ts`, etc.) — put new tests in the matching file, or create a new `tests/<area>.test.ts` if none fits.
- Use `describe`/`it` from `vitest`, matching the phrasing style already in the target file (e.g. `describe('isAllowedPath')`, `it('rejects escapes, absolute paths and unrelated locations')`).
- E2E tests belong in `tests/e2e/` under `vitest.e2e.config.ts`, not the unit config — only use this if the behavior genuinely requires the built CLI (`pretest:e2e` runs `npm run build` first).

**Test seams, not mocking libraries**

- For network calls in `src/providers/router.ts`, use `setFetchForTests(impl | null)` — return a `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`, and restore with `setFetchForTests(null)` in `afterEach`.
- For subprocess calls (CLI-backed providers, `src/core/exec.ts` consumers), use `setRunForTests(impl | null)` the same way.
- For retry/timeout logic, use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(ms)` to drive it deterministically — never a real `setTimeout` delay or real network call. Call `vi.useRealTimers()` in `afterEach`.

**Isolation**

- Set `process.env.MERIDIAN_HOME` to a `fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-<area>-'))` temp dir in `beforeEach`, and `process.env.MERIDIAN_VAULT = 'file'` when vault/config state is involved — never touch the real OS keychain or a developer's real `~/.meridian`.
- Clean up in `afterEach` with `fs.rmSync(dir, { recursive: true, force: true })` and `delete process.env.MERIDIAN_HOME` (and any other env vars you set).
- For `meridian generate` pipeline tests, build a throwaway target project directory (see `makeProject()` in `tests/generate.test.ts`: writes a minimal `package.json`, `src/index.ts`, `README.md`) rather than pointing tests at this repo itself.

**Assertions**

- Prefer asserting on the real shape of results — e.g. `result.files.filter(f => f.action === 'written').map(f => f.file)` for generate pipeline results, `isAllowedPath(f.file, kind.allowedPaths)` for path safety, `(err as CliError).hint` for error messaging — over loose snapshot-style checks.
- For `CliError` cases, assert both `.message` (what happened) and `.hint` (the actionable next step), matching the pattern in `tests/router-network.test.ts` (e.g. `expect((err as CliError).hint).toContain('meridian auth anthropic')`).
- `tests/**/*.ts` has relaxed unsafe-* ESLint rules (`no-unsafe-assignment`/`no-unsafe-member-access`/`no-unsafe-argument`/`no-unsafe-return`/`require-await` are off) since tests assert on parsed JSON constantly — you don't need defensive casts there, but `src/**` stays fully strict.

**Coverage**

- Check `npm run test:coverage` afterward — thresholds are 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` (those are exercised by humans/e2e, not unit tests; don't try to cover them here).

Here's the code to test: <paste the function/module>.
