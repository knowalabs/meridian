Day-one setup, the real npm scripts, the exact verification order, and the release process for the Meridian CLI itself. Read this before your first change and before every "done" claim. For what each module is responsible for, see [architecture.md](architecture.md).

## Day-one setup

```bash
npm install
npm run dev          # tsx src/index.ts — run the CLI without building
```

This is a single-package npm project with no workspace — every command below runs from the repo root using the scripts in `package.json` (per `.meridian/rules.md`'s General section). Node 18, 20 and 22 are all exercised in CI (`.github/workflows/ci.yml`); local development can use any of them.

## Everyday commands

| Script           | Command                                    | What it does                                                                                                                                               |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`          | `tsc -p tsconfig.build.json`               | Compiles `src/` to `dist/` for the published package and for e2e tests.                                                                                    |
| `dev`            | `tsx src/index.ts`                         | Runs the CLI directly from TypeScript source, no build step.                                                                                               |
| `lint`           | `eslint src tests`                         | Type-aware ESLint over both `src/` and `tests/`.                                                                                                           |
| `format`         | `prettier --write .`                       | Rewrites formatting in place.                                                                                                                              |
| `test`           | `vitest run`                               | Unit tests in `tests/*.test.ts` (excludes `tests/e2e/**` per `vitest.config.ts`).                                                                          |
| `test:watch`     | `vitest`                                   | Same suite, watch mode.                                                                                                                                    |
| `test:coverage`  | `vitest run --coverage`                    | Unit tests with the v8 coverage gate (70% lines / 60% branches on `src/**/*.ts`, excluding `src/launcher.ts` and `src/index.ts` — see `vitest.config.ts`). |
| `test:e2e`       | `vitest run --config vitest.e2e.config.ts` | Spawns the _built_ CLI as a subprocess (30s timeout per test, `vitest.e2e.config.ts`).                                                                     |
| `pretest:e2e`    | `npm run build`                            | Runs automatically before `test:e2e` — never assume `dist/` is current otherwise.                                                                          |
| `prepublishOnly` | `npm run build`                            | Runs automatically before `npm publish`.                                                                                                                   |

## Verification — the exact order

There is one meaningful verification chain, matching `.github/workflows/ci.yml`'s `test` job:

```bash
npm run lint
npx prettier --check .
npm run build
npm run test:coverage
npm run test:e2e
```

While iterating on a single file, run the smaller pair instead of the full chain: `npm run lint` plus `npx vitest run <path-to-test-file>`. Run the full chain above once before calling a change done — do not hand-run `npm run build` immediately before `npm run test:e2e` and assume it makes the `pretest:e2e` hook redundant; a stale `dist/` from a previously _failed_ build is exactly how this chain lies to you.

## Release process

CI (`.github/workflows/ci.yml`) has two jobs:

1. **`test`** — the matrix above (`ubuntu-latest`/`macos-latest`/`windows-latest` × Node 18/20/22), runs on every push to `main` and every pull request.
2. **`publish`** — runs only when `test` passes and the ref is a tag matching `v*`. It:
   - Verifies the tag name matches `package.json`'s version (`v${package.json.version}` must equal `GITHUB_REF_NAME`) — a mismatched tag fails the job before anything is published.
   - Runs `npm ci`, `npm run build`, `npm test`.
   - Publishes with `npm publish --provenance`, using `NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret and `id-token: write` permission for npm provenance attestation.

Changelog entries are drafted with `@changesets/cli` (a dev dependency) into pending changesets, then rolled into `CHANGELOG.md` at release time — see the structured `## 0.1.1` / `## 0.1.0` entries in `CHANGELOG.md` for the expected format (what changed and why, not a raw diff).

This workflow does not cover: publishing without a matching git tag (the job simply won't run), or a rollback procedure for a bad publish (none is defined in `ci.yml` today).

## Related

- [architecture.md](architecture.md) — what each command's underlying module actually does.
- [conventions.md](conventions.md) — the style these commands enforce.
- [engineering-standards.md](engineering-standards.md) — where this verification chain falls short of the stack's professional bar and the adoption steps to close it.
