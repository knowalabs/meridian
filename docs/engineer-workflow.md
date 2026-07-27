# Engineer workflow

Day-one setup, the real npm scripts, the exact ordered verification CI runs, and the release/publish process for `@sonalsithara/devpilot`. Read this before your first commit, or whenever you forget which command to run next. Not covered: how to use `devpilot` once installed globally — that's the README; this is about developing DevPilot itself.

## Day one

1. Clone the repo and install: `npm install` (Node `>=18` required — enforced at runtime by `src/index.ts`'s version check, and matrix-tested in CI on 18/20/22).
2. Run `npm run dev -- <command>` (`tsx src/index.ts`) to exercise the CLI without building — e.g. `npm run dev -- doctor`.
3. Tests are sandboxed via `process.env.DEVPILOT_HOME` (temp dir) and `process.env.DEVPILOT_VAULT = 'file'` — they never touch your real OS keychain or `~/.devpilot` (see `tests/doctor.test.ts`, `tests/commands.test.ts`).

## Everyday commands

| Script                  | Command                                                                         | What it does                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | `tsx src/index.ts`                                                              | Run the CLI from source, no build step.                                                                                                                                     |
| `npm run build`         | `tsc -p tsconfig.build.json`                                                    | Type-check and emit to `dist/` (the published artifact — `package.json`'s `bin`/`main`/`exports` point at `dist/`).                                                         |
| `npm run lint`          | `eslint src tests`                                                              | Type-aware lint per `eslint.config.js`.                                                                                                                                     |
| `npm run format`        | `prettier --write .`                                                            | Reformat everything.                                                                                                                                                        |
| `npm test`              | `vitest run`                                                                    | One-shot unit/integration run.                                                                                                                                              |
| `npm run test:watch`    | `vitest`                                                                        | Watch mode.                                                                                                                                                                 |
| `npm run test:coverage` | `vitest run --coverage`                                                         | Coverage-gated run — 70% lines / 60% branches over `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` (`vitest.config.ts`).                                      |
| `npm run test:e2e`      | `pretest:e2e` (`npm run build`) then `vitest run --config vitest.e2e.config.ts` | Spawns the built `dist/index.js` binary per test (`tests/e2e/helpers.ts`'s `runCli`); only run for changes touching `generate`, `cli.ts`, or anything exercised end-to-end. |

## Verification — exact ordered commands before work is done

Mirrors `.github/workflows/ci.yml`'s `test` job step order exactly, so a green local run predicts a green CI run:

1. `npm run lint`
2. `npx prettier --check .`
3. `npm run build`
4. `npm run test:coverage`
5. `npm run test:e2e` — only when the change touches `generate`, `cli.ts`, or another end-to-end-exercised path (this step rebuilds via `pretest:e2e` first, so a stale `dist/` is never tested against).

## CI

`.github/workflows/ci.yml`'s `test` job runs on every push to `main` and every pull request, across a 3×3 matrix (`ubuntu-latest`/`macos-latest`/`windows-latest` × Node `18`/`20`/`22`), each doing `npm ci` then the five steps above (minus the e2e conditionality — CI always runs it).

## Release / publish

A separate `publish` job runs only when the trigger is a `v*` tag (`if: startsWith(github.ref, 'refs/tags/v')`) and only after `test` succeeds (`needs: test`). It re-verifies the tag matches `package.json`'s version (`node -e "... if (v !== process.env.GITHUB_REF_NAME) { ... process.exit(1) }"`) before running `npm ci`, `npm run build`, `npm test`, then `npm publish --provenance` using `NPM_TOKEN` and `id-token: write` for npm provenance. `@changesets/cli` is a dev dependency for changelog/version discipline — `CHANGELOG.md`'s structured per-release "Minor Changes" entries are its output. **Never** run `npm publish`, push a `v*` tag, or modify `NPM_TOKEN`/CI secrets from an assistant session; never touch the publish gating in `ci.yml` without explicit confirmation.

## Related

[conventions.md](conventions.md) for the style these commands enforce, [architecture.md](architecture.md) for what `npm run build` actually emits and why, [roadmap.md](roadmap.md) for what each `CHANGELOG.md` release actually shipped.
