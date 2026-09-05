This documents Meridian's own real conventions — naming, file organization, imports, typing, error handling and tooling — each proven against a specific file in this repository. Read it before writing new TypeScript here. For which module owns which concern, see [architecture.md](architecture.md).

## Naming

- Files are kebab-case grouped by concern: `core/vault.ts`, `generate/pipeline.ts`, `scan/analyzer.ts`, `rules/generators.ts`.
- Functions and methods are camelCase (`openVault`, `buildDigest`, `dependencyWaves`); types and interfaces are PascalCase (`ProjectAnalysis`, `ArtifactKind`, `KitManifest`).
- Module-level constants that are effectively fixed configuration are SCREAMING_SNAKE_CASE: `ARTIFACT_KINDS`, `DEFAULT_RIGOR`, `MANIFEST_FILE` (`src/generate/manifest.ts`), `MODEL_PRICING` (`src/providers/router.ts`).
- The test-seam convention for module-level state that needs mocking is a `setXForTests(value | null)` function that restores the real implementation on `null` — `setFetchForTests`, `setRunForTests`, `setRetryDelayForTests` (`src/providers/router.ts`), `setGitForTests` (`src/scan/git.ts`), `setToolDetectionForTests` (`src/plugins/tools.ts`). Don't invent a different mocking mechanism.

## File organization

- `src/commands/*` are thin: parse/validate flags, delegate to `core`/`generate`/`providers`, format output. Business logic does not live here — see `generateCommand` in `src/commands/generate.ts` delegating straight to `runGenerate`/`estimateGenerate` in `src/generate/pipeline.ts`.
- `src/core/*` holds cross-cutting infrastructure with no knowledge of "artifacts" or "providers" as concepts (`config.ts`, `errors.ts`, `exec.ts`, `fsx.ts`, `vault.ts`).
- `src/scan/*` is read-only analysis of the target project; nothing here writes to disk.
- `src/generate/*` is the one pipeline that both reads the target project and writes to it, behind the `isAllowedPath` gate.

## Imports

- TypeScript source uses explicit `.js` extensions for relative imports because `tsconfig.json` sets `"moduleResolution": "NodeNext"` — see `import './core/colorflag.js'` in `src/index.ts` and `from './core/paths.js'` in `src/cli.ts`. Omitting the extension is a build error, not a style nit.

## Typing

- `tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames` — never add code that needs any of these relaxed.
- `eslint.config.js` makes `@typescript-eslint/no-explicit-any` an error for `src/**/*.ts`; only `tests/**/*.ts` turns off the unsafe-* family (`no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-argument`, `no-unsafe-return`, `require-await`) because tests assert on parsed JSON constantly.
- `no-floating-promises` and `no-misused-promises` are errors — every `Promise` is awaited or explicitly handled (see the `done()` wrapper pattern in `src/cli.ts` around every async action).
- Unused function arguments are only allowed with a leading underscore (`argsIgnorePattern: '^_'`).

## Error handling

- Expected, user-facing failures are raised as `new CliError(message, { hint, exitCode, cause })` (`src/core/errors.ts`) — never a bare `throw` or `console.error`. See `src/providers/router.ts`'s `classifyStatus` mapping HTTP 401/403 to `CliError` with a `meridian auth <provider>` hint, and 404 to a hint about overriding the model.
- Anything else that escapes to `src/index.ts`'s `uncaughtException`/`unhandledRejection` handlers is rendered by `renderError` as an unexpected bug with a "re-run with --verbose" hint — that path is not a substitute for classifying a known failure as a `CliError`.
- A run that dies partway keeps every file it already wrote and produces nothing for the kinds that failed (`src/generate/pipeline.ts`'s `GenerateResult.failed`), so a re-run picks up where it left off rather than needing a rollback.

## Formatting and lint tooling

- Formatting: `prettier --write .` (the `format` script); CI enforces it with `npx prettier --check .` (`.github/workflows/ci.yml`) — drift fails the build, it is never auto-fixed in CI.
- Linting: `eslint.config.js` is a flat config built on `typescript-eslint`'s `recommendedTypeChecked` with `projectService: true`, plus `eslint-config-prettier` to disable stylistic rules prettier already owns. Run with `npm run lint` (`eslint src tests`).

## Comments

- Comments explain the _why_, never the _what_ — see the comment above `rawPost` in `src/providers/router.ts` on why a timeout is never retried, and the one above `cosmetic()` in `src/generate/manifest.ts` on why manifest signatures ignore formatter-only diffs. Match this style: if removing a comment wouldn't confuse a future reader, don't write it.

What this doc does not cover: which module owns a given concern (see [architecture.md](architecture.md)) or the verification chain a change must pass (see [engineer-workflow.md](engineer-workflow.md)).

## Related

- [architecture.md](architecture.md) — module boundaries these conventions apply inside.
- [engineer-workflow.md](engineer-workflow.md) — the lint/format/test commands that enforce this doc.
