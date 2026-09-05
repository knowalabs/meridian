# Architecture

Covers the module layout of `@knowalabs/meridian`'s own source (`src/`), how control and data flow through the flagship `meridian generate` pipeline, why each runtime dependency exists, and the invariants a change must not break. Read this before moving code between modules or adding a new one. Not covered: the internals of a _target_ project `meridian generate` scans — that's a different concept entirely (see `.meridian/rules.md`'s "General" section).

## Entry points

| File              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`    | Process entry point only: Node-version gate (`>=18`), global `uncaughtException`/`unhandledRejection`/`SIGINT` handlers, dispatch to `launcher.ts` (bare `meridian` in a TTY) or `cli.ts` (`buildCli().parseAsync`). Imports `./core/colorflag.js` first, before `renderError`/`buildCli` — it mutates `NO_COLOR` before `picocolors` (loaded by nearly everything else) reads color support. |
| `src/cli.ts`      | Builds the Commander program (`buildCli`), registers every subcommand and global flags (`--verbose`, `-q/--quiet`, `--json`, `--no-color`) via `addGlobalFlags`, applied recursively to every leaf command.                                                                                                                                                                                   |
| `src/launcher.ts` | Interactive TUI (`runInteractive`, `menuPrompt`, `showBanner`/`showWelcome`). Runs `buildCli({ exitOverride: true }).parseAsync` in-process per selection via `runCommandLine`, catching `CommanderError` so one failing command never kills the menu loop. Excluded from coverage thresholds in `vitest.config.ts` — exercised by humans/e2e, not unit tests.                                |

## Layers

| Layer               | Directory                          | Responsibility                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands            | `src/commands/*.ts`                | Thin adapters: parse/validate CLI input, call into `core`/`generate`/`providers`/`scan`, return an exit code. No business logic, no `process.exit()`.                                                                                                                                                                       |
| Cross-cutting infra | `src/core/`                        | `errors.ts` (`CliError`, `renderError`, `EXIT`), `logger.ts`, `config.ts`, `vault.ts` (multi-backend secrets), `fsx.ts` (`writeFileAtomic`, `backupFile`), `paths.ts`, `exec.ts` (`run`/`runAsync`/`which`), `spinner.ts`, `pkg.ts` (`VERSION`), `prompt.ts`, `validate.ts`, `colorflag.ts`.                                |
| Target-project scan | `src/scan/`                        | `analyzer.ts` (`analyzeProject`, code-map symbol extraction), `ignore.ts` (`createIgnore` — the single ignore authority), `workspaces.ts` (`detectWorkspaces` for npm/yarn/pnpm/Lerna/Cargo/`go.work`). Read-only — must never write files.                                                                                 |
| AI-kit pipeline     | `src/generate/`                    | `digest.ts` (`buildDigest`), `artifacts.ts` (`ARTIFACT_KINDS`, `isAllowedPath`, `parseFileBlocks`, `FORMAT_SPEC`), `pipeline.ts` (`runGenerate`, `generateKind`, `pickProvider`, `estimateGenerate`), `manifest.ts` (`KitManifest`, `fingerprintOf`, `diffFingerprints`, `fileStates`), `cache.ts` (codebase-review cache). |
| Rule propagation    | `src/rules/generators.ts`          | Mirrors `.meridian/rules.md` into every AI tool's native config (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …) via `generateRules`/`RULE_TARGETS`.                                                                                                                                                                              |
| AI routing          | `src/providers/router.ts`          | `PROVIDERS: ProviderSpec[]`, `route()`, `modelFor()`, shared HTTP `post()`/`postStream()` with timeout/retry/backoff (`classifyStatus`, `RETRYABLE_STATUS`).                                                                                                                                                                |
| MCP marketplace     | `src/mcp/` + `src/commands/mcp.ts` | `registry.ts` (`MCP_REGISTRY`, `searchMcp`), `configure.ts` (`addServer`/`removeServer`/`listInstalled` across every detected tool config).                                                                                                                                                                                 |
| Tool plugins        | `src/plugins/tools.ts`             | Per-tool install/detect/doctor (`TOOL_SPECS`, `buildRegistry`) used by `install`/`doctor`/`uninstall`.                                                                                                                                                                                                                      |

## Control/data flow: `meridian generate`

```
src/scan/analyzer.ts     analyzeProject(root, ignore)         → ProjectAnalysis
src/generate/digest.ts   buildDigest(root)                    → ProjectDigest (text + code map + excerpts)
src/providers/router.ts  pickProvider() → ProviderSpec.ask()  → AI response text
src/generate/artifacts.ts parseFileBlocks(response)           → ArtifactFile[]
src/generate/artifacts.ts isAllowedPath(file, kind.allowedPaths) → validated writes only
src/core/fsx.ts          writeFileAtomic(file, content)        → disk
src/rules/generators.ts  generateRules()                       → CLAUDE.md / AGENTS.md / GEMINI.md / …
src/generate/manifest.ts writeManifest()                       → .meridian/manifest.json
```

`meridian sync` (`src/commands/sync.ts`) reuses the same pipeline: `manifest.ts`'s `fileStates`/`diffFingerprints` decide which generated files are stale (`clean`, `edited` — preserved, or `missing` — regenerated) before `runGenerate` is called with `refresh` set to only the untouched files.

## External dependencies and why

| Dependency                                                | Kind        | Why                                                                                                                                                    |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commander`                                               | runtime dep | The entire CLI command tree in `src/cli.ts` (`buildCli`, subcommands, global flags).                                                                   |
| `picocolors`                                              | runtime dep | Every terminal color call across `commands/`, `launcher.ts`, `core/logger.ts` — hence `core/colorflag.ts` must run before it's imported anywhere else. |
| `vitest` + `@vitest/coverage-v8`                          | dev dep     | Unit/integration tests (`tests/*.test.ts`) and coverage gating (`vitest.config.ts`).                                                                   |
| `eslint` + `typescript-eslint` + `eslint-config-prettier` | dev dep     | `npm run lint` (`eslint src tests`), configured in `eslint.config.js`.                                                                                 |
| `prettier`                                                | dev dep     | `npm run format` / CI's `npx prettier --check .`.                                                                                                      |
| `typescript`                                              | dev dep     | `npm run build` (`tsc -p tsconfig.build.json`), strict mode per `tsconfig.json`.                                                                       |
| `tsx`                                                     | dev dep     | `npm run dev` — runs `src/index.ts` directly without a build step.                                                                                     |
| `@changesets/cli`                                         | dev dep     | Version/changelog discipline behind `CHANGELOG.md`'s structured "Minor Changes" entries.                                                               |

## Invariants a change must not break

- **Fail-closed AI generation** — `generateKind` in `src/generate/pipeline.ts` writes nothing for a kind whose AI response is incomplete after one retry; it must never silently fall back to the static template mid-run.
- **`isAllowedPath` is the only path gate** — any AI-suggested or dynamically constructed file path must pass through it before a write; it blocks absolute paths, Windows drive letters and `..` traversal.
- **No `process.exit()` in `src/commands/*` or anything reachable from `src/launcher.ts`** — actions return an exit code via the `done()` closure in `src/cli.ts`; a raw exit would kill the whole in-process TUI session.
- **`src/index.ts`'s `colorflag.js` import stays first** — reordering silently breaks `--no-color`/`NO_COLOR`.
- **`src/scan/analyzer.ts` never writes** — only `src/generate/` and `src/rules/generators.ts` write generated output to the target project.
- **Windows DPAPI (`DpapiProtector` in `src/core/vault.ts`) never receives secrets via argv** — base64 travels over PowerShell stdin.

## Related

[conventions.md](conventions.md) for how code in these modules should look, [security.md](security.md) for the vault/`isAllowedPath` detail behind the invariants above, [engineer-workflow.md](engineer-workflow.md) for the commands that verify a change respects them.
